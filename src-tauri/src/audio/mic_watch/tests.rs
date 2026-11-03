//! The watcher without devices: snapshots by hand, a recording host, and
//! the app's host on the mock runtime.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use super::{state::RELEASE_DELAY_MS, *};

#[derive(Default)]
struct Record {
    events: Mutex<Vec<MicActivityChanged>>,
    widgets: Mutex<Vec<String>>,
    onboarding_completed: AtomicBool,
    behavior: Mutex<Option<MicBusyBehavior>>,
}

struct FakeHost(Arc<Record>);

impl MicHost for FakeHost {
    fn emit(&self, event: &MicActivityChanged) {
        self.0.events.lock().unwrap().push(event.clone());
    }

    fn widget_settings(&self) -> WidgetSettings {
        WidgetSettings {
            onboarding_completed: self.0.onboarding_completed.load(Ordering::SeqCst),
            behavior: self
                .0
                .behavior
                .lock()
                .unwrap()
                .unwrap_or(MicBusyBehavior::Widget),
        }
    }

    fn show_widget(&self, app: &str) {
        self.0.widgets.lock().unwrap().push(app.to_owned());
    }
}

fn fixture() -> (MicWatch, Arc<Record>) {
    let record = Arc::new(Record::default());
    record.onboarding_completed.store(true, Ordering::SeqCst);
    (MicWatch::new(FakeHost(Arc::clone(&record))), record)
}

fn holder(pid: u32, app: &str) -> Holder {
    Holder {
        pid,
        app: app.to_owned(),
    }
}

fn zoom() -> Holder {
    holder(200, "zoom.us")
}

fn busy(app: &str, since: i64) -> MicActivityChanged {
    MicActivityChanged {
        busy: true,
        app: Some(app.to_owned()),
        since,
    }
}

#[test]
fn every_change_is_sent_and_the_current_state_follows_it() {
    let (watch, record) = fixture();
    assert!(!watch.current().busy);
    assert_eq!(watch.current().app, None);

    watch.observe(&[zoom()], 1_000);
    watch.observe(&[zoom()], 1_500);
    watch.observe(&[holder(300, "Google Chrome")], 2_000);
    watch.observe(&[], 3_000);
    watch.tick(3_000 + RELEASE_DELAY_MS - 1);
    assert!(watch.current().busy, "busy during the delay");
    watch.tick(3_000 + RELEASE_DELAY_MS);

    let free = MicActivityChanged {
        busy: false,
        app: Some("Google Chrome".to_owned()),
        since: 3_000,
    };
    assert_eq!(
        *record.events.lock().unwrap(),
        vec![
            busy("zoom.us", 1_000),
            busy("Google Chrome", 1_000),
            free.clone()
        ]
    );
    assert_eq!(watch.current(), free);
}

#[test]
fn the_apps_own_pid_is_never_busy() {
    let (watch, record) = fixture();
    watch.observe(&[holder(std::process::id(), "Grill")], 1_000);
    assert!(record.events.lock().unwrap().is_empty());
    assert!(!watch.current().busy);
}

#[test]
fn the_widget_shows_once_per_busy_period() {
    let (watch, record) = fixture();
    watch.observe(&[zoom()], 1_000);
    // The user hid it; the call goes on, restarts its stream, another app
    // joins: no second widget.
    watch.observe(&[], 2_000);
    watch.observe(&[zoom(), holder(300, "Google Chrome")], 3_000);
    watch.observe(&[holder(300, "Google Chrome")], 4_000);
    assert_eq!(*record.widgets.lock().unwrap(), vec!["zoom.us"]);

    // Free, then busy again: a new period, a new widget.
    watch.observe(&[], 5_000);
    watch.tick(5_000 + RELEASE_DELAY_MS);
    watch.observe(&[zoom()], 20_000);
    assert_eq!(*record.widgets.lock().unwrap(), vec!["zoom.us", "zoom.us"]);
}

