//! The computer's microphones and the one the manager chose (settings-real
//! design.md, decision 1).
//!
//! - [`InputEnumerator`] lists the input devices: `cpal` in the app, a fake
//!   in the tests. A device's id is its name: CoreAudio and WASAPI keep the
//!   name of a device, and the setting `microphone` stores it.
//! - [`MicChoice`] is the chosen microphone (`"system"`: «Как в системе»)
//!   and since when it is missing. Every capture of «Я» (the recording, the
//!   level meter, the sound check) asks [`Inputs::target`] which device to
//!   open: the chosen one when it is there, else the default input.
//! - [`Inputs`] polls the list once a second while a window subscribed
//!   (`audio_inputs_start` / `audio_inputs_stop`, counted per window like
//!   the level meters) and sends [`AudioInputsChanged`] when the list or
//!   the missing state changed. A hidden or closed window loses its
//!   subscriptions and gets [`AudioInputsStopped`], as with the level
//!   meters: it subscribes again when it gets the focus back.

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::storage::settings::MIC_SYSTEM;

/// How often the list is polled while a window subscribed.
pub const POLL: Duration = Duration::from_secs(1);

/// An input device of the computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    /// What the setting `microphone` stores: the device name.
    pub id: String,
    /// The name the system shows.
    pub name: String,
    /// The default input of the system now.
    pub is_default: bool,
}

impl InputDevice {
    pub fn named(name: &str, is_default: bool) -> Self {
        Self {
            id: name.to_owned(),
            name: name.to_owned(),
            is_default,
        }
    }
}

/// The microphones and the choice, as `audio_inputs_get` returns them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputs {
    pub devices: Vec<InputDevice>,
    /// `"system"` («Как в системе») or the chosen device's name.
    pub selected: String,
    /// When the chosen device went missing (ms since the Unix epoch);
    /// absent while it is there or with «Как в системе». The app listens to
    /// the default input meanwhile.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_since: Option<i64>,
}

/// The list of microphones or the missing state changed. To every window,
/// only while some window subscribed (`audio_inputs_start`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputsChanged(pub AudioInputs);

/// Rust ended the calling window's subscriptions to the microphones: the
/// window was hidden. To that window only; it subscribes again
/// (`audio_inputs_start`, after reading `audio_inputs_get`) when it is
/// shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct AudioInputsStopped;

/// Lists the input devices of the computer.
pub trait InputEnumerator: Send + Sync + 'static {
    fn list(&self) -> Vec<InputDevice>;
}

/// The input devices through `cpal`.
pub struct CpalInputs;

impl InputEnumerator for CpalInputs {
    fn list(&self) -> Vec<InputDevice> {
        use cpal::traits::{DeviceTrait, HostTrait};

        let host = cpal::default_host();
        let default = host
            .default_input_device()
            .and_then(|device| device.id().ok());
        let Ok(devices) = host.input_devices() else {
            return Vec::new();
        };
        let mut listed: Vec<InputDevice> = Vec::new();
        for device in devices {
            let Ok(description) = device.description() else {
                continue;
            };
            let name = description.name().trim();
            if name.is_empty() {
                continue;
            }
            let is_default = default.is_some() && device.id().ok() == default;
            // Two devices of one name: the first is the one opened.
            match listed.iter_mut().find(|known| known.name == name) {
                Some(known) => known.is_default |= is_default,
                None => listed.push(InputDevice::named(name, is_default)),
            }
        }
        listed
    }
}

/// Which input the microphone opens now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// The device name to open; `None`: the default input (none listed as
    /// default, or no device at all).
    pub name: Option<String>,
    /// The chosen device is missing: this is the default input instead.
    pub fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChoiceState {
    /// `None`: «Как в системе».
    selected: Option<String>,
    missing_since: Option<i64>,
}

/// The chosen microphone and since when it is missing; shared by every
/// capture of «Я».
#[derive(Debug)]
pub struct MicChoice(Mutex<ChoiceState>);

