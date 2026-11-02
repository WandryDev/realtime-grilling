//! Who listens to which level (decision 13). One capture per source,
//! however many windows subscribed; subscribers are counted per window
//! label. The last `stop` (or the window hiding or closing) closes the
//! device. The level goes only to the subscribed windows.
//!
//! The map lock is never held while a device opens or closes: an opening
//! source has a placeholder that other `start`s wait on, and devices are
//! released after the lock is gone (off the main thread when the main
//! thread dropped them).
//!
//! When Rust ends a subscription itself (the window hid or closed, the
//! capture broke) the window gets `AudioLevelStopped`, so its level stream
//! ends instead of going quiet.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::{
    AudioLevel, AudioLevelStopped, AudioSource,
    level::{Failure, Feed},
};
use crate::error::CommandResult;

/// How often a level goes out (~10 Hz, the spec asks for 8+).
pub const TICK: Duration = Duration::from_millis(100);
/// Every how many ticks hidden windows lose their subscriptions (0.5 s).
const VISIBILITY_EVERY: u32 = 5;

/// Whether some app plays to the output, read at every tick.
pub type Playing = Box<dyn Fn() -> bool + Send + Sync>;

/// An open capture. Dropping `capture` releases the device.
pub struct Opened {
    #[allow(dead_code, reason = "held for its Drop, which releases the device")]
    pub capture: Box<dyn Send>,
    pub playing: Option<Playing>,
}

/// Opens the device of a source; its callback pushes samples to `feed`
/// and reports a later breakdown with `Feed::fail`.
pub trait Opener: Send + Sync + 'static {
    fn open(&self, source: AudioSource, feed: Feed) -> CommandResult<Opened>;
}

/// Where levels go: the app's windows, a recorder in tests.
pub trait LevelSink: Send + Sync + 'static {
    fn emit(&self, label: &str, event: &AudioLevel);
    fn stopped(&self, label: &str, event: &AudioLevelStopped);
    fn is_visible(&self, label: &str) -> bool;
}

pub struct WindowSink<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> LevelSink for WindowSink<R> {
    fn emit(&self, label: &str, event: &AudioLevel) {
        if let Err(error) = event.emit_to(&self.0, label) {
            eprintln!("grill: failed to emit audio-level to {label}: {error}");
        }
    }

    fn stopped(&self, label: &str, event: &AudioLevelStopped) {
        if let Err(error) = event.emit_to(&self.0, label) {
            eprintln!("grill: failed to emit audio-level-stopped to {label}: {error}");
        }
    }

    fn is_visible(&self, label: &str) -> bool {
        self.0
            .get_webview_window(label)
            .is_some_and(|window| window.is_visible().unwrap_or(false))
    }
}

type Windows = BTreeMap<String, u32>;

struct Running {
    opened: Opened,
    feed: Feed,
    /// Subscriptions by window label.
    windows: Windows,
    /// Stops this capture's ticker; also tells it from a later capture of
    /// the same source.
    stopped: Arc<AtomicBool>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

enum Entry {
    /// The device is being opened; these windows wait for it.
    Opening(Windows),
    Running(Running),
}

impl Entry {
    fn windows(&mut self) -> &mut Windows {
        match self {
            Self::Opening(windows) => windows,
            Self::Running(capture) => &mut capture.windows,
        }
    }
}

fn subscribe(windows: &mut Windows, label: &str) {
    *windows.entry(label.to_owned()).or_default() += 1;
}

/// One subscription of a window less.
fn unsubscribe(windows: &mut Windows, label: &str) {
    if let Some(count) = windows.get_mut(label) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            windows.remove(label);
        }
    }
}

struct Inner {
    opener: Box<dyn Opener>,
    sink: Box<dyn LevelSink>,
    /// `None`: no ticker threads, `tick` is called by hand and devices are
    /// released inline (tests).
    tick: Option<Duration>,
    entries: Mutex<HashMap<AudioSource, Entry>>,
    /// Signalled when an opening source is open or failed.
    settled: Condvar,
}