#[test]
fn the_widget_waits_for_onboarding_and_respects_the_setting() {
    let (watch, record) = fixture();
    record.onboarding_completed.store(false, Ordering::SeqCst);
    watch.observe(&[zoom()], 1_000);
    assert!(record.widgets.lock().unwrap().is_empty());
    assert_eq!(
        record.events.lock().unwrap().len(),
        1,
        "the event still goes out"
    );

    let (watch, record) = fixture();
    *record.behavior.lock().unwrap() = Some(MicBusyBehavior::Nothing);
    watch.observe(&[zoom()], 1_000);
    assert!(record.widgets.lock().unwrap().is_empty());
    assert_eq!(*record.events.lock().unwrap(), vec![busy("zoom.us", 1_000)]);

    let (watch, record) = fixture();
    *record.behavior.lock().unwrap() = Some(MicBusyBehavior::Record);
    watch.observe(&[zoom()], 1_000);
    assert_eq!(*record.widgets.lock().unwrap(), vec!["zoom.us"]);
}

#[test]
fn no_widget_while_a_recording_runs() {
    let (watch, record) = fixture();
    let recording = Arc::new(AtomicBool::new(true));
    let probe = Arc::clone(&recording);
    watch.set_recording_probe(move || probe.load(Ordering::SeqCst));
    watch.observe(&[zoom()], 1_000);
    assert!(record.widgets.lock().unwrap().is_empty());

    // The recording ended, the call too; the next call gets the widget.
    recording.store(false, Ordering::SeqCst);
    watch.observe(&[], 2_000);
    watch.tick(2_000 + RELEASE_DELAY_MS);
    watch.observe(&[zoom()], 10_000);
    assert_eq!(*record.widgets.lock().unwrap(), vec!["zoom.us"]);
}

#[test]
fn widget_rule_table() {
    use MicBusyBehavior::{Nothing, Record, Widget};
    // (onboarding completed, recording, behavior, shown) → show
    let cases = [
        (true, false, Widget, false, true),
        (true, false, Record, false, true),
        (true, false, Nothing, false, false),
        (false, false, Widget, false, false),
        (false, false, Record, false, false),
        (true, true, Widget, false, false),
        (true, true, Record, false, false),
        (true, false, Widget, true, false),
        (true, false, Record, true, false),
        (false, true, Nothing, true, false),
    ];
    for (onboarding_completed, recording, behavior, shown, expected) in cases {
        let rule = WidgetRule {
            onboarding_completed,
            recording,
            behavior,
            shown,
        };
        assert_eq!(should_show_widget(rule), expected, "{rule:?}");
    }
}

#[test]
fn the_widget_route_carries_the_app_name() {
    assert_eq!(widget_route("zoom.us"), "/widget?app=zoom.us");
    assert_eq!(widget_route("Google Chrome"), "/widget?app=Google%20Chrome");
    assert_eq!(widget_route("A&B=?#"), "/widget?app=A%26B%3D%3F%23");
    assert_eq!(
        widget_route("Телемост"),
        "/widget?app=%D0%A2%D0%B5%D0%BB%D0%B5%D0%BC%D0%BE%D1%81%D1%82"
    );
}

#[test]
fn the_event_serializes_in_camel_case_without_an_absent_app() {
    let event = MicActivityChanged {
        busy: false,
        app: None,
        since: 5,
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        serde_json::json!({ "busy": false, "since": 5 })
    );
    assert_eq!(
        serde_json::to_value(busy("Zoom", 7)).unwrap(),
        serde_json::json!({ "busy": true, "app": "Zoom", "since": 7 })
    );
}

/// The app's host on the mock runtime: a change reaches the listeners of
/// `MicActivityChanged`, and `mic_activity_get` answers the last state.
#[test]
fn the_app_host_emits_to_every_window_and_the_command_reads_the_last_state() {
    use tauri::{Manager, test::mock_builder};

    let app = mock_builder()
        .build(tauri::generate_context!(test = true))
        .expect("failed to build the mock app");
    tauri_specta::Builder::<tauri::test::MockRuntime>::new()
        .events(tauri_specta::collect_events![MicActivityChanged])
        .mount_events(&app);
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    MicActivityChanged::listen_any(&app, move |event| {
        sink.lock().unwrap().push(event.payload);
    });

    let watch = MicWatch::new(AppHost(app.handle().clone()));
    app.manage(watch.clone());
    watch.observe(&[zoom()], 1_000);

    assert_eq!(*received.lock().unwrap(), vec![busy("zoom.us", 1_000)]);
    let current = crate::commands::mic_activity_get(app.state::<MicWatch>()).unwrap();
    assert_eq!(current, busy("zoom.us", 1_000));
    // No storage in this app: onboarding counts as not done, no widget,
    // and nothing else failed on the way.
}
