//! ClickUp's API v2 (connectors-clickup design.md, decisions 1–4): `GET
//! {base}/…` with `Authorization: pk_…` (no `Bearer`). Read only: the app
//! never calls a method that changes anything.
//!
//! Every request goes through its token's [`RateGate`] and has 15 s.
//! 401 → `Unauthorized`, 403 → `Forbidden`, 404 → `NotFound`; no answer, a
//! timeout, a server error or an answer that is not ClickUp's JSON →
//! `Unreachable`. No error and no `Debug` carries the token.

use std::{fmt, sync::Arc, time::Duration};

use reqwest::{StatusCode, header};
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::Value;

use super::rate::{Observed, RateGate, Reply};
use crate::connectors::ConnectorError;

pub const BASE: &str = "https://api.clickup.com/api/v2";
pub const TIMEOUT: Duration = Duration::from_secs(15);
/// The size of a page of `/team/{id}/task`, fixed by ClickUp.
pub const PAGE: usize = 100;
/// The newest comments a page of `/task/{id}/comment` gives.
pub const COMMENT_PAGE: usize = 25;
/// Pages of comments read per task: the 50 newest.
pub const COMMENT_PAGES: usize = 2;

pub const NOT_CLICKUP: &str = "ClickUp ответил непонятно";
pub const NO_ANSWER: &str = "ClickUp не ответил за 15 секунд";

/// One token of one ClickUp.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
    gate: Arc<RateGate>,
    timeout: Duration,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("base", &self.base)
            .field("token", &crate::connectors::mask(&self.token))
            .finish_non_exhaustive()
    }
}

/* What the app reads */

/// An id ClickUp gives as a string or a number.
fn id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => text,
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    })
}

fn optional_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => None,
        Value::String(text) => Some(text),
        Value::Number(number) => Some(number.to_string()),
        Value::Object(object) => object.get("id").and_then(|id| match id {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        }),
        _ => None,
    })
}

/// A count ClickUp gives as a number or a string.
fn lenient_count<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Number(number) => number
            .as_u64()
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct User {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Deserialize)]
struct UserEnvelope {
    user: User,
}

/// A workspace (`team` in the API).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Team {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize)]
struct Teams {
    teams: Vec<Team>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Space {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Deserialize)]
struct Spaces {
    spaces: Vec<Space>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct List {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Not only the open tasks, perhaps: an estimate.
    #[serde(default, deserialize_with = "lenient_count")]
    pub task_count: Option<u32>,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Deserialize)]
struct Lists {
    lists: Vec<List>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Folder {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub archived: bool,
    /// The folder of the lists without one.
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub lists: Vec<List>,
}

#[derive(Deserialize)]
struct Folders {
    folders: Vec<Folder>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Status {
    #[serde(default)]
    pub status: String,
    /// `open`, `custom`, `done` or `closed`.
    #[serde(default, rename = "type")]
    pub kind: String,
}

/// Where a task lives: its list, folder or space.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct Place {
    #[serde(default, deserialize_with = "optional_id")]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Assignee {
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Task {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub markdown_description: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub text_content: Option<String>,
    #[serde(default)]
    pub status: Option<Status>,
    /// Milliseconds since the Unix epoch, as a string.
    #[serde(default, deserialize_with = "optional_id")]
    pub date_updated: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub list: Option<Place>,
    #[serde(default)]
    pub folder: Option<Place>,
    #[serde(default)]
    pub space: Option<Place>,
    /// The parent task of a subtask.
    #[serde(default, deserialize_with = "optional_id")]
    pub parent: Option<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub assignees: Vec<Assignee>,
    /// With `include_subtasks` on `/task/{id}`.
    #[serde(default)]
    pub subtasks: Vec<Task>,
}

impl Task {
    /// A status of the `closed` type. `done` is open: «готово к проверке»
    /// may still be worth asking about.
    pub fn is_closed(&self) -> bool {
        self.status
            .as_ref()
            .is_some_and(|status| status.kind.eq_ignore_ascii_case("closed"))
    }

    /// Open and not archived.
    pub fn is_open(&self) -> bool {
        !self.archived && !self.is_closed()
    }

    pub fn version(&self) -> String {
        self.date_updated.clone().unwrap_or_default()
    }

