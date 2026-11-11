//! Connector secrets in the OS store (connectors-outline design.md,
//! decision 2): Keychain on macOS, Credential Manager on Windows, through
//! `keyring` 3. Service `com.dev-wandry.realtime-grilling`, account
//! `connector.<kind>`, the value a JSON [`Credential`]. Tests use
//! [`MemoryStore`].

#[cfg(test)]
use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};

use super::{ConnectorKind, Credential};

/// The service name of every entry: the app's identifier.
pub const SERVICE: &str = "com.dev-wandry.realtime-grilling";

/// Why the OS store failed. The message never has the secret.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    /// The store answered, but has no entry.
    #[error("Ключ не найден в системном хранилище")]
    Missing,
    /// The store refused or failed.
    #[error("{0}")]
    Store(String),
}

/// Where the secrets live.
pub trait SecretStore: Send + Sync {
    fn get(&self, kind: ConnectorKind) -> Result<Credential, SecretError>;
    fn set(&self, kind: ConnectorKind, credential: &Credential) -> Result<(), SecretError>;
    /// Removes the entry; `Ok` when there was none.
    fn delete(&self, kind: ConnectorKind) -> Result<(), SecretError>;
}

/// The account name of the entry.
pub fn account(kind: ConnectorKind) -> String {
    format!("connector.{}", kind.as_str())
}

/// The JSON of a [`Credential`] in the store; the type itself has no serde.
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Stored {
    ApiKey {
        key: String,
    },
    #[serde(rename_all = "camelCase")]
    OAuth {
        access: String,
        refresh: Option<String>,
        expires_at: Option<i64>,
    },
}

fn encode(credential: &Credential) -> String {
    let stored = match credential.clone() {
        Credential::ApiKey { key } => Stored::ApiKey { key },
        Credential::OAuth {
            access,
            refresh,
            expires_at,
        } => Stored::OAuth {
            access,
            refresh,
            expires_at,
        },
    };
    serde_json::to_string(&stored).expect("a credential is plain JSON")
}

fn decode(text: &str) -> Result<Credential, SecretError> {
    // serde's message could quote the value: never pass it on.
    let stored: Stored = serde_json::from_str(text)
        .map_err(|_| SecretError::Store("Запись ключа повреждена".to_owned()))?;
    Ok(match stored {
        Stored::ApiKey { key } => Credential::ApiKey { key },
        Stored::OAuth {
            access,
            refresh,
            expires_at,
        } => Credential::OAuth {
            access,
            refresh,
            expires_at,
        },
    })
}

/// Keychain / Credential Manager.
pub struct KeyringStore;

impl KeyringStore {
    fn entry(kind: ConnectorKind) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(SERVICE, &account(kind)).map_err(store_error)
    }
}

/// `keyring`'s errors carry no secret, but its `BadEncoding` holds the
/// bytes read: say only what kind of failure it was.
fn store_error(error: keyring::Error) -> SecretError {
    match error {
        keyring::Error::NoEntry => SecretError::Missing,
        keyring::Error::BadEncoding(_) => SecretError::Store("Запись ключа повреждена".to_owned()),
        other => SecretError::Store(other.to_string()),
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, kind: ConnectorKind) -> Result<Credential, SecretError> {
        let text = Self::entry(kind)?.get_password().map_err(store_error)?;
        decode(&text)
    }

    fn set(&self, kind: ConnectorKind, credential: &Credential) -> Result<(), SecretError> {
        Self::entry(kind)?
            .set_password(&encode(credential))
            .map_err(store_error)
    }

    fn delete(&self, kind: ConnectorKind) -> Result<(), SecretError> {
        match Self::entry(kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(store_error(error)),
        }
    }
}

/// In memory, with failures on demand: the tests' store.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
    fail_writes: Mutex<bool>,
}

#[cfg(test)]
impl MemoryStore {
    /// Every `set` fails from now on (the OS refused the write).
    pub fn fail_writes(&self, fail: bool) {
        *self
            .fail_writes
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = fail;
    }

    /// The raw entries: what the OS store would hold.
    pub fn raw(&self) -> HashMap<String, String> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, kind: ConnectorKind) -> Result<Credential, SecretError> {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        decode(entries.get(&account(kind)).ok_or(SecretError::Missing)?)
    }

    fn set(&self, kind: ConnectorKind, credential: &Credential) -> Result<(), SecretError> {
        if *self
            .fail_writes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
        {
            return Err(SecretError::Store(
                "Доступ к связке ключей запрещён".to_owned(),
            ));
        }
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(account(kind), encode(credential));
        Ok(())
    }

    fn delete(&self, kind: ConnectorKind) -> Result<(), SecretError> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&account(kind));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ol_api_Zx81QpLw0rTy7uVb5nMk3HsAa9Fd";

    fn key() -> Credential {
        Credential::ApiKey {
            key: KEY.to_owned(),
        }
    }

    #[test]
    fn writes_reads_and_deletes() {
        let store = MemoryStore::default();
        assert_eq!(store.get(ConnectorKind::Outline), Err(SecretError::Missing));
        store.set(ConnectorKind::Outline, &key()).unwrap();
        assert_eq!(store.get(ConnectorKind::Outline).unwrap(), key());
        assert_eq!(
            store.raw().keys().collect::<Vec<_>>(),
            [&"connector.outline".to_owned()]
        );
        // Another connector's entry is another entry.
        assert_eq!(store.get(ConnectorKind::GitHub), Err(SecretError::Missing));
        store.delete(ConnectorKind::Outline).unwrap();
        assert_eq!(store.get(ConnectorKind::Outline), Err(SecretError::Missing));
        // Deleting what is not there is fine.
        store.delete(ConnectorKind::Outline).unwrap();
    }

    #[test]
    fn a_refused_write_keeps_nothing() {
        let store = MemoryStore::default();
        store.fail_writes(true);
        let error = store.set(ConnectorKind::Outline, &key()).unwrap_err();
        assert!(!error.to_string().contains(KEY));
        assert!(store.raw().is_empty());
    }

    #[test]
    fn the_stored_value_is_json_of_the_credential() {
        assert_eq!(
            encode(&key()),
            format!(r#"{{"type":"apiKey","key":"{KEY}"}}"#)
        );
        let oauth = Credential::OAuth {
            access: "a".repeat(20),
            refresh: Some("r".repeat(20)),
            expires_at: Some(5),
        };
        assert_eq!(decode(&encode(&oauth)).unwrap(), oauth);
        let broken = decode(&format!("{{\"key\":\"{KEY}\"")).unwrap_err();
        assert!(!broken.to_string().contains(KEY), "{broken}");
    }

    #[test]
    fn debug_masks_the_key() {
        let debug = format!("{:?}", key());
        assert!(!debug.contains(KEY), "{debug}");
        assert!(!debug.contains("Zx81"), "{debug}");
        assert_eq!(debug, "ApiKey(***a9Fd)");
        let short = format!(
            "{:?}",
            Credential::ApiKey {
                key: "abc".to_owned()
            }
        );
        assert_eq!(short, "ApiKey(***)");
        let oauth = format!(
            "{:?}",
            Credential::OAuth {
                access: "secret-access-token".to_owned(),
                refresh: Some("secret-refresh-token".to_owned()),
                expires_at: None,
            }
        );
        assert!(!oauth.contains("secret"), "{oauth}");
    }
}
