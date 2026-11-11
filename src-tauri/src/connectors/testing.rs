//! A fake Outline on 127.0.0.1 (HTTP/1.1, one request per connection) and
//! a host with an in-memory database and secret store: the connectors'
//! tests never reach the real network or Keychain.

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
};

use super::{
    ConnectorKind, Connectors, SelectionItem, SelectionItemKind, SourceProvider,
    outline::{OutlineConnector, client::Limits},
    secrets::MemoryStore,
    service::{self, ConnectOutcome},
    sync::{self, ConnectorHost, SyncResult},
};
use crate::{
    agent::claude_cli::Agent,
    events::{DataChanged, EventSink, testing::RecordingSink},
    projects::{
        brief::{
            BriefProgress,
            run::{AgentLookup, BriefHost, SyncLookup},
        },
        brief_inputs,
    },
    storage::{
        Storage,
        projects::{self, BriefState, ProjectCreate},
        sources::{self, ProjectSource},
    },
};

pub const KEY: &str = "ol_api_9fQ2xLmT7vRb4KcN8wYp3HsDa6Ue";
pub const TEAM: &str = "team-wandry";

pub fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/* The fake Outline */

#[derive(Debug, Clone)]
pub struct Doc {
    pub id: String,
    pub title: String,
    pub text: String,
    pub updated_at: String,
    pub parent: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Clone)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub forbidden: bool,
    pub docs: Vec<Doc>,
}

/// A request the fake got.
#[derive(Debug, Clone)]
pub struct Logged {
    pub method: String,
    pub body: Value,
    pub authorization: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug)]
pub struct State {
    pub key: String,
    pub team: (String, String),
    pub user: String,
    pub collections: Vec<Collection>,
    /// The next requests answered 429 with this `Retry-After`.
    pub rate_limited: u32,
    pub retry_after: &'static str,
    /// Accepts and never answers.
    pub stall: bool,
    /// Answers 503.
    pub down: bool,
    /// An HTML page, not Outline.
    pub html: bool,
    /// `documents.list` without `text` (an older Outline).
    pub list_without_text: bool,
    /// Waits before each answer.
    pub delay: Duration,
    pub log: Vec<Logged>,
    clock: u32,
}

impl State {
    /// A version later than every one before.
    pub fn tick(&mut self) -> String {
        self.clock += 1;
        let clock = self.clock;
        format!(
            "2026-01-01T{:02}:{:02}:{:02}.000Z",
            clock / 3600,
            clock / 60 % 60,
            clock % 60
        )
    }

    fn collection_mut(&mut self, id: &str) -> &mut Collection {
        self.collections
            .iter_mut()
            .find(|collection| collection.id == id)
            .expect("a collection of the fake")
    }

    /// A collection with `count` documents `<id>-1…`, each with text.
    pub fn add_collection(&mut self, id: &str, name: &str, count: usize) {
        self.collections.push(Collection {
            id: id.to_owned(),
            name: name.to_owned(),
            forbidden: false,
            docs: Vec::new(),
        });
        for index in 1..=count {
            self.add_doc(id, &format!("{id}-{index}"), None);
        }
    }

    pub fn add_doc(&mut self, collection: &str, id: &str, parent: Option<&str>) {
        let updated_at = self.tick();
        self.collection_mut(collection).docs.push(Doc {
            id: id.to_owned(),
            title: format!("Документ {id}"),
            text: format!("Текст документа {id}."),
            updated_at,
            parent: parent.map(str::to_owned),
            archived: false,
        });
    }

    pub fn doc_mut(&mut self, id: &str) -> &mut Doc {
        self.collections
            .iter_mut()
            .flat_map(|collection| collection.docs.iter_mut())
            .find(|doc| doc.id == id)
            .expect("a document of the fake")
    }

    /// The document gets new text and a new version.
    pub fn edit(&mut self, id: &str, text: &str) {
        let version = self.tick();
        let doc = self.doc_mut(id);
        doc.text = text.to_owned();
        doc.updated_at = version;
    }

    pub fn archive(&mut self, id: &str) {
        let version = self.tick();
        let doc = self.doc_mut(id);
        doc.archived = true;
        doc.updated_at = version;
    }

    pub fn delete_collection(&mut self, id: &str) {
        self.collections.retain(|collection| collection.id != id);
    }

    pub fn requests(&self, method: &str) -> usize {
        self.log
            .iter()
            .filter(|logged| logged.method == method)
            .count()
    }
}

