//! Connecting, disconnecting, checking connections and a project's
//! selection (`specs/connectors`; design.md, decisions 2 and 6). The
//! commands are thin wrappers around these.
//!
//! Connecting checks first, then writes the secret to the OS store, then
//! the connection's row; when the row can't be written the secret is put
//! back as it was. A refusal of the service is an answer
//! ([`ConnectOutcome::Rejected`]), not an error. No reply carries a secret.

use std::{sync::Arc, time::Duration};

use serde::Serialize;
use specta::Type;

use super::{
    Account, AuthMethod, BrowseNode, Capability, ConnectorError, ConnectorKind, Credential,
    ErrorKind, ExternalRef, MAX_DOCUMENTS, SelectionItem, SelectionItemKind, Session,
    outline::address,
    sync::{self, ConnectorHost, failure_message, parts, secret_message},
};
use crate::{
    error::{CommandError, CommandResult},
    storage::{
        connectors::{self as stored, ConnectionStatus, ItemStatus, StoredConnection, SyncState},
        now_ms, projects,
    },
};

/// How long after the start the connections are checked in the background.
pub const VERIFY_AFTER_START: Duration = Duration::from_secs(5);

/// The state of a connector as the screens show it. «Проверка» is the
/// screens' own while a connect runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectorStatus {
    Disconnected,
    Connected,
    /// The service refused the secret: «Обновить ключ».
    Error,
}

/// A connector of the catalog with its connection (`connectors_list`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorView {
    pub kind: ConnectorKind,
    pub auth: AuthMethod,
    pub capabilities: Vec<Capability>,
    /// `false`: «скоро», never connected.
    pub available: bool,
    pub status: ConnectorStatus,
    /// Whose secret it is (Outline: the address, the team, the user).
    pub account: Option<Account>,
    /// Milliseconds since the Unix epoch, UTC.
    pub connected_at: Option<i64>,
    /// The last time the service answered.
    pub last_ok_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    /// The last failure; with `connected` and `unreachable`: «не удалось
    /// обновить», the connection stands.
    pub error_kind: Option<ErrorKind>,
    pub error: Option<String>,
}

impl ConnectorView {
    fn of(kind: ConnectorKind, connection: Option<StoredConnection>) -> Self {
        let descriptor = kind.descriptor();
        let mut view = Self {
            kind,
            auth: descriptor.auth,
            capabilities: descriptor.capabilities.to_vec(),
            available: descriptor.available,
            status: ConnectorStatus::Disconnected,
            account: None,
            connected_at: None,
            last_ok_at: None,
            last_attempt_at: None,
            error_kind: None,
            error: None,
        };
        if let Some(connection) = connection {
            view.status = match connection.status {
                ConnectionStatus::Connected => ConnectorStatus::Connected,
                ConnectionStatus::Error => ConnectorStatus::Error,
            };
            view.account = Some(connection.account);
            view.connected_at = Some(connection.connected_at);
            view.last_ok_at = connection.last_ok_at;
            view.last_attempt_at = connection.last_attempt_at;
            view.error_kind = connection.error_kind;
            view.error = connection.error;
        }
        view
    }
}

/// The field a refusal belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RejectedField {
    Host,
    Key,
}

/// `connector_connect_api_key`: connected, or refused with what to show at
/// which field (nothing was saved).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectOutcome {
    Connected(ConnectorView),
    Rejected {
        field: RejectedField,
        reason: String,
    },
}

/// A selection item with its state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionItemView {
    pub item_kind: SelectionItemKind,
    pub external_id: String,
    pub title: String,
    pub url: Option<String>,
    pub status: ItemStatus,
    /// Picked with another team of the service than the connected one:
    /// `unavailable`, and nothing of it is removed.
    pub other_account: bool,
}

/// A project's selection in a connector and its last sync
/// (`connector_selection_get`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConnectorView {
    pub project_id: String,
    pub kind: ConnectorKind,
    /// The connector is connected (not «отключён»; it may be in error).
    pub connected: bool,
    pub items: Vec<SelectionItemView>,
    /// `null` before the first sync.
    pub sync: Option<SyncState>,
    /// A sync of it runs now.
    pub syncing: bool,
}

/* Catalog */

