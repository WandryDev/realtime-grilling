//! A project's sync with a connector (design.md, decision 4), the same for
//! every [`SourceProvider`]:
//!
//! 1. reads the selection, the connection and the secret; without a
//!    connection the sync state says «Outline отключён» and nothing else
//!    changes;
//! 2. `resolve` expands the selection; items the service no longer has turn
//!    `unavailable`; over [`MAX_DOCUMENTS`] the most recently changed stay;
//! 3. compares with the project's sources by external id and version and
//!    `fetch`es only the new and changed documents;
//! 4. applies everything in one transaction, then sends one `DataChanged`:
//!    the project's when its sources changed (its brief may be outdated),
//!    else `connectorSelections` (only the sync state moved). Nothing
//!    changed in the service: no source row is touched, the brief's
//!    fingerprint stays;
//! 5. `Unauthorized` breaks the connection and changes no source; a network
//!    failure is written only to the sync state and the connection's
//!    attempt.
//!
//! One sync per project and connector: a second request joins the running
//! one ([`SyncFlights`]); [`sync_fresh`] (after the selection changed)
//! waits for it and starts a new one. The sync runs in its own task: a
//! caller that stops waiting (the 30 s before a call) leaves it running.
//! Disconnecting or reconnecting the connector cancels its syncs
//! ([`SyncFlights::cancel`]): whatever they wait for (ClickUp's rate limit)
//! ends with them, their place is free at once (the project is no longer
//! «syncing»), and nothing they would still write lands: a sync of the old
//! key never marks the new connection broken.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use tauri::{AppHandle, Manager, Runtime};
use tokio::{sync::watch, task::AbortHandle};

use super::{
    ConnectorError, ConnectorKind, Connectors, DocText, ErrorKind, MAX_DOCUMENTS, RemoteDoc,
    SelectionItem, Session, secrets::SecretError,
};
use crate::{
    error::{CommandError, CommandResult},
    events::{DataChanged, EventSink},
    projects::{sha256_hex, sources::extract::Extraction},
    storage::{
        Storage,
        connectors::{self as stored, StoredItem},
        now_ms, projects,
        sources::{self, ConnectorChanges, ConnectorDocument, ConnectorSource},
    },
};

/// What the connectors' work needs from the app; tests give their own.
pub trait ConnectorHost: EventSink + Send + Sync + 'static {
    fn storage(&self) -> Option<&Storage>;
    fn connectors(&self) -> Option<&Connectors>;
}

impl<R: Runtime> ConnectorHost for AppHandle<R> {
    fn storage(&self) -> Option<&Storage> {
        self.try_state::<Storage>().map(|state| state.inner())
    }

    fn connectors(&self) -> Option<&Connectors> {
        self.try_state::<Connectors>().map(|state| state.inner())
    }
}

pub(super) fn parts<H: ConnectorHost>(host: &H) -> CommandResult<(&Storage, &Connectors)> {
    let storage = host
        .storage()
        .ok_or_else(|| CommandError::storage("Хранилище ещё не открыто"))?;
    let connectors = host
        .connectors()
        .ok_or_else(|| CommandError::storage("Коннекторы ещё не готовы"))?;
    Ok((storage, connectors))
}

/// How a sync ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncOutcome {
    /// The service answered. `changed`: the project's sources changed.
    Synced { changed: bool, skipped: u32 },
    /// Nothing is selected: the connector's sources went, if there were any.
    Empty { changed: bool },
    /// The connector is not connected: nothing changed.
    Disconnected,
    /// The service failed: no source changed.
    Failed { kind: ErrorKind, message: String },
}

pub type SyncResult = Result<SyncOutcome, CommandError>;

type Key = (String, ConnectorKind);

/// A sync's cancellation: once set, none of its writes lands.
#[derive(Clone, Default)]
struct Cancelled(Arc<AtomicBool>);