    fn place_id(place: Option<&Place>) -> Option<&str> {
        place.and_then(|place| place.id.as_deref())
    }

    pub fn list_id(&self) -> Option<&str> {
        Self::place_id(self.list.as_ref())
    }

    pub fn folder_id(&self) -> Option<&str> {
        Self::place_id(self.folder.as_ref())
    }

    pub fn space_id(&self) -> Option<&str> {
        Self::place_id(self.space.as_ref())
    }
}

#[derive(Deserialize)]
struct Tasks {
    #[serde(default)]
    tasks: Vec<Task>,
    #[serde(default)]
    last_page: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Comment {
    #[serde(deserialize_with = "id")]
    pub id: String,
    #[serde(default)]
    pub comment_text: String,
    #[serde(default)]
    pub user: Option<Assignee>,
    /// Milliseconds since the Unix epoch, as a string.
    #[serde(default, deserialize_with = "optional_id")]
    pub date: Option<String>,
}

#[derive(Deserialize)]
struct Comments {
    #[serde(default)]
    comments: Vec<Comment>,
}

/// What `/team/{id}/task` filters by: one kind of container per pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    Spaces,
    Folders,
    Lists,
}

impl Filter {
    fn param(self) -> &'static str {
        match self {
            Self::Spaces => "space_ids[]",
            Self::Folders => "project_ids[]",
            Self::Lists => "list_ids[]",
        }
    }
}

/// A page of `/team/{id}/task`, and whether more may follow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskPage {
    pub tasks: Vec<Task>,
    pub last: bool,
}

impl Client {
    pub fn new(
        http: reqwest::Client,
        base: &str,
        token: &str,
        gate: Arc<RateGate>,
        timeout: Duration,
    ) -> Self {
        Self {
            http,
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            gate,
            timeout,
        }
    }

    /// The token's limit is spent and its reset still ahead.
    pub fn limited(&self) -> bool {
        self.gate.limited()
    }

    pub async fn user(&self) -> Result<User, ConnectorError> {
        Ok(self.get::<UserEnvelope>("/user", &[]).await?.user)
    }

    /// The workspaces the token opens.
    pub async fn teams(&self) -> Result<Vec<Team>, ConnectorError> {
        Ok(self.get::<Teams>("/team", &[]).await?.teams)
    }

    pub async fn spaces(&self, team: &str) -> Result<Vec<Space>, ConnectorError> {
        let path = format!("/team/{team}/space");
        Ok(self
            .get::<Spaces>(&path, &[("archived", "false")])
            .await?
            .spaces)
    }

    /// The space's folders with their lists.
    pub async fn folders(&self, space: &str) -> Result<Vec<Folder>, ConnectorError> {
        let path = format!("/space/{space}/folder");
        Ok(self
            .get::<Folders>(&path, &[("archived", "false")])
            .await?
            .folders)
    }

    /// The space's lists without a folder.
    pub async fn folderless_lists(&self, space: &str) -> Result<Vec<List>, ConnectorError> {
        let path = format!("/space/{space}/list");
        Ok(self
            .get::<Lists>(&path, &[("archived", "false")])
            .await?
            .lists)
    }

    pub async fn folder_lists(&self, folder: &str) -> Result<Vec<List>, ConnectorError> {
        let path = format!("/folder/{folder}/list");
        Ok(self
            .get::<Lists>(&path, &[("archived", "false")])
            .await?
            .lists)
    }

    pub async fn list(&self, id: &str) -> Result<List, ConnectorError> {
        self.get(&format!("/list/{id}"), &[]).await
    }

    pub async fn folder(&self, id: &str) -> Result<Folder, ConnectorError> {
        self.get(&format!("/folder/{id}"), &[]).await
    }

    pub async fn space(&self, id: &str) -> Result<Space, ConnectorError> {
        self.get(&format!("/space/{id}"), &[]).await
    }

    /// A page (from 0) of the workspace's open tasks in `ids`, subtasks
    /// included, the most recently changed first.
    pub async fn team_tasks(
        &self,
        team: &str,
        filter: Filter,
        ids: &[String],
        page: usize,
        markdown: bool,
    ) -> Result<TaskPage, ConnectorError> {
        let page_text = page.to_string();
        let mut query: Vec<(&str, &str)> = vec![
            ("page", &page_text),
            ("order_by", "updated"),
            ("subtasks", "true"),
            ("include_closed", "false"),
        ];
        if markdown {
            query.push(("include_markdown_description", "true"));
        }
        for id in ids {
            query.push((filter.param(), id));
        }
        let read: Tasks = self.get(&format!("/team/{team}/task"), &query).await?;
        let last = read.last_page.unwrap_or(false) || read.tasks.len() < PAGE;
        Ok(TaskPage {
            tasks: read.tasks,
            last,
        })
    }

