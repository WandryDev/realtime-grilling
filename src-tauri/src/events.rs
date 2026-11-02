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
    /// A batch of transcript segments; `id` is the call id.
    Transcript,
    /// `id` is `"settings"`.
    Settings,
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

/// Where the call in progress is. The windows hand a call over to each
/// other (the start widget starts it, the overlay shows it, the main window
/// builds its summary), so every change is sent to every window; a window
/// ignores the ones it sent itself (`source` is its label). Sent by the
/// frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CallSessionChanged {
    /// Label of the window that changed it.
    pub source: String,
    pub session: CallSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallSession {
    pub call_id: String,
    /// Names of the client's people on the call.
    pub participants: Vec<String>,
    pub project_id: Option<String>,
    /// When recording started, milliseconds since the Unix epoch.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    pub status: CallSessionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CallSessionStatus {
    Idle,
    Live,
    Finishing,
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