impl MicChoice {
    /// `selected`: the device name, `None` for «Как в системе».
    pub fn new(selected: Option<String>) -> Self {
        Self(Mutex::new(ChoiceState {
            selected,
            missing_since: None,
        }))
    }

    fn state(&self) -> MutexGuard<'_, ChoiceState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A new choice; whether it went missing is found on the next resolve.
    /// Returns whether it changed.
    pub fn select(&self, selected: Option<String>) -> bool {
        let mut state = self.state();
        if state.selected == selected {
            return false;
        }
        state.selected = selected;
        state.missing_since = None;
        true
    }

    /// Which device to open among `devices`, noting at `now_ms` that the
    /// chosen one went missing (or came back).
    pub fn resolve(&self, devices: &[InputDevice], now_ms: i64) -> Target {
        let default = devices
            .iter()
            .find(|device| device.is_default)
            .map(|device| device.name.clone());
        let mut state = self.state();
        let Some(selected) = state.selected.clone() else {
            state.missing_since = None;
            return Target {
                name: default,
                fallback: false,
            };
        };
        if devices.iter().any(|device| device.id == selected) {
            state.missing_since = None;
            return Target {
                name: Some(selected),
                fallback: false,
            };
        }
        state.missing_since.get_or_insert(now_ms);
        Target {
            name: default,
            fallback: true,
        }
    }

    /// The snapshot of `devices` for the windows, resolving first.
    pub fn snapshot(&self, devices: Vec<InputDevice>, now_ms: i64) -> AudioInputs {
        self.resolve(&devices, now_ms);
        let state = self.state();
        AudioInputs {
            selected: state
                .selected
                .clone()
                .unwrap_or_else(|| MIC_SYSTEM.to_owned()),
            missing_since: state.missing_since,
            devices,
        }
    }
}

/// Where the inputs' events go: every window in the app, a recorder in
/// tests.
pub trait InputsSink: Send + Sync + 'static {
    fn changed(&self, inputs: &AudioInputs);
    /// The device the microphone opens changed (the chosen one went missing
    /// or came back, the default changed): a running level meter reopens.
    fn target_changed(&self);
    /// Rust dropped the subscriptions of the window `label` (it was
    /// hidden or closed).
    fn stopped(&self, label: &str);
}

struct Watch {
    /// Subscriptions by window label.
    windows: BTreeMap<String, u32>,
    /// The last snapshot sent (or read by the first poll).
    last: Option<AudioInputs>,
    last_target: Option<Target>,
}

struct Inner {
    enumerator: Box<dyn InputEnumerator>,
    choice: MicChoice,
    sink: Box<dyn InputsSink>,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    /// `None`: no poller thread, `poll` is called by hand (tests).
    period: Option<Duration>,
    watch: Mutex<Watch>,
    /// Tells a poller from a later one: each subscription period has its
    /// own generation.
    generation: AtomicU64,
}

/// The microphones and the choice, managed as Tauri state. Cheap to clone.
#[derive(Clone)]
pub struct Inputs(Arc<Inner>);

impl Inputs {
    pub fn new(
        enumerator: impl InputEnumerator,
        selected: Option<String>,
        sink: impl InputsSink,
        clock: impl Fn() -> i64 + Send + Sync + 'static,
        period: Option<Duration>,
    ) -> Self {
        Self(Arc::new(Inner {
            enumerator: Box::new(enumerator),
            choice: MicChoice::new(selected),
            sink: Box::new(sink),
            clock: Box::new(clock),
            period,
            watch: Mutex::new(Watch {
                windows: BTreeMap::new(),
                last: None,
                last_target: None,
            }),
            generation: AtomicU64::new(0),
        }))
    }

    fn watch(&self) -> MutexGuard<'_, Watch> {
        self.0.watch.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> i64 {
        (self.0.clock)()
    }

    /// The devices now and the choice. Blocks on the device list: call it
    /// off the main thread.
    pub fn get(&self) -> AudioInputs {
        let devices = self.0.enumerator.list();
        self.0.choice.snapshot(devices, self.now())
    }

