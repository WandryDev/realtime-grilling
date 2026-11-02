use serde::Serialize;
use specta::Type;

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