impl Cancelled {
    fn set(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Checked inside each write's transaction: the writes are one after
    /// another, so a write that runs after [`SyncFlights::cancel`] (a
    /// reconnect saved after it) changes nothing.
    fn check(&self) -> CommandResult<()> {
        if self.0.load(Ordering::SeqCst) {
            Err(CommandError::storage("Синхронизация прервана"))
        } else {
            Ok(())
        }
    }
}

/// A running sync: its result to wait for and its task to cancel.
struct Running {
    /// Tells this sync's place from a later one's.
    id: u64,
    result: watch::Receiver<Option<SyncResult>>,
    task: AbortHandle,
    cancelled: Cancelled,
}

/// The running syncs.
#[derive(Default)]
pub struct SyncFlights {
    running: Mutex<HashMap<Key, Running>>,
    next: AtomicU64,
}

impl SyncFlights {
    fn state(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Running>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn is_running(&self, project_id: &str, kind: ConnectorKind) -> bool {
        self.state().contains_key(&(project_id.to_owned(), kind))
    }

    /// Cancels the connector's running syncs (it was disconnected or
    /// reconnected): their tasks stop wherever they wait, their writes
    /// still to come change nothing, and the callers waiting for them get
    /// an error. Their places are freed now: the next read sees no sync,
    /// and the next request starts a new one.
    pub fn cancel(&self, kind: ConnectorKind) {
        self.state().retain(|key, running| {
            if key.1 != kind {
                return true;
            }
            running.cancelled.set();
            running.task.abort();
            false
        });
    }
}

async fn wait(mut receiver: watch::Receiver<Option<SyncResult>>) -> SyncResult {
    match receiver.wait_for(Option::is_some).await {
        Ok(result) => result.clone().unwrap_or(Ok(SyncOutcome::Disconnected)),
        Err(_) => Err(CommandError::storage("Синхронизация прервана")),
    }
}

/// Runs `future` on the current Tokio runtime, else on Tauri's.
pub(crate) fn spawn_detached(future: impl Future<Output = ()> + Send + 'static) {
    spawn_abortable(future);
}

/// [`spawn_detached`], with a handle to cancel the task.
fn spawn_abortable(future: impl Future<Output = ()> + Send + 'static) -> AbortHandle {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(future).abort_handle()
    } else {
        tauri::async_runtime::spawn(future).inner().abort_handle()
    }
}

/// A running sync's place in [`SyncFlights`]. Finishing sends the result;
/// dropped without it (the sync panicked) the place is freed all the same
/// and the waiting callers get an error, so the next request starts anew.
struct Flight<H: ConnectorHost> {
    host: Arc<H>,
    key: Key,
    id: u64,
    cancelled: Cancelled,
    sender: Option<watch::Sender<Option<SyncResult>>>,
}

impl<H: ConnectorHost> Flight<H> {
    fn finish(mut self, result: SyncResult) {
        self.leave();
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(Some(result));
        }
    }

    /// Frees the place unless it was freed already (cancelled) and taken
    /// by a newer sync.
    fn leave(&self) {
        if let Some(connectors) = self.host.connectors() {
            let mut flights = connectors.flights.state();
            if flights
                .get(&self.key)
                .is_some_and(|running| running.id == self.id)
            {
                flights.remove(&self.key);
            }
        }
    }
}

impl<H: ConnectorHost> Drop for Flight<H> {
    fn drop(&mut self) {
        if self.sender.is_some() {
            self.leave();
            // The sender goes after the place: no request joins a closed
            // channel.
            self.sender = None;
        }
    }
}

/// Syncs the project's selection in the connector, or joins the sync that
/// runs.
pub async fn sync_project<H: ConnectorHost>(
    host: &Arc<H>,
    project_id: &str,
    kind: ConnectorKind,
) -> SyncResult {
    let (_, connectors) = parts(host.as_ref())?;
    let key = (project_id.to_owned(), kind);
    let receiver = {
        let mut flights = connectors.flights.state();
        if let Some(running) = flights.get(&key) {
            running.result.clone()
        } else {
            let (sender, receiver) = watch::channel(None);
            let id = connectors.flights.next.fetch_add(1, Ordering::Relaxed);
            let cancelled = Cancelled::default();
            let flight = Flight {
                host: Arc::clone(host),
                key: key.clone(),
                id,
                cancelled: cancelled.clone(),
                sender: Some(sender),
            };
            // Spawned under the lock: the task can't leave its place
            // before the place has its handle.
            let task = spawn_abortable(async move {
                let result = run(
                    flight.host.as_ref(),
                    &flight.key.0,
                    flight.key.1,
                    &flight.cancelled,
                )
                .await;
                flight.finish(result);
            });
            flights.insert(
                key,
                Running {
                    id,
                    result: receiver.clone(),
                    task,
                    cancelled,
                },
            );
            receiver
        }
    };
    wait(receiver).await
}