pub async fn list<H: ConnectorHost>(host: &H) -> CommandResult<Vec<ConnectorView>> {
    let (storage, _) = parts(host)?;
    let connections = storage.read(stored::connections).await?;
    Ok(ConnectorKind::ALL
        .into_iter()
        .map(|kind| {
            let connection = connections.iter().find(|row| row.kind == kind).cloned();
            ConnectorView::of(kind, connection)
        })
        .collect())
}

fn available(kind: ConnectorKind) -> CommandResult<()> {
    if kind.descriptor().available {
        Ok(())
    } else {
        Err(CommandError::invalid(format!(
            "{} пока нельзя подключить",
            kind.label()
        )))
    }
}

/* Connect and disconnect */

fn rejected(field: RejectedField, reason: impl Into<String>) -> ConnectOutcome {
    ConnectOutcome::Rejected {
        field,
        reason: reason.into(),
    }
}

/// Connects (or reconnects) a connector that signs in with a key.
pub async fn connect_api_key<H: ConnectorHost>(
    host: &Arc<H>,
    kind: ConnectorKind,
    address: &str,
    key: &str,
) -> CommandResult<ConnectOutcome> {
    available(kind)?;
    let (storage, connectors) = parts(host.as_ref())?;
    let AuthMethod::ApiKey { host: needs_host } = kind.descriptor().auth else {
        return Err(CommandError::invalid(format!(
            "{} подключается не по ключу",
            kind.label()
        )));
    };
    let origin = if needs_host {
        match address::normalize(address) {
            Ok(origin) => Some(origin),
            Err(reason) => return Ok(rejected(RejectedField::Host, reason)),
        }
    } else {
        None
    };
    let key = key.trim();
    if key.is_empty() {
        return Ok(rejected(RejectedField::Key, "Введите ключ"));
    }
    let provider = connectors
        .provider(kind)
        .ok_or_else(|| CommandError::invalid(format!("{} пока нельзя подключить", kind.label())))?;
    let session = Session {
        host: origin,
        credential: Credential::ApiKey {
            key: key.to_owned(),
        },
    };
    let account = match provider.verify(&session).await {
        Ok(account) => account,
        Err(ConnectorError::Unauthorized) => {
            return Ok(rejected(RejectedField::Key, "Ключ не подошёл"));
        }
        Err(ConnectorError::Forbidden) => {
            return Ok(rejected(RejectedField::Key, "У ключа нет доступа"));
        }
        Err(error) => {
            return Ok(rejected(RejectedField::Host, failure_message(kind, &error)));
        }
    };

    // The OS store first: what was there before comes back if the row
    // can't be written.
    let previous = connectors.secrets.get(kind).ok();
    connectors
        .secrets
        .set(kind, &session.credential)
        .map_err(|error| {
            CommandError::external(format!("Не удалось сохранить ключ в Keychain: {error}"))
        })?;
    let saved_account = account.clone();
    let saved = storage
        .write(host.as_ref(), move |db| {
            stored::save_connected(db, kind, &saved_account, now_ms())
        })
        .await;
    let connection = match saved {
        Ok(connection) => connection,
        Err(error) => {
            let restored = match &previous {
                Some(previous) => connectors.secrets.set(kind, previous),
                None => connectors.secrets.delete(kind),
            };
            if let Err(restore) = restored {
                eprintln!(
                    "grill: could not roll back the {} secret: {restore}",
                    kind.as_str()
                );
            }
            return Err(error);
        }
    };
    resync_selections(host, kind);
    Ok(ConnectOutcome::Connected(ConnectorView::of(
        kind,
        Some(connection),
    )))
}

/// The projects' selections in the connector sync again (after a
/// connect), in the background.
fn resync_selections<H: ConnectorHost>(host: &Arc<H>, kind: ConnectorKind) {
    let host = Arc::clone(host);
    let run = async move {
        let Ok((storage, _)) = parts(host.as_ref()) else {
            return;
        };
        let Ok(projects) = storage
            .read(move |db| stored::projects_with_selection(db, kind))
            .await
        else {
            return;
        };
        for project in projects {
            let _ = sync::sync_project(&host, &project, kind).await;
        }
    };
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(run);
    } else {
        tauri::async_runtime::spawn(run);
    }
}

