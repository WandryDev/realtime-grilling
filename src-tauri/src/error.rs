use serde::{Deserialize, Serialize};
use specta::Type;

/// Why a capture for the level meter could not open (`External.reason`)
/// or broke after it started (`AudioLevelStopped.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CaptureFailure {
    /// The OS denies the app the microphone or system audio.
    NoAccess,
    /// There is no input (or output) device.
    NoDevice,
    /// The device exists but could not be opened.
    Busy,
}

/// Error of every command. The frontend narrows on `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, thiserror::Error)]
#[serde(tag = "kind")]
pub enum CommandError {
    /// The record (or the record it refers to) does not exist.
    #[error("{message}")]
    NotFound { message: String },
    /// The input breaks a rule: empty name, a participant from another project…
    #[error("{message}")]
    Invalid { message: String },
    /// The database could not be opened, migrated, read or written.
    #[error("{message}")]
    Storage { message: String },
    /// An external process (the agent CLI, its installer) or an OS API
    /// answered with an error. `reason` is set by `audio_level_start`.
    #[error("{message}")]
    External {
        message: String,
        #[specta(optional)]
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<CaptureFailure>,
    },
}

impl CommandError {
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound {
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
        }
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::Storage {
            message: message.into(),
        }
    }

    pub fn external(message: impl Into<String>) -> Self {
        Self::External {
            message: message.into(),
            reason: None,
        }
    }

    pub fn capture(reason: CaptureFailure, message: impl Into<String>) -> Self {
        Self::External {
            message: message.into(),
            reason: Some(reason),
        }
    }
}

impl From<rusqlite::Error> for CommandError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::ConstraintViolation;
        match &error {
            rusqlite::Error::QueryReturnedNoRows => Self::not_found("Запись не найдена"),
            // CHECK, NOT NULL and foreign keys back up the validation in the
            // commands; a violation is bad input, not a broken database.
            rusqlite::Error::SqliteFailure(failure, _) if failure.code == ConstraintViolation => {
                Self::invalid(format!("Неверные данные: {error}"))
            }
            _ => Self::storage(error.to_string()),
        }
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(error: serde_json::Error) -> Self {
        Self::storage(format!("Повреждённый JSON в базе: {error}"))
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