    /// One task with its subtasks and its description in Markdown.
    pub async fn task(&self, id: &str) -> Result<Task, ConnectorError> {
        self.get(
            &format!("/task/{id}"),
            &[
                ("include_subtasks", "true"),
                ("include_markdown_description", "true"),
            ],
        )
        .await
    }

    /// The newest comments of a task, at most [`COMMENT_PAGES`] pages, the
    /// oldest first.
    pub async fn comments(&self, task: &str) -> Result<Vec<Comment>, ConnectorError> {
        let path = format!("/task/{task}/comment");
        let mut all: Vec<Comment> = Vec::new();
        for _ in 0..COMMENT_PAGES {
            let before = all
                .last()
                .map(|last| (last.date.clone().unwrap_or_default(), last.id.clone()));
            let query: Vec<(&str, &str)> = match &before {
                Some((date, id)) => vec![("start", date), ("start_id", id)],
                None => Vec::new(),
            };
            let page = self.get::<Comments>(&path, &query).await?.comments;
            let full = page.len() >= COMMENT_PAGE;
            // A page that starts at the last one read repeats it.
            all.extend(
                page.into_iter()
                    .filter(|comment| before.as_ref().is_none_or(|(_, id)| &comment.id != id)),
            );
            if !full {
                break;
            }
        }
        all.reverse();
        Ok(all)
    }

    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, ConnectorError> {
        let mut url = reqwest::Url::parse(&format!("{}{path}", self.base))
            .map_err(|_| ConnectorError::Other("Неверный адрес ClickUp".to_owned()))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        self.gate
            .send(|| async {
                let sent = self
                    .http
                    .get(url.clone())
                    .header(header::AUTHORIZATION, &self.token)
                    .header(header::ACCEPT, "application/json")
                    .timeout(self.timeout)
                    .send()
                    .await;
                let response = match sent {
                    Ok(response) => response,
                    Err(error) => {
                        return (
                            Observed::default(),
                            Reply::Answered(Err(unreachable(&error))),
                        );
                    }
                };
                let observed = Observed::from_headers(response.headers());
                let status = response.status();
                if status == StatusCode::TOO_MANY_REQUESTS {
                    return (observed, Reply::Throttled);
                }
                let answer = match response.bytes().await {
                    Ok(bytes) => answer(status, &bytes),
                    Err(error) => Err(unreachable(&error)),
                };
                (observed, Reply::Answered(answer))
            })
            .await
    }
}

/// Never the request itself in the message: its headers carry the token.
fn unreachable(error: &reqwest::Error) -> ConnectorError {
    let why = if error.is_timeout() {
        NO_ANSWER
    } else if error.is_connect() {
        "Не удалось подключиться к ClickUp"
    } else {
        "ClickUp не отвечает"
    };
    ConnectorError::Unreachable(why.to_owned())
}

fn answer<T: DeserializeOwned>(status: StatusCode, bytes: &[u8]) -> Result<T, ConnectorError> {
    if status.is_success() {
        return serde_json::from_slice(bytes)
            .map_err(|_| ConnectorError::Unreachable(NOT_CLICKUP.to_owned()));
    }
    if status.is_server_error() {
        return Err(ConnectorError::Unreachable(format!(
            "ClickUp ответил ошибкой {}",
            status.as_u16()
        )));
    }
    Err(match status {
        StatusCode::UNAUTHORIZED => ConnectorError::Unauthorized,
        StatusCode::FORBIDDEN => ConnectorError::Forbidden,
        StatusCode::NOT_FOUND => ConnectorError::NotFound,
        other => {
            let json: Option<Value> = serde_json::from_slice(bytes).ok();
            let message = json
                .as_ref()
                .and_then(|json| json.get("err"))
                .and_then(Value::as_str)
                .unwrap_or("ошибка запроса");
            ConnectorError::Other(format!("ClickUp: {message} ({})", other.as_u16()))
        }
    })
}