pub struct FakeOutline {
    pub origin: String,
    state: Arc<Mutex<State>>,
}

impl FakeOutline {
    pub fn start() -> Self {
        let listener = block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            key: KEY.to_owned(),
            team: (TEAM.to_owned(), "Wandry".to_owned()),
            user: "Дима Капиш".to_owned(),
            collections: Vec::new(),
            rate_limited: 0,
            retry_after: "0",
            stall: false,
            down: false,
            html: false,
            list_without_text: false,
            delay: Duration::ZERO,
            log: Vec::new(),
            clock: 0,
        }));
        let shared = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tauri::async_runtime::spawn(respond(socket, Arc::clone(&shared)));
            }
        });
        Self { origin, state }
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }
}

async fn respond(mut socket: TcpStream, state: Arc<Mutex<State>>) {
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    let head_end = loop {
        if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break end + 4;
        }
        match socket.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&buffer[..read]),
        }
    };
    let head = String::from_utf8_lossy(&request[..head_end]).into_owned();
    let header = |name: &str| {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    let length: usize = header("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    while request.len() < head_end + length {
        match socket.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&buffer[..read]),
        }
    }
    let body: Value =
        serde_json::from_slice(&request[head_end..head_end + length]).unwrap_or(Value::Null);
    let path = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_owned();
    let method = path.strip_prefix("/api/").unwrap_or(&path).to_owned();

    let (status, extra, payload, delay, stall) = {
        let mut state = state.lock().unwrap();
        state.log.push(Logged {
            method: method.clone(),
            body: body.clone(),
            authorization: header("authorization"),
            content_type: header("content-type"),
        });
        let (status, extra, payload) = route(&mut state, &method, &body, header("authorization"));
        (status, extra, payload, state.delay, state.stall)
    };
    if stall {
        std::future::pending::<()>().await;
    }
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let content_type = if payload.starts_with('<') {
        "text/html"
    } else {
        "application/json"
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{payload}",
        payload.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn error(status: u16, message: &str) -> (u16, String, String) {
    (
        status,
        String::new(),
        json!({ "ok": false, "error": message, "status": status }).to_string(),
    )
}

fn ok(data: Value, pagination: Option<(u64, u64)>) -> (u16, String, String) {
    let mut body = json!({ "ok": true, "status": 200, "data": data });
    if let Some((offset, limit)) = pagination {
        body["pagination"] = json!({ "offset": offset, "limit": limit });
    }
    (200, String::new(), body.to_string())
}

fn page<T: Clone>(items: &[T], body: &Value) -> (Vec<T>, (u64, u64)) {
    let offset = body["offset"].as_u64().unwrap_or(0);
    let limit = body["limit"].as_u64().unwrap_or(25);
    let start = usize::try_from(offset).unwrap().min(items.len());
    let end = (start + usize::try_from(limit).unwrap()).min(items.len());
    (items[start..end].to_vec(), (offset, limit))
}

fn document_json(collection: &str, doc: &Doc, with_text: bool) -> Value {
    let mut value = json!({
        "id": doc.id,
        "collectionId": collection,
        "parentDocumentId": doc.parent,
        "title": doc.title,
        "url": format!("/doc/slug-{}", doc.id),
        "updatedAt": doc.updated_at,
        "publishedAt": "2025-12-01T00:00:00.000Z",
        "archivedAt": if doc.archived { Some(doc.updated_at.clone()) } else { None },
        "deletedAt": null,
    });
    if with_text {
        value["text"] = json!(doc.text);
    }
    value
}

fn tree(docs: &[Doc], parent: Option<&str>) -> Vec<Value> {
    docs.iter()
        .filter(|doc| !doc.archived && doc.parent.as_deref() == parent)
        .map(|doc| {
            json!({
                "id": doc.id,
                "title": doc.title,
                "url": format!("/doc/slug-{}", doc.id),
                "children": tree(docs, Some(&doc.id)),
            })
        })
        .collect()
}

fn route(
    state: &mut State,
    method: &str,
    body: &Value,
    authorization: Option<String>,
) -> (u16, String, String) {
    if state.html {
        return (
            200,
            String::new(),
            "<html><body>Hello</body></html>".to_owned(),
        );
    }
    if state.down {
        return error(503, "Service Unavailable");
    }
    if state.rate_limited > 0 {
        state.rate_limited -= 1;
        let mut answer = error(429, "rate_limit_exceeded");
        answer.1 = format!("Retry-After: {}\r\n", state.retry_after);
        return answer;
    }
    if authorization.as_deref() != Some(format!("Bearer {}", state.key).as_str()) {
        return error(401, "authentication_required");
    }
    let id = body["id"].as_str().unwrap_or_default();
    match method {
        "auth.info" => ok(
            json!({
                "user": { "id": "user-1", "name": state.user, "email": "dima@example.com" },
                "team": { "id": state.team.0, "name": state.team.1, "url": "https://wandry.example" },
            }),
            None,
        ),
        "collections.list" => {
            let all: Vec<Value> = state
                .collections
                .iter()
                .filter(|collection| !collection.forbidden)
                .map(|collection| {
                    json!({
                        "id": collection.id,
                        "name": collection.name,
                        "url": format!("/collection/slug-{}", collection.id),
                    })
                })
                .collect();
            let (items, pagination) = page(&all, body);
            ok(Value::Array(items), Some(pagination))
        }
        "collections.documents" => match state.collections.iter().find(|c| c.id == id) {
            None => error(404, "Not Found"),
            Some(collection) if collection.forbidden => error(403, "Authorization error"),
            Some(collection) => ok(Value::Array(tree(&collection.docs, None)), None),
        },
        "documents.list" => {
            let collection_id = body["collectionId"].as_str().unwrap_or_default();
            match state.collections.iter().find(|c| c.id == collection_id) {
                None => error(404, "Not Found"),
                Some(collection) if collection.forbidden => error(403, "Authorization error"),
                Some(collection) => {
                    let mut docs: Vec<&Doc> =
                        collection.docs.iter().filter(|doc| !doc.archived).collect();
                    docs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                    let all: Vec<Value> = docs
                        .into_iter()
                        .map(|doc| document_json(&collection.id, doc, !state.list_without_text))
                        .collect();
                    let (items, pagination) = page(&all, body);
                    ok(Value::Array(items), Some(pagination))
                }
            }
        }
        "documents.info" => {
            let found = state.collections.iter().find_map(|collection| {
                collection
                    .docs
                    .iter()
                    .find(|doc| doc.id == id)
                    .map(|doc| (collection, doc))
            });
            match found {
                None => error(404, "Not Found"),
                Some((collection, _)) if collection.forbidden => error(403, "Authorization error"),
                Some((collection, doc)) => ok(document_json(&collection.id, doc, true), None),
            }
        }
        _ => error(404, "Not Found"),
    }
}

/* A host */

/// An in-memory database, the in-memory secret store, the real Outline
/// connector (short limits) unless another provider is given, and an agent
/// that is ready (`Some`) or not, for `brief_prepare`.
pub struct Host {
    pub data: tempfile::TempDir,
    pub storage: Storage,
    pub connectors: Connectors,
    pub secrets: Arc<MemoryStore>,
    pub sink: RecordingSink,
    pub agent: Mutex<Option<Arc<dyn Agent>>>,
}

pub fn limits() -> Limits {
    Limits {
        timeout: Duration::from_secs(3),
        retry_cap: Duration::from_millis(50),
        retries: 3,
    }
}

impl Host {
    pub fn new() -> Arc<Self> {
        Self::with(Arc::new(OutlineConnector::with_limits(limits())))
    }

    pub fn with(provider: Arc<dyn SourceProvider>) -> Arc<Self> {
        let secrets = Arc::new(MemoryStore::default());
        let data = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(data.path());
        assert!(storage.error().is_none(), "{:?}", storage.error());
        Arc::new(Self {
            data,
            storage,
            connectors: Connectors::new(
                Arc::clone(&secrets) as Arc<dyn super::secrets::SecretStore>,
                [(ConnectorKind::Outline, provider)],
            ),
            secrets,
            sink: RecordingSink::default(),
            agent: Mutex::new(None),
        })
    }

    pub fn events(&self) -> Vec<DataChanged> {
        self.sink.events()
    }

    pub fn connect(self: &Arc<Self>, fake: &FakeOutline) -> ConnectOutcome {
        self.connect_with(&fake.origin, KEY)
    }

    pub fn connect_with(self: &Arc<Self>, host: &str, key: &str) -> ConnectOutcome {
        block_on(service::connect_api_key(
            self,
            ConnectorKind::Outline,
            host,
            key,
        ))
        .unwrap()
    }

    pub fn project(&self, name: &str) -> String {
        let name = name.to_owned();
        block_on(self.storage.write(&self.sink, move |db| {
            projects::create(
                db,
                ProjectCreate {
                    name,
                    description: Some("Колл-центр".to_owned()),
                    ..ProjectCreate::default()
                },
            )
        }))
        .unwrap()
        .id
    }

    /// Saves the selection and waits for its sync.
    pub fn select(self: &Arc<Self>, project_id: &str, items: Vec<SelectionItem>) -> SyncResult {
        block_on(service::selection_set(
            self.as_ref(),
            project_id,
            ConnectorKind::Outline,
            items,
        ))?;
        block_on(sync::sync_fresh(self, project_id, ConnectorKind::Outline))
    }

    pub fn sync(self: &Arc<Self>, project_id: &str) -> SyncResult {
        block_on(sync::sync_project(self, project_id, ConnectorKind::Outline))
    }

    pub fn sources(&self, project_id: &str) -> Vec<ProjectSource> {
        let id = project_id.to_owned();
        block_on(self.storage.read(move |db| sources::list(db, &id))).unwrap()
    }

    /// The external ids of the project's Outline sources, sorted.
    pub fn outline_ids(&self, project_id: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .sources(project_id)
            .into_iter()
            .filter_map(|source| source.origin.map(|origin| origin.external_id))
            .collect();
        ids.sort();
        ids
    }

    pub fn text_of(&self, project_id: &str, external_id: &str) -> String {
        let (id, external) = (project_id.to_owned(), external_id.to_owned());
        block_on(self.storage.read(move |db| {
            Ok(db.query_row(
                "SELECT text FROM project_sources WHERE project_id = ?1 AND external_id = ?2",
                [&id, &external],
                |row| row.get::<_, String>(0),
            )?)
        }))
        .unwrap()
    }

    pub fn fingerprint(&self, project_id: &str) -> String {
        let id = project_id.to_owned();
        block_on(
            self.storage
                .read(move |db| brief_inputs::fingerprint(db, &id)),
        )
        .unwrap()
    }

    /// Saves a brief as a build would: fresh.
    pub fn build_brief(&self, project_id: &str) {
        let id = project_id.to_owned();
        block_on(self.storage.write(&self.sink, move |db| {
            let inputs = brief_inputs::read(db, &id)?;
            projects::save_brief(
                db,
                &id,
                &json!({ "product": "Колл-центр" }),
                &inputs.fingerprint,
                false,
            )
        }))
        .unwrap();
    }

    pub fn brief_state(&self, project_id: &str) -> BriefState {
        let id = project_id.to_owned();
        block_on(self.storage.read(move |db| projects::get(db, &id)))
            .unwrap()
            .brief_state
    }
}

/// A whole collection.
pub fn collection(id: &str) -> SelectionItem {
    item(SelectionItemKind::Container, id)
}

pub fn document(id: &str) -> SelectionItem {
    item(SelectionItemKind::Document, id)
}

pub fn exclude(id: &str) -> SelectionItem {
    item(SelectionItemKind::Exclude, id)
}

fn item(item_kind: SelectionItemKind, id: &str) -> SelectionItem {
    SelectionItem {
        item_kind,
        external_id: id.to_owned(),
        title: format!("Пункт {id}"),
        url: None,
    }
}

impl EventSink for Host {
    fn data_changed(&self, event: DataChanged) {
        self.sink.data_changed(event);
    }
}

impl ConnectorHost for Host {
    fn storage(&self) -> Option<&Storage> {
        Some(&self.storage)
    }

    fn connectors(&self) -> Option<&Connectors> {
        Some(&self.connectors)
    }
}

impl BriefHost for Host {
    fn storage(&self) -> Option<&Storage> {
        Some(&self.storage)
    }

    fn progress(&self, _progress: BriefProgress) {}

    fn agent(&self) -> AgentLookup<'_> {
        let agent = self.agent.lock().unwrap().clone();
        Box::pin(async move { agent.ok_or_else(|| "Нужен вход в Claude Code".to_owned()) })
    }

    fn prompt_dir(&self) -> std::path::PathBuf {
        self.data.path().join("agent/briefs")
    }

    fn sync_connectors(self: &Arc<Self>, project_id: &str) -> SyncLookup {
        let (host, project_id) = (Arc::clone(self), project_id.to_owned());
        Box::pin(async move {
            let _ = sync::sync_all(&host, &project_id).await;
        })
    }
}