/// Managed as Tauri state.
#[derive(Clone)]
pub struct AudioLevels(Arc<Inner>);

impl AudioLevels {
    pub fn new(opener: impl Opener, sink: impl LevelSink, tick: Option<Duration>) -> Self {
        Self(Arc::new(Inner {
            opener: Box::new(opener),
            sink: Box::new(sink),
            tick,
            entries: Mutex::new(HashMap::new()),
            settled: Condvar::new(),
        }))
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<AudioSource, Entry>> {
        self.0
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Subscribes a window; opens the device if no one listens to it yet.
    /// A failed open is the error of this call and keeps nothing open.
    /// Blocks while the device opens: call it off the main thread.
    pub fn start(&self, label: &str, source: AudioSource) -> CommandResult<()> {
        let mut entries = self.entries();
        loop {
            match entries.get_mut(&source) {
                Some(Entry::Running(capture)) => {
                    subscribe(&mut capture.windows, label);
                    return Ok(());
                }
                Some(Entry::Opening(windows)) => {
                    subscribe(windows, label);
                    entries = self
                        .0
                        .settled
                        .wait_while(entries, |entries| {
                            matches!(entries.get(&source), Some(Entry::Opening(_)))
                        })
                        .unwrap_or_else(PoisonError::into_inner);
                    // Open: the subscription is in it (or was stopped
                    // meanwhile). Failed: it went with the placeholder, and
                    // this call tries to open the device itself.
                    if entries.contains_key(&source) {
                        return Ok(());
                    }
                }
                None => break,
            }
        }
        entries.insert(
            source,
            Entry::Opening(Windows::from([(label.to_owned(), 1)])),
        );
        drop(entries);

        let feed = Feed::default();
        let opened = self.0.opener.open(source, feed.clone());

        let mut entries = self.entries();
        let windows = match entries.remove(&source) {
            Some(Entry::Opening(windows)) => windows,
            other => {
                // Only this call replaces its placeholder.
                debug_assert!(other.is_none());
                Windows::new()
            }
        };
        let opened = match opened {
            Ok(opened) => opened,
            Err(error) => {
                drop(entries);
                self.0.settled.notify_all();
                return Err(error);
            }
        };
        if windows.is_empty() {
            // Every subscriber stopped while it opened.
            drop(entries);
            self.0.settled.notify_all();
            drop(opened);
            return Ok(());
        }
        let stopped = Arc::new(AtomicBool::new(false));
        entries.insert(
            source,
            Entry::Running(Running {
                opened,
                feed,
                windows,
                stopped: Arc::clone(&stopped),
            }),
        );
        drop(entries);
        self.0.settled.notify_all();
        if let Some(tick) = self.0.tick {
            self.spawn_ticker(source, stopped, tick);
        }
        Ok(())
    }

    /// Ends one subscription of a window; the last one closes the device.
    pub fn stop(&self, label: &str, source: AudioSource) {
        let closed = {
            let mut entries = self.entries();
            let Some(entry) = entries.get_mut(&source) else {
                return;
            };
            unsubscribe(entry.windows(), label);
            let idle = matches!(entry, Entry::Running(capture) if capture.windows.is_empty());
            if idle { entries.remove(&source) } else { None }
        };
        // The device closes outside the lock.
        drop(closed);
    }

    /// Takes every subscription of a window off; returns the sources it
    /// had and the captures no one listens to any more.
    fn detach(&self, label: &str) -> (Vec<AudioSource>, Vec<Entry>) {
        let mut entries = self.entries();
        let mut sources = Vec::new();
        for (source, entry) in entries.iter_mut() {
            if entry.windows().remove(label).is_some() {
                sources.push(*source);
            }
        }
        let idle: Vec<AudioSource> = entries
            .iter()
            .filter(
                |(_, entry)| matches!(entry, Entry::Running(capture) if capture.windows.is_empty()),
            )
            .map(|(source, _)| *source)
            .collect();
        let closed = idle
            .iter()
            .filter_map(|source| entries.remove(source))
            .collect();
        (sources, closed)
    }

    fn tell_stopped(&self, label: &str, sources: &[AudioSource]) {
        for source in sources {
            self.0
                .sink
                .stopped(label, &AudioLevelStopped::hidden(*source));
        }
    }

    /// Ends every subscription of a hidden or closed window, tells it with
    /// `AudioLevelStopped` and releases the devices on this thread.
    pub fn remove_window(&self, label: &str) {
        let (sources, closed) = self.detach(label);
        self.tell_stopped(label, &sources);
        drop(closed);
    }

    /// [`Self::remove_window`] for the main thread: the devices are
    /// released on another thread.
    pub fn remove_window_in_background(&self, label: &str) {
        let (sources, closed) = self.detach(label);
        self.tell_stopped(label, &sources);
        if closed.is_empty() {
            return;
        }
        if self.0.tick.is_none() {
            drop(closed);
            return;
        }
        // If the thread can't start, the closure (and the devices) drop here.
        let released = thread::Builder::new()
            .name("grill-level-release".to_owned())
            .spawn(move || drop(closed));
        if let Err(error) = released {
            eprintln!("grill: failed to release audio devices in the background: {error}");
        }
    }

    /// Sends the level since the last tick to the subscribed windows.
    #[cfg(test)]
    pub fn tick(&self, source: AudioSource) {
        self.tick_capture(source, None);
    }

    fn tick_capture(&self, source: AudioSource, ticker: Option<&Arc<AtomicBool>>) {
        enum Outcome {
            Level(AudioLevel, Vec<String>),
            Broke(Failure, Vec<String>, Option<Entry>),
        }
        let outcome = {
            let mut entries = self.entries();
            let Some(Entry::Running(capture)) = entries.get(&source) else {
                return;
            };
            if ticker.is_some_and(|ticker| !Arc::ptr_eq(ticker, &capture.stopped)) {
                return;
            }
            let labels: Vec<String> = capture.windows.keys().cloned().collect();
            if let Some(failure) = capture.feed.take_failure() {
                Outcome::Broke(failure, labels, entries.remove(&source))
            } else {
                let event = AudioLevel {
                    source,
                    level: capture.feed.take_level(),
                    playing: capture.opened.playing.as_ref().map(|playing| playing()),
                };
                Outcome::Level(event, labels)
            }
        };
        // Emitting and asking for visibility may wait for the main
        // thread, so never under the lock.
        match outcome {
            Outcome::Level(event, labels) => {
                for label in labels {
                    self.0.sink.emit(&label, &event);
                }
            }
            Outcome::Broke(failure, labels, closed) => {
                drop(closed);
                let event = AudioLevelStopped::failed(source, failure);
                for label in labels {
                    self.0.sink.stopped(&label, &event);
                }
            }
        }
    }

    /// Drops the subscriptions of the windows of a source that are hidden.
    pub fn drop_hidden(&self, source: AudioSource) {
        let labels: Vec<String> = match self.entries().get(&source) {
            Some(Entry::Running(capture)) => capture.windows.keys().cloned().collect(),
            _ => Vec::new(),
        };
        for label in labels {
            if !self.0.sink.is_visible(&label) {
                self.remove_window(&label);
            }
        }
    }

    fn spawn_ticker(&self, source: AudioSource, stopped: Arc<AtomicBool>, tick: Duration) {
        let levels = self.clone();
        let spawned = thread::Builder::new()
            .name(format!("grill-level-{source:?}"))
            .spawn(move || {
                let mut ticks: u32 = 0;
                loop {
                    thread::sleep(tick);
                    if stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    levels.tick_capture(source, Some(&stopped));
                    ticks = ticks.wrapping_add(1);
                    if ticks.is_multiple_of(VISIBILITY_EVERY) {
                        levels.drop_hidden(source);
                    }
                }
            });
        if let Err(error) = spawned {
            eprintln!("grill: failed to start the level ticker: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;
    use crate::error::{CaptureFailure, CommandError};

    #[derive(Default)]
    struct Counters {
        opened: AtomicUsize,
        closed: AtomicUsize,
        feeds: Mutex<HashMap<AudioSource, Feed>>,
        fail: Mutex<Option<CommandError>>,
        /// When set, `open` waits for a message on it.
        gate: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }

    struct Device(Arc<Counters>);

    impl Drop for Device {
        fn drop(&mut self) {
            self.0.closed.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FakeOpener(Arc<Counters>);

    impl Opener for FakeOpener {
        fn open(&self, source: AudioSource, feed: Feed) -> CommandResult<Opened> {
            let gate = self.0.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = gate.recv();
            }
            if let Some(error) = self.0.fail.lock().unwrap().take() {
                return Err(error);
            }
            self.0.opened.fetch_add(1, Ordering::SeqCst);
            self.0.feeds.lock().unwrap().insert(source, feed);
            Ok(Opened {
                capture: Box::new(Device(Arc::clone(&self.0))),
                playing: (source == AudioSource::System).then(|| Box::new(|| true) as Playing),
            })
        }
    }

    #[derive(Default)]
    struct Windows {
        events: Mutex<Vec<(String, AudioLevel)>>,
        stopped: Mutex<Vec<(String, AudioLevelStopped)>>,
        hidden: Mutex<BTreeSet<String>>,
    }

    struct FakeSink(Arc<Windows>);

    impl LevelSink for FakeSink {
        fn emit(&self, label: &str, event: &AudioLevel) {
            self.0
                .events
                .lock()
                .unwrap()
                .push((label.to_owned(), event.clone()));
        }

        fn stopped(&self, label: &str, event: &AudioLevelStopped) {
            self.0
                .stopped
                .lock()
                .unwrap()
                .push((label.to_owned(), event.clone()));
        }

        fn is_visible(&self, label: &str) -> bool {
            !self.0.hidden.lock().unwrap().contains(label)
        }
    }

    fn levels() -> (AudioLevels, Arc<Counters>, Arc<Windows>) {
        let counters = Arc::new(Counters::default());
        let windows = Arc::new(Windows::default());
        let levels = AudioLevels::new(
            FakeOpener(Arc::clone(&counters)),
            FakeSink(Arc::clone(&windows)),
            None,
        );
        (levels, counters, windows)
    }

    fn opened(counters: &Counters) -> (usize, usize) {
        (
            counters.opened.load(Ordering::SeqCst),
            counters.closed.load(Ordering::SeqCst),
        )
    }

    fn take_events(windows: &Windows) -> Vec<(String, AudioLevel)> {
        std::mem::take(&mut *windows.events.lock().unwrap())
    }

    fn take_stopped(windows: &Windows) -> Vec<(String, AudioLevelStopped)> {
        std::mem::take(&mut *windows.stopped.lock().unwrap())
    }

    #[test]
    fn a_second_subscriber_shares_the_device_and_the_last_stop_closes_it() {
        let (levels, counters, windows) = levels();
        levels.start("onboarding", AudioSource::Microphone).unwrap();
        levels.start("main", AudioSource::Microphone).unwrap();
        assert_eq!(opened(&counters), (1, 0), "opened once");

        levels.stop("onboarding", AudioSource::Microphone);
        assert_eq!(opened(&counters), (1, 0), "main still listens");
        levels.stop("main", AudioSource::Microphone);
        assert_eq!(opened(&counters), (1, 1), "closed by the last stop");

        levels.stop("main", AudioSource::Microphone);
        assert_eq!(opened(&counters), (1, 1), "a stop too many is ignored");
        assert!(
            take_stopped(&windows).is_empty(),
            "a window's own stop needs no event"
        );
    }

    #[test]
    fn a_window_subscribed_twice_needs_two_stops() {
        let (levels, counters, _) = levels();
        levels.start("onboarding", AudioSource::Microphone).unwrap();
        levels.start("onboarding", AudioSource::Microphone).unwrap();
        levels.stop("onboarding", AudioSource::Microphone);
        assert_eq!(opened(&counters), (1, 0));
        levels.stop("onboarding", AudioSource::Microphone);
        assert_eq!(opened(&counters), (1, 1));
    }

    #[test]
    fn levels_go_only_to_subscribed_windows() {
        let (levels, counters, windows) = levels();
        levels.start("onboarding", AudioSource::Microphone).unwrap();
        levels.start("main", AudioSource::System).unwrap();
        counters.feeds.lock().unwrap()[&AudioSource::Microphone].push([0.5, -0.5]);

        levels.tick(AudioSource::Microphone);
        levels.tick(AudioSource::System);
        let events = take_events(&windows);
        assert_eq!(events.len(), 2);
        let (label, mic) = &events[0];
        assert_eq!(label, "onboarding");
        assert_eq!(mic.source, AudioSource::Microphone);
        assert!(mic.level > 0.8, "{}", mic.level);
        assert_eq!(mic.playing, None);
        let (label, system) = &events[1];
        assert_eq!(label, "main");
        assert_eq!(system.source, AudioSource::System);
        assert_eq!(system.level, 0.0, "silence");
        assert_eq!(system.playing, Some(true));

        levels.stop("onboarding", AudioSource::Microphone);
        levels.tick(AudioSource::Microphone);
        assert!(take_events(&windows).is_empty(), "no one listens");
    }

    #[test]
    fn a_hidden_or_closed_window_loses_its_subscriptions() {
        let (levels, counters, windows) = levels();
        levels.start("onboarding", AudioSource::Microphone).unwrap();
        levels.start("onboarding", AudioSource::System).unwrap();
        levels.start("main", AudioSource::System).unwrap();
        levels.remove_window("onboarding");
        assert_eq!(opened(&counters), (2, 1), "the microphone closed");
        levels.tick(AudioSource::System);
        let labels: Vec<String> = take_events(&windows)
            .into_iter()
            .map(|(label, _)| label)
            .collect();
        assert_eq!(labels, ["main"]);
        let mut stopped = take_stopped(&windows);
        stopped.sort_by_key(|(_, event)| event.source);
        assert_eq!(
            stopped,
            [
                (
                    "onboarding".to_owned(),
                    AudioLevelStopped::hidden(AudioSource::Microphone)
                ),
                (
                    "onboarding".to_owned(),
                    AudioLevelStopped::hidden(AudioSource::System)
                ),
            ],
            "the window is told, so it subscribes again when shown"
        );

        windows.hidden.lock().unwrap().insert("main".to_owned());
        levels.drop_hidden(AudioSource::System);
        assert_eq!(opened(&counters), (2, 2), "system audio closed");
        assert_eq!(
            take_stopped(&windows),
            [(
                "main".to_owned(),
                AudioLevelStopped::hidden(AudioSource::System)
            )]
        );

        levels.remove_window("main");
        assert!(take_stopped(&windows).is_empty(), "nothing left to stop");
    }

    #[test]
    fn a_capture_that_breaks_stops_its_subscribers_with_the_reason() {
        let (levels, counters, windows) = levels();
        levels.start("onboarding", AudioSource::Microphone).unwrap();
        levels.start("main", AudioSource::Microphone).unwrap();
        let feed = counters.feeds.lock().unwrap()[&AudioSource::Microphone].clone();
        feed.push([0.5]);
        feed.fail(CaptureFailure::NoDevice, "Микрофон отключён");

        levels.tick(AudioSource::Microphone);
        assert!(
            take_events(&windows).is_empty(),
            "no zeros instead of the error"
        );
        let event = AudioLevelStopped {
            source: AudioSource::Microphone,
            reason: Some(CaptureFailure::NoDevice),
            message: Some("Микрофон отключён".to_owned()),
        };
        assert_eq!(
            take_stopped(&windows),
            [
                ("main".to_owned(), event.clone()),
                ("onboarding".to_owned(), event)
            ]
        );
        assert_eq!(opened(&counters), (1, 1), "the broken capture is closed");

        levels.start("onboarding", AudioSource::Microphone).unwrap();
        assert_eq!(opened(&counters), (2, 1), "a new start opens it again");
    }

    #[test]
    fn a_start_while_the_device_opens_waits_for_it() {
        let (levels, counters, _) = levels();
        let (open, gate) = std::sync::mpsc::channel();
        *counters.gate.lock().unwrap() = Some(gate);
        let first = {
            let levels = levels.clone();
            thread::spawn(move || levels.start("onboarding", AudioSource::Microphone))
        };
        while counters.gate.lock().unwrap().is_some() {
            thread::yield_now();
        }
        // The opener holds no lock: other sources and windows go on.
        levels.remove_window("widget");
        levels.stop("onboarding", AudioSource::System);
        let second = {
            let levels = levels.clone();
            thread::spawn(move || levels.start("main", AudioSource::Microphone))
        };
        thread::sleep(Duration::from_millis(50));
        assert!(!second.is_finished(), "waits for the opening device");
        open.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        assert_eq!(opened(&counters), (1, 0), "opened once");

        levels.stop("onboarding", AudioSource::Microphone);
        levels.stop("main", AudioSource::Microphone);
        assert_eq!(opened(&counters), (1, 1));
    }

    #[test]
    fn a_stop_while_the_device_opens_closes_it_when_open() {
        let (levels, counters, _) = levels();
        let (open, gate) = std::sync::mpsc::channel();
        *counters.gate.lock().unwrap() = Some(gate);
        let start = {
            let levels = levels.clone();
            thread::spawn(move || levels.start("onboarding", AudioSource::Microphone))
        };
        while counters.gate.lock().unwrap().is_some() {
            thread::yield_now();
        }
        levels.stop("onboarding", AudioSource::Microphone);
        open.send(()).unwrap();
        start.join().unwrap().unwrap();
        assert_eq!(opened(&counters), (1, 1), "no one listens: closed at once");
    }

    #[test]
    fn a_failed_open_keeps_nothing_and_the_next_start_retries() {
        let (levels, counters, windows) = levels();
        *counters.fail.lock().unwrap() = Some(CommandError::capture(
            CaptureFailure::NoDevice,
            "Нет микрофона",
        ));
        let error = levels
            .start("onboarding", AudioSource::Microphone)
            .unwrap_err();
        assert!(matches!(
            error,
            CommandError::External {
                reason: Some(CaptureFailure::NoDevice),
                ..
            }
        ));
        levels.tick(AudioSource::Microphone);
        assert!(take_events(&windows).is_empty());

        levels.start("onboarding", AudioSource::Microphone).unwrap();
        assert_eq!(opened(&counters), (1, 0));
    }

    #[test]
    fn the_ticker_sends_levels_and_stops_with_the_capture() {
        let counters = Arc::new(Counters::default());
        let windows = Arc::new(Windows::default());
        let levels = AudioLevels::new(
            FakeOpener(Arc::clone(&counters)),
            FakeSink(Arc::clone(&windows)),
            Some(Duration::from_millis(10)),
        );
        levels.start("onboarding", AudioSource::Microphone).unwrap();
        thread::sleep(Duration::from_millis(80));
        assert!(!take_events(&windows).is_empty());
        levels.stop("onboarding", AudioSource::Microphone);
        thread::sleep(Duration::from_millis(30));
        take_events(&windows);
        thread::sleep(Duration::from_millis(50));
        assert!(take_events(&windows).is_empty(), "the ticker stopped");
    }
}
