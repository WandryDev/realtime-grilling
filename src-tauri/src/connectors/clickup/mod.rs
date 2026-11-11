//! The ClickUp connector (`specs/clickup-connector`; connectors-clickup
//! design.md, decisions 1–4): sign-in by a personal token in one workspace,
//! spaces, folders, lists and tasks as the project's sources. Read only.
//!
//! The ids of the picker are the connector's own: a container carries its
//! kind as a prefix (`space:<id>`, `folder:<id>`, `list:<id>`), a task is
//! its bare id. A selection, its exclusions and the sources' `external_id`
//! keep them as they are.

pub mod client;
pub mod rate;

#[cfg(test)]
pub mod fake;
#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use self::{
    client::{BASE, Client, Comment, Filter, List, TIMEOUT, Task},
    rate::RateGate,
};
use super::{
    Account, BoxFuture, BrowseNode, Connector, ConnectorError, ConnectorKind, Credential,
    Descriptor, DocText, ExternalRef, RefKind, RemoteDoc, Resolved, SelectionItem,
    SelectionItemKind, Session, SourceProvider, Verified, Workspace,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The pages of `/team/{id}/task` one resolve reads at most: 2 000 tasks
/// (decision 3); the ones past them are not counted.
pub const MAX_PAGES: usize = 20;
/// The pages a list's tree in the picker reads: past 200 tasks the tree
/// is no help (decision 2).
pub const BROWSE_PAGES: usize = 2;

pub const SPACE: &str = "space:";
pub const FOLDER: &str = "folder:";
pub const LIST: &str = "list:";

/// What a picker id names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Node<'a> {
    Space(&'a str),
    Folder(&'a str),
    List(&'a str),
    Task(&'a str),
}

impl<'a> Node<'a> {
    pub fn parse(id: &'a str) -> Self {
        if let Some(id) = id.strip_prefix(SPACE) {
            Self::Space(id)
        } else if let Some(id) = id.strip_prefix(FOLDER) {
            Self::Folder(id)
        } else if let Some(id) = id.strip_prefix(LIST) {
            Self::List(id)
        } else {
            Self::Task(id)
        }
    }

    fn filter(self) -> Option<(Filter, &'a str)> {
        match self {
            Self::Space(id) => Some((Filter::Spaces, id)),
            Self::Folder(id) => Some((Filter::Folders, id)),
            Self::List(id) => Some((Filter::Lists, id)),
            Self::Task(_) => None,
        }
    }
}

/// How many tokens' rate gates are kept (the connected one, the ones just
/// typed in).
const GATES: usize = 4;

pub struct ClickUpConnector {
    http: reqwest::Client,
    base: String,
    timeout: Duration,
    /// The rate limit of each token (ClickUp counts it per token), the most
    /// recently used last, keyed by the token's hash: a new token starts
    /// with a fresh limit, not the old one's wait.
    gates: Mutex<Vec<(String, Arc<RateGate>)>>,
}

impl Default for ClickUpConnector {
    fn default() -> Self {
        Self::with(BASE, TIMEOUT)
    }
}

impl ClickUpConnector {
    /// A ClickUp at `base` (the tests' fake).
    pub fn with(base: &str, timeout: Duration) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT.min(timeout))
            // The token goes only to ClickUp.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Grill/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            base: base.to_owned(),
            timeout,
            gates: Mutex::new(Vec::new()),
        }
    }

    /// The rate gate of `token`: the one its requests already go through,
    /// else a fresh one.
    pub fn gate(&self, token: &str) -> Arc<RateGate> {
        let key = crate::projects::sha256_hex(token.as_bytes());
        let mut gates = self.gates.lock().unwrap_or_else(PoisonError::into_inner);
        let gate = match gates.iter().position(|(known, _)| *known == key) {
            Some(index) => gates.remove(index).1,
            None => Arc::new(RateGate::default()),
        };
        gates.push((key, Arc::clone(&gate)));
        if gates.len() > GATES {
            gates.remove(0);
        }
        gate
    }

    pub fn client(&self, session: &Session) -> Result<Client, ConnectorError> {
        let Credential::ApiKey { key } = &session.credential else {
            return Err(ConnectorError::Unauthorized);
        };
        Ok(Client::new(
            self.http.clone(),
            &self.base,
            key,
            self.gate(key),
            self.timeout,
        ))
    }

    /// The sign-in check within the request's time (15 s), whatever the
    /// token's limit makes it wait for: a sync waiting for the limit holds
    /// the gate, and the check must not hang behind it.
    async fn check(
        &self,
        session: &Session,
        workspace: Option<&str>,
    ) -> Result<Verified, ConnectorError> {
        let client = self.client(session)?;
        match tokio::time::timeout(self.timeout, verify_in(&client, workspace)).await {
            Ok(verified) => verified,
            Err(_) if client.limited() => {
                Err(ConnectorError::Unreachable(rate::THROTTLED.to_owned()))
            }
            Err(_) => Err(ConnectorError::Unreachable(client::NO_ANSWER.to_owned())),
        }
    }
}

fn team(session: &Session) -> Result<&str, ConnectorError> {
    session
        .team
        .as_deref()
        .ok_or_else(|| ConnectorError::Other("Не выбрано пространство ClickUp".to_owned()))
}

/* Signing in */

async fn verify_in(client: &Client, workspace: Option<&str>) -> Result<Verified, ConnectorError> {
    let user = client.user().await.map_err(|error| match error {
        ConnectorError::NotFound => ConnectorError::Unreachable(client::NOT_CLICKUP.to_owned()),
        other => other,
    })?;
    let teams = client.teams().await?;
    if teams.is_empty() {
        return Err(ConnectorError::Forbidden);
    }
    let picked = match workspace {
        Some(id) => teams.iter().find(|team| team.id == id),
        None if teams.len() == 1 => teams.first(),
        None => None,
    };
    Ok(match picked {
        Some(team) => Verified::Account(Account {
            host: None,
            team_id: team.id.clone(),
            team_name: team.name.clone(),
            user_name: user.username.filter(|name| !name.trim().is_empty()),
        }),
        None => Verified::Choose(
            teams
                .into_iter()
                .map(|team| Workspace {
                    id: team.id,
                    name: team.name,
                })
                .collect(),
        ),
    })
}

/* The picker */

fn list_node(list: &List) -> BrowseNode {
    let count = list.task_count.unwrap_or(0);
    BrowseNode {
        id: format!("{LIST}{}", list.id),
        kind: RefKind::Container,
        title: list.name.clone(),
        url: None,
        has_children: list.task_count != Some(0),
        document_count: count,
        children: Vec::new(),
    }
}

fn task_node(task: &Task, children: Vec<BrowseNode>) -> BrowseNode {
    let count = 1 + children
        .iter()
        .map(|child| child.document_count)
        .sum::<u32>();
    BrowseNode {
        id: task.id.clone(),
        kind: RefKind::Document,
        title: task.name.clone(),
        url: task.url.clone(),
        has_children: !children.is_empty(),
        document_count: count,
        children,
    }
}

/// The tasks as a tree: the ones without a parent among them on top, each
/// with its subtasks, in the given order.
fn task_tree(tasks: &[Task]) -> Vec<BrowseNode> {
    let ids: HashSet<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
    let mut children: HashMap<&str, Vec<&Task>> = HashMap::new();
    let mut roots = Vec::new();
    for task in tasks {
        match task.parent.as_deref() {
            Some(parent) if ids.contains(parent) && parent != task.id => {
                children.entry(parent).or_default().push(task);
            }
            _ => roots.push(task),
        }
    }
    fn build(
        task: &Task,
        children: &HashMap<&str, Vec<&Task>>,
        seen: &mut HashSet<String>,
    ) -> BrowseNode {
        seen.insert(task.id.clone());
        let mut nested = Vec::new();
        for child in children.get(task.id.as_str()).into_iter().flatten() {
            // A loop of parents in a broken answer ends here.
            if !seen.contains(&child.id) {
                nested.push(build(child, children, seen));
            }
        }
        task_node(task, nested)
    }
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .map(|root| build(root, &children, &mut seen))
        .collect()
}

async fn browse(
    client: &Client,
    team: &str,
    parent: Option<&ExternalRef>,
) -> Result<Vec<BrowseNode>, ConnectorError> {
    let Some(parent) = parent else {
        // A space is counted only when it is expanded.
        return Ok(client
            .spaces(team)
            .await?
            .iter()
            .filter(|space| !space.archived)
            .map(|space| BrowseNode {
                id: format!("{SPACE}{}", space.id),
                kind: RefKind::Container,
                title: space.name.clone(),
                url: None,
                has_children: true,
                document_count: 0,
                children: Vec::new(),
            })
            .collect());
    };
    match Node::parse(&parent.id) {
        Node::Space(id) => {
            let folders = client.folders(id).await?;
            let lists = client.folderless_lists(id).await?;
            let mut nodes: Vec<BrowseNode> = folders
                .iter()
                .filter(|folder| !folder.archived)
                .map(|folder| {
                    let children: Vec<BrowseNode> = folder
                        .lists
                        .iter()
                        .filter(|list| !list.archived)
                        .map(list_node)
                        .collect();
                    BrowseNode {
                        id: format!("{FOLDER}{}", folder.id),
                        kind: RefKind::Container,
                        title: folder.name.clone(),
                        url: None,
                        has_children: !children.is_empty(),
                        document_count: children.iter().map(|list| list.document_count).sum(),
                        children,
                    }
                })
                .collect();
            nodes.extend(lists.iter().filter(|list| !list.archived).map(list_node));
            Ok(nodes)
        }
        Node::Folder(id) => Ok(client
            .folder_lists(id)
            .await?
            .iter()
            .filter(|list| !list.archived)
            .map(list_node)
            .collect()),
        Node::List(id) => {
            let ids = [id.to_owned()];
            let mut tasks = Vec::new();
            for page in 0..BROWSE_PAGES {
                let read = client
                    .team_tasks(team, Filter::Lists, &ids, page, false)
                    .await?;
                tasks.extend(read.tasks);
                if read.last {
                    break;
                }
            }
            tasks.retain(Task::is_open);
            Ok(task_tree(&tasks))
        }
        Node::Task(id) => {
            let task = client.task(id).await?;
            Ok(task
                .subtasks
                .iter()
                .filter(|subtask| subtask.is_open())
                .map(|subtask| task_node(subtask, Vec::new()))
                .collect())
        }
    }
}

/* Resolving a selection */

/// A 401 on one item: another workspace's task or list, unless the token
/// itself is refused. `/user` tells (once per resolve).
struct TokenCheck {
    valid: Option<bool>,
}

impl TokenCheck {
    /// `Ok(())`: the item is unavailable; `Err`: the token is refused, or
    /// ClickUp failed.
    async fn item_refused(&mut self, client: &Client) -> Result<(), ConnectorError> {
        let valid = match self.valid {
            Some(valid) => valid,
            None => {
                let valid = match client.user().await {
                    Ok(_) => true,
                    Err(ConnectorError::Unauthorized) => false,
                    Err(error) => return Err(error),
                };
                self.valid = Some(valid);
                valid
            }
        };
        if valid {
            Ok(())
        } else {
            Err(ConnectorError::Unauthorized)
        }
    }
}

/// An item answered `error`: `Ok(())` when that makes it unavailable, else
/// the error the resolve stops on.
async fn unavailable(
    error: ConnectorError,
    client: &Client,
    token: &mut TokenCheck,
) -> Result<(), ConnectorError> {
    match error {
        ConnectorError::NotFound | ConnectorError::Forbidden => Ok(()),
        ConnectorError::Unauthorized => token.item_refused(client).await,
        other => Err(other),
    }
}

/// Of a selected container: `Ok(true)` when it is there and not archived.
async fn container_live(client: &Client, filter: Filter, id: &str) -> Result<bool, ConnectorError> {
    Ok(!match filter {
        Filter::Spaces => client.space(id).await?.archived,
        Filter::Folders => client.folder(id).await?.archived,
        Filter::Lists => client.list(id).await?.archived,
    })
}

/// A task as the sources' heading: its name, status, list and assignees,
/// then its description.
pub fn head(task: &Task) -> String {
    let mut meta = Vec::new();
    if let Some(status) = task.status.as_ref().filter(|s| !s.status.trim().is_empty()) {
        meta.push(format!("Статус: {}", status.status.trim()));
    }
    let list = task
        .list
        .as_ref()
        .and_then(|list| list.name.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let folder = task
        .folder
        .as_ref()
        .filter(|folder| !folder.hidden)
        .and_then(|folder| folder.name.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "hidden");
    match (folder, list) {
        (Some(folder), Some(list)) => meta.push(format!("Список: {folder} / {list}")),
        (None, Some(list)) => meta.push(format!("Список: {list}")),
        _ => {}
    }
    let assignees: Vec<&str> = task
        .assignees
        .iter()
        .filter_map(|assignee| assignee.username.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    if !assignees.is_empty() {
        meta.push(format!("Исполнители: {}", assignees.join(", ")));
    }
    let mut text = format!("# {}", task.name.trim());
    if !meta.is_empty() {
        text.push('\n');
        text.push_str(&meta.join(" · "));
    }
    let description = [
        task.markdown_description.as_deref(),
        task.text_content.as_deref(),
        task.description.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|text| !text.is_empty());
    if let Some(description) = description {
        text.push_str("\n\n");
        text.push_str(description);
    }
    text
}

/// A comment's time (milliseconds as a string) in local time.
fn when(date: Option<&str>) -> Option<String> {
    let ms: i64 = date?.trim().parse().ok()?;
    let utc = chrono::DateTime::from_timestamp_millis(ms)?;
    Some(
        utc.with_timezone(&chrono::Local)
            .format("%d.%m.%Y %H:%M")
            .to_string(),
    )
}

/// The task's text: its heading and description, then its comments, the
/// oldest first.
pub fn text(head: &str, comments: &[Comment]) -> String {
    let mut text = head.to_owned();
    let lines: Vec<String> = comments
        .iter()
        .filter(|comment| !comment.comment_text.trim().is_empty())
        .map(|comment| {
            let author = comment
                .user
                .as_ref()
                .and_then(|user| user.username.as_deref())
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or("Без имени");
            let by = match when(comment.date.as_deref()) {
                Some(date) => format!("{author}, {date}"),
                None => author.to_owned(),
            };
            format!("**{by}:** {}", comment.comment_text.trim())
        })
        .collect();
    if !lines.is_empty() {
        text.push_str("\n\n## Комментарии\n");
        text.push_str(&lines.join("\n"));
    }
    text
}

/// A task as a document. Its heading goes along only when the answer had
/// its description: a subtask's summary in its parent's `/task/{id}` may
/// come without one, and then `fetch` reads the subtask itself.
fn remote(task: &Task) -> RemoteDoc {
    let described = task.markdown_description.is_some()
        || task.text_content.is_some()
        || task.description.is_some();
    RemoteDoc {
        external_id: task.id.clone(),
        title: task.name.clone(),
        url: task.url.clone(),
        version: task.version(),
        prefetched: described.then(|| head(task)),
    }
}

/// The selection as tasks (decision 3):
/// - the containers' open tasks in passes of `/team/{id}/task`, one per
///   kind of container picked, at most [`MAX_PAGES`] pages in all;
/// - each picked task in any status (unless archived) with its open
///   subtasks;
/// - excluded containers, tasks and the subtasks of excluded tasks left
///   out, a task of several lists once.
async fn resolve(
    client: &Client,
    team: &str,
    selection: &[SelectionItem],
) -> Result<Resolved, ConnectorError> {
    let excluded: HashSet<&str> = selection
        .iter()
        .filter(|item| item.item_kind == SelectionItemKind::Exclude)
        .map(|item| item.external_id.as_str())
        .collect();
    let picked: HashSet<&str> = selection
        .iter()
        .filter(|item| item.item_kind == SelectionItemKind::Document)
        .map(|item| item.external_id.as_str())
        .collect();
    let mut token = TokenCheck { valid: None };
    let mut unavailable_items = Vec::new();

    // Each picked container checked first: a deleted or archived one is
    // missing from the listing, not empty.
    let mut filters: Vec<(Filter, Vec<String>)> = Vec::new();
    for item in selection
        .iter()
        .filter(|item| item.item_kind == SelectionItemKind::Container)
    {
        let Some((filter, id)) = Node::parse(&item.external_id).filter() else {
            unavailable_items.push(item.external_id.clone());
            continue;
        };
        let live = match container_live(client, filter, id).await {
            Ok(live) => live,
            Err(error) => {
                unavailable(error, client, &mut token).await?;
                false
            }
        };
        if !live {
            unavailable_items.push(item.external_id.clone());
            continue;
        }
        match filters.iter_mut().find(|(known, _)| *known == filter) {
            Some((_, ids)) => ids.push(id.to_owned()),
            None => filters.push((filter, vec![id.to_owned()])),
        }
    }

    let mut found: Vec<Task> = Vec::new();
    for item in selection
        .iter()
        .filter(|item| item.item_kind == SelectionItemKind::Document)
    {
        let task = match client.task(&item.external_id).await {
            Ok(task) if task.archived => {
                unavailable_items.push(item.external_id.clone());
                continue;
            }
            Ok(task) => task,
            Err(error) => {
                unavailable(error, client, &mut token).await?;
                unavailable_items.push(item.external_id.clone());
                continue;
            }
        };
        let subtasks: Vec<Task> = task
            .subtasks
            .iter()
            .filter(|subtask| subtask.is_open())
            .cloned()
            .map(|mut subtask| {
                subtask.parent.get_or_insert_with(|| task.id.clone());
                subtask
            })
            .collect();
        found.push(task);
        found.extend(subtasks);
    }

    let mut pages = 0;
    for (filter, ids) in &filters {
        let mut page = 0;
        while pages < MAX_PAGES {
            let read = client.team_tasks(team, *filter, ids, page, true).await?;
            pages += 1;
            page += 1;
            let in_container = |task: &Task| {
                let container_excluded = [
                    task.list_id().map(|id| format!("{LIST}{id}")),
                    task.folder_id().map(|id| format!("{FOLDER}{id}")),
                    task.space_id().map(|id| format!("{SPACE}{id}")),
                ]
                .into_iter()
                .flatten()
                .any(|id| excluded.contains(id.as_str()));
                task.is_open() && !container_excluded
            };
            found.extend(read.tasks.into_iter().filter(in_container));
            if read.last {
                break;
            }
        }
    }

    // The subtasks of an excluded task go with it, at any depth.
    let mut left_out: HashSet<String> = excluded
        .iter()
        .filter(|id| !picked.contains(*id))
        .map(|id| (*id).to_owned())
        .collect();
    loop {
        let more: Vec<String> = found
            .iter()
            .filter(|task| !left_out.contains(&task.id) && !picked.contains(task.id.as_str()))
            .filter(|task| task.parent.as_ref().is_some_and(|p| left_out.contains(p)))
            .map(|task| task.id.clone())
            .collect();
        if more.is_empty() {
            break;
        }
        left_out.extend(more);
    }

    let mut seen = HashSet::new();
    let docs = found
        .iter()
        .filter(|task| !left_out.contains(&task.id))
        .filter(|task| seen.insert(task.id.clone()))
        .map(remote)
        .collect();
    Ok(Resolved {
        docs,
        unavailable: unavailable_items,
    })
}

/// The texts of `docs`: their heading from the resolve (else from the
/// task's own `/task/{id}`) and up to 50 newest comments each, read side by
/// side through the rate gate.
async fn fetch(client: &Client, docs: &[RemoteDoc]) -> Result<Vec<DocText>, ConnectorError> {
    let mut tasks = tokio::task::JoinSet::new();
    for (index, doc) in docs.iter().enumerate() {
        let (client, doc) = (client.clone(), doc.clone());
        tasks.spawn(async move {
            let head = match doc.prefetched {
                Some(head) => head,
                None => match client.task(&doc.external_id).await {
                    Ok(task) => head(&task),
                    Err(error) => return (index, Err(error)),
                },
            };
            let comments = client.comments(&doc.external_id).await;
            (
                index,
                comments.map(|comments| DocText {
                    external_id: doc.external_id,
                    text: text(&head, &comments),
                }),
            )
        });
    }
    let mut texts: Vec<Option<DocText>> = vec![None; docs.len()];
    while let Some(joined) = tasks.join_next().await {
        let (index, read) = joined.map_err(|error| {
            ConnectorError::Other(format!("Загрузка ClickUp прервана: {error}"))
        })?;
        match read {
            Ok(text) => texts[index] = Some(text),
            // Gone since the listing: the next sync drops it.
            Err(ConnectorError::NotFound | ConnectorError::Forbidden) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(texts.into_iter().flatten().collect())
}

impl Connector for ClickUpConnector {
    fn descriptor(&self) -> &'static Descriptor {
        ConnectorKind::ClickUp.descriptor()
    }

    /// The connected workspace's account; `Forbidden` when the token no
    /// longer opens it.
    fn verify<'a>(
        &'a self,
        session: &'a Session,
    ) -> BoxFuture<'a, Result<Account, ConnectorError>> {
        Box::pin(async move {
            match self.check(session, session.team.as_deref()).await? {
                Verified::Account(account) => Ok(account),
                Verified::Choose(_) if session.team.is_some() => Err(ConnectorError::Forbidden),
                Verified::Choose(_) => Err(ConnectorError::Other(
                    "Выберите пространство ClickUp".to_owned(),
                )),
            }
        })
    }

    fn verify_in<'a>(
        &'a self,
        session: &'a Session,
        workspace: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Verified, ConnectorError>> {
        Box::pin(async move { self.check(session, workspace).await })
    }
}

impl SourceProvider for ClickUpConnector {
    fn browse<'a>(
        &'a self,
        session: &'a Session,
        parent: Option<&'a ExternalRef>,
    ) -> BoxFuture<'a, Result<Vec<BrowseNode>, ConnectorError>> {
        Box::pin(async move { browse(&self.client(session)?, team(session)?, parent).await })
    }

    fn resolve<'a>(
        &'a self,
        session: &'a Session,
        selection: &'a [SelectionItem],
    ) -> BoxFuture<'a, Result<Resolved, ConnectorError>> {
        Box::pin(async move { resolve(&self.client(session)?, team(session)?, selection).await })
    }

    fn fetch<'a>(
        &'a self,
        session: &'a Session,
        docs: &'a [RemoteDoc],
    ) -> BoxFuture<'a, Result<Vec<DocText>, ConnectorError>> {
        Box::pin(async move { fetch(&self.client(session)?, docs).await })
    }
}
