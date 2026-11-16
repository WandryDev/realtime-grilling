//! The microphones on a fake enumerator (settings-real task 2.1).

use std::sync::atomic::{AtomicI64, AtomicUsize};

use super::*;

#[derive(Default)]
struct Machine {
    devices: Mutex<Vec<InputDevice>>,
    now: AtomicI64,
    events: Mutex<Vec<AudioInputs>>,
    retargets: AtomicUsize,
    stopped: Mutex<Vec<String>>,
}

impl Machine {
    fn plug(&self, name: &str, is_default: bool) {
        self.devices
            .lock()
            .unwrap()
            .push(InputDevice::named(name, is_default));
    }

    fn unplug(&self, name: &str) {
        self.devices
            .lock()
            .unwrap()
            .retain(|device| device.name != name);
    }

    fn at(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }

    fn take_events(&self) -> Vec<AudioInputs> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    fn retargets(&self) -> usize {
        self.retargets.load(Ordering::SeqCst)
    }
}

struct FakeEnumerator(Arc<Machine>);

impl InputEnumerator for FakeEnumerator {
    fn list(&self) -> Vec<InputDevice> {
        self.0.devices.lock().unwrap().clone()
    }
}

struct FakeSink(Arc<Machine>);

impl InputsSink for FakeSink {
    fn changed(&self, inputs: &AudioInputs) {
        self.0.events.lock().unwrap().push(inputs.clone());
    }

    fn target_changed(&self) {
        self.0.retargets.fetch_add(1, Ordering::SeqCst);
    }

    fn stopped(&self, label: &str) {
        self.0.stopped.lock().unwrap().push(label.to_owned());
    }
}

/// A MacBook with its built-in microphone as the default, and AirPods.
fn machine(selected: Option<&str>) -> (Inputs, Arc<Machine>) {
    let machine = Arc::new(Machine::default());
    machine.plug("MacBook Pro Microphone", true);
    machine.plug("AirPods Pro", false);
    machine.at(1_000);
    let clock = Arc::clone(&machine);
    let inputs = Inputs::new(
        FakeEnumerator(Arc::clone(&machine)),
        selected.map(str::to_owned),
        FakeSink(Arc::clone(&machine)),
        move || clock.now.load(Ordering::SeqCst),
        None,
    );
    (inputs, machine)
}

fn target(name: &str, fallback: bool) -> Target {
    Target {
        name: Some(name.to_owned()),
        fallback,
    }
}

#[test]
fn the_list_is_the_systems_with_the_default_marked() {
    let (inputs, _) = machine(None);
    let got = inputs.get();
    assert_eq!(
        got,
        AudioInputs {
            devices: vec![
                InputDevice::named("MacBook Pro Microphone", true),
                InputDevice::named("AirPods Pro", false),
            ],
            selected: "system".to_owned(),
            missing_since: None,
        }
    );
    let json = serde_json::to_value(&got.devices[0]).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "id": "MacBook Pro Microphone",
            "name": "MacBook Pro Microphone",
            "isDefault": true
        })
    );
}

/// `app-settings`, «Выбрать AirPods».
#[test]
fn a_chosen_device_is_opened_by_name() {
    let (inputs, _) = machine(Some("AirPods Pro"));
    assert_eq!(inputs.target(), target("AirPods Pro", false));
    assert_eq!(inputs.get().selected, "AirPods Pro");
}

#[test]
fn as_in_the_system_is_the_default_at_capture() {
    let (inputs, machine) = machine(None);
    assert_eq!(inputs.target(), target("MacBook Pro Microphone", false));
    // The system's default moved to the AirPods.
    *machine.devices.lock().unwrap() = vec![
        InputDevice::named("MacBook Pro Microphone", false),
        InputDevice::named("AirPods Pro", true),
    ];
    assert_eq!(inputs.target(), target("AirPods Pro", false));
    machine.devices.lock().unwrap().clear();
    assert_eq!(
        inputs.target(),
        Target {
            name: None,
            fallback: false
        },
        "no device: the default input, whatever it is"
    );
}

/// `app-settings`, «Отключили AirPods», then they come back.
#[test]
fn a_missing_choice_falls_back_and_returns() {
    let (inputs, machine) = machine(Some("AirPods Pro"));
    machine.unplug("AirPods Pro");
    machine.at(5_000);
    assert_eq!(inputs.target(), target("MacBook Pro Microphone", true));
    assert_eq!(inputs.get().missing_since, Some(5_000));
    machine.at(9_000);
    assert_eq!(
        inputs.get().missing_since,
        Some(5_000),
        "since it went missing, not since the last look"
    );

    machine.plug("AirPods Pro", false);
    assert_eq!(inputs.target(), target("AirPods Pro", false));
    assert_eq!(inputs.get().missing_since, None);
}

#[test]
fn an_unknown_stored_name_is_a_missing_device() {
    // `airpods` of the demo, or a device of another computer.
    let (inputs, _) = machine(Some("airpods"));
    let got = inputs.get();
    assert_eq!(got.selected, "airpods");
    assert_eq!(got.missing_since, Some(1_000));
    assert_eq!(inputs.target(), target("MacBook Pro Microphone", true));
}