/// Removes the secret, then the connection. The projects' selections and
/// sources stay with their last text.
pub async fn disconnect<H: ConnectorHost>(host: &H, kind: ConnectorKind) -> CommandResult<()> {
    let (storage, connectors) = parts(host)?;
    connectors.secrets.delete(kind).map_err(|error| {
        CommandError::external(format!("Не удалось удалить ключ из Keychain: {error}"))
    })?;
    storage
        .write(host, move |db| {
            let (_, events) = stored::delete_connection(db, kind)?;
            Ok(((), events))
        })
        .await
}

/* Checking */

/// The connection and its secret, or why the service can't be called.
async fn session_of<H: ConnectorHost>(
    host: &H,
    kind: ConnectorKind,
) -> CommandResult<(StoredConnection, Result<Session, String>)> {
    let (storage, connectors) = parts(host)?;
    let connection = storage
        .read(move |db| stored::connection(db, kind))
        .await?
        .ok_or_else(|| CommandError::invalid(format!("{} не подключён", kind.label())))?;
    let session = connectors
        .secrets
        .get(kind)
        .map(|credential| Session {
            host: connection.account.host.clone(),
            credential,
        })
        .map_err(|error| secret_message(&error));
    Ok((connection, session))
}

/// Writes what a call of the service showed about the connection.
async fn record<H: ConnectorHost>(
    host: &H,
    kind: ConnectorKind,
    outcome: Result<Option<&Account>, (ErrorKind, String, bool)>,
) -> CommandResult<()> {
    let (storage, _) = parts(host)?;
    let outcome = outcome.map(|account| account.cloned());
    storage
        .write(host, move |db| {
            let now = now_ms();
            let events = match &outcome {
                Ok(account) => stored::record_ok(db, kind, account.as_ref(), now)?,
                Err((error_kind, message, breaks)) => {
                    stored::record_failure(db, kind, *error_kind, message, *breaks, now)?
                }
            };
            Ok(((), events))
        })
        .await
}

fn failure(kind: ConnectorKind, error: &ConnectorError) -> (ErrorKind, String, bool) {
    (
        error.kind(),
        failure_message(kind, error),
        error.refuses_secret(),
    )
}

/// Checks one connection with the service: a refused secret breaks it, a
/// network failure only marks «не удалось обновить».
pub async fn verify<H: ConnectorHost>(host: &H, kind: ConnectorKind) -> CommandResult<()> {
    let (_, connectors) = parts(host)?;
    let Some(provider) = connectors.provider(kind) else {
        return Ok(());
    };
    let (_, session) = session_of(host, kind).await?;
    let session = match session {
        Ok(session) => session,
        Err(message) => {
            return record(host, kind, Err((ErrorKind::Unauthorized, message, true))).await;
        }
    };
    match provider.verify(&session).await {
        Ok(account) => record(host, kind, Ok(Some(&account))).await,
        Err(error) => record(host, kind, Err(failure(kind, &error))).await,
    }
}

/// Every connection, after the start (in the background, never holding a
/// window).
pub async fn verify_all<H: ConnectorHost>(host: &H) -> CommandResult<()> {
    let (storage, _) = parts(host)?;
    let connections = storage.read(stored::connections).await?;
    for connection in connections {
        if let Err(error) = verify(host, connection.kind).await {
            eprintln!(
                "grill: could not check the {} connection: {error}",
                connection.kind.as_str()
            );
        }
    }
    Ok(())
}

/* Browsing and selection */

/// The picker's tree. A failed call is recorded on the connection and
/// answered `External` with what to show.
pub async fn browse<H: ConnectorHost>(
    host: &H,
    kind: ConnectorKind,
    parent: Option<ExternalRef>,
) -> CommandResult<Vec<BrowseNode>> {
    available(kind)?;
    let (_, connectors) = parts(host)?;
    let provider = connectors
        .provider(kind)
        .ok_or_else(|| CommandError::invalid(format!("{} пока нельзя подключить", kind.label())))?;
    let (_, session) = session_of(host, kind).await?;
    let session = match session {
        Ok(session) => session,
        Err(message) => {
            record(
                host,
                kind,
                Err((ErrorKind::Unauthorized, message.clone(), true)),
            )
            .await?;
            return Err(CommandError::external(message));
        }
    };
    match provider.browse(&session, parent.as_ref()).await {
        Ok(nodes) => {
            record(host, kind, Ok(None)).await?;
            Ok(nodes)
        }
        Err(error) => {
            let failed = failure(kind, &error);
            let message = failed.1.clone();
            // A missing node is the picker's business, not the connection's.
            if !matches!(error, ConnectorError::NotFound | ConnectorError::Forbidden) {
                record(host, kind, Err(failed)).await?;
            }
            Err(CommandError::external(message))
        }
    }
}

