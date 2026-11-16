use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

/// What kind of record a `DataChanged` is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Entity {
    Project,
    Person,
    /// Also sent when the call's participants change.
    Call,
    Topic,
    TaskCard,
    Question,
    /// Transcript segments of a recording were written; `id` is the
    /// recording id, `projectId` the recording's project (if any).
    Transcript,
    /// `id` is `"settings"`.
    Settings,
    /// A connector's connection was made, changed or removed; `id` is the
    /// connector's kind (`outline`), no `projectId`.
    Connections,
    /// A project's selection in a connector or the state of its sync
    /// changed; `id` is the connector's kind, `projectId` the project. A
    /// sync that changed the project's sources sends the project's event
    /// instead: re-read the selection on it too.
    ConnectorSelections,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Created,
    Updated,
    Deleted,
}

/// Sent to every window after a write is committed, never on failure.
///
/// A cascade delete sends one event about the root record; stores of the
/// child records reread by `projectId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DataChanged {
    pub entity: Entity,
    pub id: String,
    pub project_id: Option<String>,
    pub change: Change,
}

impl DataChanged {
    pub fn new(entity: Entity, id: &str, project_id: Option<&str>, change: Change) -> Self {
        Self {
            entity,
            id: id.to_owned(),
            project_id: project_id.map(str::to_owned),
            change,
        }
    }
}

/// Tells the main window to open a route, e.g. "Настройки" in the tray menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct Navigate {
    pub route: String,
}

/// The call in progress changed (call-lifecycle design.md, decision 4).
/// Sent by the backend (`CallManager`) to every window after each change,
/// after the `DataChanged` of the call, so a window finds the call in its
/// store. `call_current` reads the same session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CallSessionChanged {
    pub session: CallSession,
}

/// The call in progress, as every window shows it. `idle`: no call, every
/// other field empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallSession {
    pub status: CallSessionStatus,
    /// The call in `calls`; `null` when idle.
    pub call_id: Option<String>,
    /// `null`: a call without a project ("Звонок без проекта").
    pub project_id: Option<String>,
    /// The client's people on the call, in the order they were added.
    pub participant_ids: Vec<String>,
    /// Their names, in the same order.
    pub participants: Vec<String>,
    /// When the call started, milliseconds since the Unix epoch.
    pub started_at: Option<i64>,
    /// The recording of the call: the running one while live (`null` when
    /// "Отменить завершение" could not start one), the stopped one while
    /// finishing.
    pub recording_id: Option<String>,
    /// The countdown "Завершать звонок сам" after the meeting app let the
    /// microphone go; `null` when none runs.
    pub auto_end: Option<CallAutoEnd>,
}

impl CallSession {
    pub fn idle() -> Self {
        Self {
            status: CallSessionStatus::Idle,
            call_id: None,
            project_id: None,
            participant_ids: Vec::new(),
            participants: Vec::new(),
            started_at: None,
            recording_id: None,
            auto_end: None,
        }
    }
}

/// `finishing`: "Завершить" was pressed, the main window collects the
/// summary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CallSessionStatus {
    Idle,
    Live,
    Finishing,
}

/// The meeting app let the microphone go during a live call: every window
/// offers to end the call and draws the same countdown, `endsAt − now`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallAutoEnd {
    /// The app that let the microphone go.
    pub app: String,
    /// When it let it go, milliseconds since the Unix epoch.
    pub released_at: i64,
    /// When the call ends by itself, milliseconds since the Unix epoch;
    /// `null` with "Никогда": the offer has no countdown.
    pub ends_at: Option<i64>,
}

/// A global shortcut from Settings was pressed; `action` is its id
/// (`toggle-call`, `next-question`…). Sent to every window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct ShortcutPressed {
    pub action: String,
}

/// Where data events go: every window in the app, a recorder in tests.
pub trait EventSink: Send + Sync {
    fn data_changed(&self, event: DataChanged);
}

impl<R: Runtime> EventSink for AppHandle<R> {
    fn data_changed(&self, event: DataChanged) {
        if let Err(error) = event.emit(self) {
            eprintln!("grill: failed to emit data-changed: {error}");
        }
    }
}

#[cfg(test)]
pub mod testing {
    use std::sync::Mutex;

    use super::{DataChanged, EventSink};

    /// Keeps the events a command sent.
    #[derive(Default)]
    pub struct RecordingSink(Mutex<Vec<DataChanged>>);

    impl RecordingSink {
        pub fn events(&self) -> Vec<DataChanged> {
            self.0.lock().unwrap().clone()
        }
    }

    impl EventSink for RecordingSink {
        fn data_changed(&self, event: DataChanged) {
            self.0.lock().unwrap().push(event);
        }
    }
}