/// After the selection changed: a running sync read the old one, so this
/// waits for it and then syncs again (or joins a sync started after it).
pub async fn sync_fresh<H: ConnectorHost>(
    host: &Arc<H>,
    project_id: &str,
    kind: ConnectorKind,
) -> SyncResult {
    let (_, connectors) = parts(host.as_ref())?;
    let running = connectors
        .flights
        .state()
        .get(&(project_id.to_owned(), kind))
        .map(|running| running.result.clone());
    if let Some(running) = running {
        let _ = wait(running).await;
    }
    sync_project(host, project_id, kind).await
}

/// Syncs every connector the project has a selection in or sources of,
/// one after another (before a call; «Обновить» without a connector).
pub async fn sync_all<H: ConnectorHost>(
    host: &Arc<H>,
    project_id: &str,
) -> CommandResult<Vec<(ConnectorKind, SyncResult)>> {
    let (storage, _) = parts(host.as_ref())?;
    let id = project_id.to_owned();
    let kinds = storage
        .read(move |db| stored::kinds_of_project(db, &id))
        .await?;
    let mut results = Vec::new();
    for kind in kinds {
        results.push((kind, sync_project(host, project_id, kind).await));
    }
    Ok(results)
}

/// What a sync read before calling the service.
struct Start {
    items: Vec<StoredItem>,
    connection: Option<stored::StoredConnection>,
    existing: Vec<ConnectorSource>,
}