/// The project's selection in every connector that gives sources.
pub async fn selection_get<H: ConnectorHost>(
    host: &H,
    project_id: &str,
) -> CommandResult<Vec<ProjectConnectorView>> {
    let (storage, connectors) = parts(host)?;
    let id = project_id.to_owned();
    let kinds: Vec<ConnectorKind> = ConnectorKind::ALL
        .into_iter()
        .filter(|kind| {
            let descriptor = kind.descriptor();
            descriptor.available
                && descriptor
                    .capabilities
                    .contains(&Capability::ProjectSources)
        })
        .collect();
    let rows = storage
        .read(move |db| {
            projects::exists(db, &id)?;
            kinds
                .into_iter()
                .map(|kind| {
                    Ok((
                        kind,
                        stored::connection(db, kind)?,
                        stored::selection(db, &id, kind)?,
                        stored::sync_state(db, &id, kind)?,
                    ))
                })
                .collect::<CommandResult<Vec<_>>>()
        })
        .await?;
    Ok(rows
        .into_iter()
        .map(|(kind, connection, items, sync)| {
            view(
                project_id,
                kind,
                connection.as_ref(),
                items,
                sync,
                connectors,
            )
        })
        .collect())
}

fn view(
    project_id: &str,
    kind: ConnectorKind,
    connection: Option<&StoredConnection>,
    items: Vec<stored::StoredItem>,
    sync: Option<SyncState>,
    connectors: &super::Connectors,
) -> ProjectConnectorView {
    let team = connection.map(|connection| connection.account.team_id.as_str());
    ProjectConnectorView {
        project_id: project_id.to_owned(),
        kind,
        connected: connection.is_some(),
        items: items
            .into_iter()
            .map(|stored| {
                let other_account = team.is_some_and(|team| team != stored.account_ref);
                SelectionItemView {
                    item_kind: stored.item.item_kind,
                    external_id: stored.item.external_id,
                    title: stored.item.title,
                    url: stored.item.url,
                    status: if other_account {
                        ItemStatus::Unavailable
                    } else {
                        stored.status
                    },
                    other_account,
                }
            })
            .collect(),
        sync,
        syncing: connectors.flights.is_running(project_id, kind),
    }
}

/// Replaces the project's selection in the connector. A selection that
/// brings more than [`MAX_DOCUMENTS`] documents is `Invalid` and not saved;
/// when the service can't be asked the selection is saved and the sync
/// keeps the 200 most recently changed. The caller starts the sync
/// ([`sync::sync_fresh`]).
pub async fn selection_set<H: ConnectorHost>(
    host: &H,
    project_id: &str,
    kind: ConnectorKind,
    items: Vec<SelectionItem>,
) -> CommandResult<ProjectConnectorView> {
    available(kind)?;
    let (storage, connectors) = parts(host)?;
    let id = project_id.to_owned();
    storage.read(move |db| projects::exists(db, &id)).await?;
    let account_ref = if items.is_empty() {
        String::new()
    } else {
        let (connection, session) = session_of(host, kind).await?;
        if let (Ok(session), Some(provider)) = (session, connectors.provider(kind))
            && let Ok(resolved) = provider.resolve(&session, &items).await
            && resolved.docs.len() > MAX_DOCUMENTS
        {
            return Err(CommandError::invalid(format!(
                "Из {} в проект загружается не больше {MAX_DOCUMENTS} документов, а в выбранном \
                 {}. Выберите отдельные документы.",
                kind.label(),
                resolved.docs.len()
            )));
        }
        connection.account.team_id
    };
    let id = project_id.to_owned();
    storage
        .write(host, move |db| {
            let events = stored::replace_selection(db, &id, kind, &account_ref, &items, now_ms())?;
            Ok(((), events))
        })
        .await?;
    let mut views = selection_get(host, project_id).await?;
    let index = views
        .iter()
        .position(|view| view.kind == kind)
        .ok_or_else(|| CommandError::invalid(format!("{} не даёт источники", kind.label())))?;
    Ok(views.swap_remove(index))
}