    /// The device «Я» opens now. Blocks like [`Self::get`].
    pub fn target(&self) -> Target {
        let devices = self.0.enumerator.list();
        self.0.choice.resolve(&devices, self.now())
    }

    /// The setting `microphone` changed (`None`: «Как в системе»). The
    /// subscribed windows hear of it at once, and a running level meter
    /// reopens on the new device. Blocks like [`Self::get`].
    pub fn select(&self, selected: Option<String>) {
        if !self.0.choice.select(selected) {
            return;
        }
        let polling = {
            let mut watch = self.watch();
            if watch.windows.is_empty() {
                watch.last_target = None;
            }
            !watch.windows.is_empty()
        };
        if polling {
            // One reopen at most: the poll compares the device to open.
            self.poll_and_retarget(true);
        } else {
            self.0.sink.target_changed();
        }
    }

    /// Subscribes a window to `AudioInputsChanged`; the first subscriber
    /// starts the polling.
    pub fn start(&self, label: &str) {
        let first = {
            let mut watch = self.watch();
            let first = watch.windows.is_empty();
            *watch.windows.entry(label.to_owned()).or_default() += 1;
            if first {
                watch.last = None;
                watch.last_target = None;
            }
            first
        };
        if first {
            let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(period) = self.0.period {
                self.spawn_poller(generation, period);
            }
        }
    }

    /// Ends one subscription of a window; the last one stops the polling.
    pub fn stop(&self, label: &str) {
        let mut watch = self.watch();
        if let Some(count) = watch.windows.get_mut(label) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                watch.windows.remove(label);
            }
        }
        if watch.windows.is_empty() {
            self.0.generation.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Every subscription of a hidden or closed window; a window that had
    /// some hears of it (`stopped`).
    pub fn remove_window(&self, label: &str) {
        let removed = {
            let mut watch = self.watch();
            let removed = watch.windows.remove(label).is_some();
            if removed && watch.windows.is_empty() {
                self.0.generation.fetch_add(1, Ordering::SeqCst);
            }
            removed
        };
        if removed {
            self.0.sink.stopped(label);
        }
    }

    #[cfg(test)]
    pub fn is_polling(&self) -> bool {
        !self.watch().windows.is_empty()
    }

    /// Reads the list; sends `AudioInputsChanged` when it or the missing
    /// state changed since the last poll, and `target_changed` when the
    /// device to open changed. The first poll of a subscription period only
    /// remembers (the window read `audio_inputs_get`).
    pub fn poll(&self) {
        self.poll_and_retarget(false);
    }

    /// [`Self::poll`]; `unknown_is_new`: a device to open no poll saw yet
    /// counts as a change (a new choice).
    fn poll_and_retarget(&self, unknown_is_new: bool) {
        let devices = self.0.enumerator.list();
        let now = self.now();
        let target = self.0.choice.resolve(&devices, now);
        let inputs = self.0.choice.snapshot(devices, now);
        let (changed, target_changed) = {
            let mut watch = self.watch();
            let changed = watch.last.as_ref().is_some_and(|last| *last != inputs);
            let target_changed = watch
                .last_target
                .as_ref()
                .map_or(unknown_is_new, |last| *last != target);
            watch.last = Some(inputs.clone());
            watch.last_target = Some(target);
            (changed, target_changed)
        };
        if target_changed {
            self.0.sink.target_changed();
        }
        if changed {
            self.0.sink.changed(&inputs);
        }
    }

    fn spawn_poller(&self, generation: u64, period: Duration) {
        let inputs = self.clone();
        let spawned = thread::Builder::new()
            .name("grill-inputs".to_owned())
            .spawn(move || {
                while inputs.0.generation.load(Ordering::SeqCst) == generation {
                    inputs.poll();
                    thread::sleep(period);
                }
            });
        if let Err(error) = spawned {
            eprintln!("grill: failed to start the microphones' watcher: {error}");
        }
    }
}

#[cfg(test)]
mod tests;