async fn run<H: ConnectorHost>(
    host: &H,
    project_id: &str,
    kind: ConnectorKind,
    cancelled: &Cancelled,
) -> SyncResult {
    let (storage, connectors) = parts(host)?;
    let id = project_id.to_owned();
    let start = storage
        .read(move |db| {
            projects::exists(db, &id)?;
            Ok(Start {
                items: stored::selection(db, &id, kind)?,
                connection: stored::connection(db, kind)?,
                existing: sources::connector_sources(db, &id, kind)?,
            })
        })
        .await?;

    if start.items.is_empty() {
        return clear(host, storage, project_id, kind, &start.existing, cancelled).await;
    }
    let (Some(connection), Some(provider)) = (start.connection, connectors.provider(kind)) else {
        let message = format!("{} отключён", kind.label());
        let failure = Failure {
            error_kind: ErrorKind::Disconnected,
            message: &message,
            breaks: false,
        };
        record_failure(host, storage, project_id, kind, &failure, cancelled).await?;
        return Ok(SyncOutcome::Disconnected);
    };
    let credential = match connectors.secrets.get(kind) {
        Ok(credential) => credential,
        Err(error) => {
            let (error_kind, message, breaks) = secret_failure(&error);
            let failure = Failure {
                error_kind,
                message: &message,
                breaks,
            };
            return fail_with(host, storage, project_id, kind, &failure, cancelled).await;
        }
    };
    let session = Session {
        host: connection.account.host.clone(),
        credential,
        team: Some(connection.account.team_id.clone()),
    };
    // A selection made with another team of the service stays as it is:
    // `unavailable`, and nothing is removed until the manager decides.
    let team = connection.account.team_id.clone();
    let (active, foreign): (Vec<StoredItem>, Vec<StoredItem>) = start
        .items
        .into_iter()
        .partition(|item| item.account_ref == team);
    let selection: Vec<SelectionItem> = active.into_iter().map(|item| item.item).collect();

    let resolved = match provider.resolve(&session, &selection).await {
        Ok(resolved) => resolved,
        Err(error) => return fail(host, storage, project_id, kind, &error, cancelled).await,
    };
    let (docs, skipped) = within_limit(resolved.docs);
    let known: HashMap<&str, &ConnectorSource> = start
        .existing
        .iter()
        .map(|source| (source.external_id.as_str(), source))
        .collect();
    let wanted: Vec<RemoteDoc> = docs
        .iter()
        .filter(|doc| {
            known
                .get(doc.external_id.as_str())
                .is_none_or(|source| source.version != doc.version)
        })
        .cloned()
        .collect();
    let texts = if wanted.is_empty() {
        Vec::new()
    } else {
        match provider.fetch(&session, &wanted).await {
            Ok(texts) => texts,
            Err(error) => return fail(host, storage, project_id, kind, &error, cancelled).await,
        }
    };

    // Documents of another team's items stay until the manager decides;
    // the connected team's ones go when nothing brings them any more.
    let kept_teams: HashSet<&str> = foreign
        .iter()
        .map(|item| item.account_ref.as_str())
        .collect();
    let keep: HashSet<&str> = docs.iter().map(|doc| doc.external_id.as_str()).collect();
    let changes = ConnectorChanges {
        account_ref: team.clone(),
        upserts: documents(&wanted, texts),
        removals: start
            .existing
            .iter()
            .filter(|source| !keep.contains(source.external_id.as_str()))
            .filter(|source| !kept_teams.contains(source.account_ref.as_str()))
            .map(|source| source.external_id.clone())
            .collect(),
    };
    let mut unavailable = resolved.unavailable;
    unavailable.extend(foreign.into_iter().map(|item| item.item.external_id));

    let (id, cancelled) = (project_id.to_owned(), cancelled.clone());
    let changed = storage
        .write(host, move |db| {
            cancelled.check()?;
            let now = now_ms();
            let changed = sources::apply_connector_changes(db, &id, kind, &changes, now)?;
            stored::set_item_statuses(db, &id, kind, &unavailable, now)?;
            stored::record_sync_ok(db, &id, kind, skipped, now)?;
            let mut events = vec![if changed {
                projects::changed(&id)
            } else {
                stored::selection_changed(&id, kind)
            }];
            events.extend(stored::record_ok(db, kind, None, now)?);
            Ok((changed, events))
        })
        .await?;
    Ok(SyncOutcome::Synced { changed, skipped })
}

/// Nothing selected: the connector's sources of the project go.
async fn clear<H: ConnectorHost>(
    host: &H,
    storage: &Storage,
    project_id: &str,
    kind: ConnectorKind,
    existing: &[ConnectorSource],
    cancelled: &Cancelled,
) -> SyncResult {
    let (id, cancelled) = (project_id.to_owned(), cancelled.clone());
    let changes = ConnectorChanges {
        removals: existing
            .iter()
            .map(|source| source.external_id.clone())
            .collect(),
        ..ConnectorChanges::default()
    };
    let changed = storage
        .write(host, move |db| {
            cancelled.check()?;
            let changed = sources::apply_connector_changes(db, &id, kind, &changes, now_ms())?;
            stored::clear_sync_state(db, &id, kind)?;
            let events: Vec<DataChanged> = if changed {
                vec![projects::changed(&id)]
            } else {
                Vec::new()
            };
            Ok((changed, events))
        })
        .await?;
    Ok(SyncOutcome::Empty { changed })
}

/// The most recently changed [`MAX_DOCUMENTS`] and how many were left out.
fn within_limit(mut docs: Vec<RemoteDoc>) -> (Vec<RemoteDoc>, u32) {
    if docs.len() <= MAX_DOCUMENTS {
        return (docs, 0);
    }
    let skipped = u32::try_from(docs.len() - MAX_DOCUMENTS).unwrap_or(u32::MAX);
    docs.sort_by(|a, b| b.version.cmp(&a.version));
    docs.truncate(MAX_DOCUMENTS);
    (docs, skipped)
}