#[test]
fn choosing_as_in_the_system_clears_the_missing_state() {
    let (inputs, machine) = machine(Some("USB Mic"));
    assert_eq!(inputs.get().missing_since, Some(1_000));
    inputs.select(None);
    assert_eq!(inputs.get().missing_since, None);
    assert_eq!(inputs.get().selected, "system");
    assert_eq!(machine.retargets(), 1, "a running meter reopens");
    inputs.select(None);
    assert_eq!(machine.retargets(), 1, "the same choice changes nothing");
}

/// `app-settings`, «Подключили устройство»: an event only on a change.
#[test]
fn the_event_goes_only_when_the_list_or_the_missing_state_changed() {
    let (inputs, machine) = machine(Some("AirPods Pro"));
    inputs.poll();
    assert!(machine.take_events().is_empty(), "no one subscribed");

    inputs.start("main");
    assert!(inputs.is_polling());
    inputs.poll();
    inputs.poll();
    assert!(
        machine.take_events().is_empty(),
        "the first poll remembers, the same list sends nothing"
    );

    machine.plug("USB Mic", false);
    inputs.poll();
    let events = machine.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].devices.len(), 3);
    assert_eq!(machine.retargets(), 0, "the device to open is the same");
    inputs.poll();
    assert!(machine.take_events().is_empty());

    machine.at(2_000);
    machine.unplug("AirPods Pro");
    inputs.poll();
    let events = machine.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].missing_since, Some(2_000));
    assert_eq!(machine.retargets(), 1, "the meter goes to the default");
    machine.at(3_000);
    inputs.poll();
    assert!(
        machine.take_events().is_empty(),
        "still missing since the same time"
    );

    machine.plug("AirPods Pro", false);
    inputs.poll();
    let events = machine.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].missing_since, None);
    assert_eq!(machine.retargets(), 2, "back on the AirPods");

    // A new choice is sent at once to the subscribers.
    inputs.select(Some("USB Mic".to_owned()));
    let events = machine.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].selected, "USB Mic");
}

#[test]
fn the_last_subscriber_stops_the_polling() {
    let (inputs, _) = machine(None);
    inputs.start("main");
    inputs.start("main");
    inputs.start("onboarding");
    inputs.stop("main");
    inputs.remove_window("onboarding");
    assert!(inputs.is_polling(), "main subscribed twice");
    inputs.stop("main");
    assert!(!inputs.is_polling());
    inputs.stop("main");
    assert!(!inputs.is_polling(), "a stop too many is ignored");
}

#[test]
fn the_poller_thread_sends_changes_and_stops_with_the_last_subscriber() {
    let machine = Arc::new(Machine::default());
    machine.plug("MacBook Pro Microphone", true);
    let inputs = Inputs::new(
        FakeEnumerator(Arc::clone(&machine)),
        None,
        FakeSink(Arc::clone(&machine)),
        || 1,
        Some(Duration::from_millis(10)),
    );
    inputs.start("main");
    thread::sleep(Duration::from_millis(40));
    machine.plug("USB Mic", false);
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while machine.events.lock().unwrap().is_empty() {
        assert!(std::time::Instant::now() < deadline, "no event");
        thread::sleep(Duration::from_millis(5));
    }
    inputs.stop("main");
    thread::sleep(Duration::from_millis(40));
    machine.take_events();
    machine.plug("Webcam", false);
    thread::sleep(Duration::from_millis(60));
    assert!(machine.take_events().is_empty(), "the poller stopped");
}

/// The main window hides (its close only hides it) and is shown again: it
/// hears that its subscription went, and its new one polls like the first.
#[test]
fn a_hidden_window_is_told_and_subscribes_again() {
    let (inputs, machine) = machine(None);
    inputs.start("main");
    inputs.remove_window("main");
    assert!(!inputs.is_polling());
    assert_eq!(*machine.stopped.lock().unwrap(), vec!["main".to_owned()]);
    inputs.remove_window("main");
    inputs.remove_window("widget");
    assert_eq!(
        machine.stopped.lock().unwrap().len(),
        1,
        "only a window that had a subscription hears of it"
    );

    // The window's stop of the dropped subscription arrives late: ignored.
    inputs.stop("main");
    inputs.start("main");
    assert!(inputs.is_polling());
    inputs.poll();
    machine.plug("USB Mic", false);
    inputs.poll();
    assert_eq!(machine.take_events().len(), 1);
    inputs.stop("main");
    assert!(!inputs.is_polling(), "one start, one stop");
}

/// A new choice while a window listens reopens a running meter once.
#[test]
fn a_new_choice_reopens_the_meter_once() {
    let (inputs, machine) = machine(None);
    inputs.start("main");
    inputs.poll();
    inputs.select(Some("AirPods Pro".to_owned()));
    assert_eq!(machine.retargets(), 1);
    inputs.select(None);
    assert_eq!(machine.retargets(), 2, "back to the default once");
}

/// A new subscription period forgets the device the last one opened.
#[test]
fn a_new_subscription_forgets_the_last_target() {
    let (inputs, machine) = machine(Some("AirPods Pro"));
    inputs.start("main");
    inputs.poll();
    inputs.stop("main");
    machine.unplug("AirPods Pro");
    inputs.start("main");
    inputs.poll();
    assert_eq!(
        machine.retargets(),
        0,
        "the first poll of a period only remembers"
    );
}