/// The fetched texts as rows: normalized and capped like a file's text; a
/// document with only a title is «нет текста».
fn documents(wanted: &[RemoteDoc], texts: Vec<DocText>) -> Vec<ConnectorDocument> {
    let mut texts: HashMap<String, String> = texts
        .into_iter()
        .map(|text| (text.external_id, text.text))
        .collect();
    wanted
        .iter()
        .filter_map(|doc| {
            let text = texts.remove(&doc.external_id)?;
            let read = Extraction::ready(text, false);
            Some(ConnectorDocument {
                external_id: doc.external_id.clone(),
                title: doc.title.clone(),
                url: doc.url.clone(),
                version: doc.version.clone(),
                sha256: sha256_hex(read.text.as_bytes()),
                status: read.status,
                text: read.text,
                text_chars: read.text_chars,
                truncated: read.truncated,
                error: read.error,
            })
        })
        .collect()
}

pub(super) fn secret_message(error: &SecretError) -> String {
    match error {
        SecretError::Missing => "Ключ не найден в Keychain: обновите ключ".to_owned(),
        SecretError::Store(why) => format!("Нет доступа к Keychain: {why}"),
    }
}

/// What a failed read of the secret means for the connection: a missing
/// key breaks it («Обновить ключ»); a Keychain that refused (locked, the
/// prompt denied) does not: the key may well be there and still valid.
pub(super) fn secret_failure(error: &SecretError) -> (ErrorKind, String, bool) {
    match error {
        SecretError::Missing => (ErrorKind::Unauthorized, secret_message(error), true),
        SecretError::Store(_) => (ErrorKind::Other, secret_message(error), false),
    }
}

/// What to show for a failed call of the service.
pub(super) fn failure_message(kind: ConnectorKind, error: &ConnectorError) -> String {
    match error {
        ConnectorError::Unauthorized if kind == ConnectorKind::ClickUp => {
            "Токен больше не подходит".to_owned()
        }
        ConnectorError::Unauthorized => "Ключ больше не подходит".to_owned(),
        ConnectorError::Forbidden => format!("Нет доступа к {}", kind.label()),
        ConnectorError::NotFound => "Не найдено".to_owned(),
        ConnectorError::Unreachable(why) | ConnectorError::Other(why) => why.clone(),
    }
}

/// What a failed sync writes.
struct Failure<'a> {
    error_kind: ErrorKind,
    message: &'a str,
    /// The service refused the secret: the connection breaks.
    breaks: bool,
}

async fn fail<H: ConnectorHost>(
    host: &H,
    storage: &Storage,
    project_id: &str,
    kind: ConnectorKind,
    error: &ConnectorError,
    cancelled: &Cancelled,
) -> SyncResult {
    let message = failure_message(kind, error);
    let failure = Failure {
        error_kind: error.kind(),
        message: &message,
        breaks: error.refuses_secret(),
    };
    fail_with(host, storage, project_id, kind, &failure, cancelled).await
}

async fn fail_with<H: ConnectorHost>(
    host: &H,
    storage: &Storage,
    project_id: &str,
    kind: ConnectorKind,
    failure: &Failure<'_>,
    cancelled: &Cancelled,
) -> SyncResult {
    record_failure(host, storage, project_id, kind, failure, cancelled).await?;
    Ok(SyncOutcome::Failed {
        kind: failure.error_kind,
        message: failure.message.to_owned(),
    })
}

/// The sync state of the project and the connection's last attempt.
async fn record_failure<H: ConnectorHost>(
    host: &H,
    storage: &Storage,
    project_id: &str,
    kind: ConnectorKind,
    failure: &Failure<'_>,
    cancelled: &Cancelled,
) -> CommandResult<()> {
    let (id, message, cancelled) = (
        project_id.to_owned(),
        failure.message.to_owned(),
        cancelled.clone(),
    );
    let (error_kind, breaks) = (failure.error_kind, failure.breaks);
    storage
        .write(host, move |db| {
            cancelled.check()?;
            let now = now_ms();
            let mut events = stored::record_sync_failure(db, &id, kind, error_kind, &message, now)?;
            if error_kind != ErrorKind::Disconnected {
                events.extend(stored::record_failure(
                    db, kind, error_kind, &message, breaks, now,
                )?);
            }
            Ok(((), events))
        })
        .await
}
