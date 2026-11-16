//! Outline's API (design.md, decision 5): `POST {origin}/api/{method}` with
//! `Authorization: Bearer <key>` and a JSON body; the answer is
//! `{ "ok": true, "data": …, "pagination": … }`. Read only: the app never
//! calls a method that changes anything.
//!
//! 15 s per request. A 429 is retried after its `Retry-After` (at most
//! 60 s), up to 3 times. 401 → `Unauthorized`, 403 → `Forbidden`, 404 →
//! `NotFound`, no answer, a timeout, a server error or an answer that is not
//! Outline's JSON → `Unreachable`.

use std::time::Duration;

use reqwest::{StatusCode, header};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::connectors::ConnectorError;

/// The page size of the list methods.
pub const PAGE: usize = 100;
/// More pages than this is not a list the app can use.
const MAX_PAGES: usize = 100;
pub const TIMEOUT: Duration = Duration::from_secs(15);
/// The longest `Retry-After` the client waits.
pub const RETRY_CAP: Duration = Duration::from_secs(60);
pub const RETRIES: u32 = 3;

pub const NOT_OUTLINE: &str = "По этому адресу не Outline";

/// How the client waits and gives up; the tests shorten it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub timeout: Duration,
    pub retry_cap: Duration,
    pub retries: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout: TIMEOUT,
            retry_cap: RETRY_CAP,
            retries: RETRIES,
        }
    }
}

/// One Outline with one key.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    origin: String,
    token: String,
    limits: Limits,
}

/// The parts of `auth.info` the app reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthInfo {
    pub user: Named,
    pub team: Named,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Named {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Collection {
    pub id: String,
    pub name: String,
    /// A path on the Outline, e.g. `/collection/telemedia-x1Y2z3`.
    #[serde(default)]
    pub url: Option<String>,
}

/// A node of `collections.documents`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NavigationNode {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub children: Vec<NavigationNode>,
}

impl NavigationNode {
    /// This node and every node under it.
    pub fn count(&self) -> usize {
        1 + self.children.iter().map(Self::count).sum::<usize>()
    }

    pub fn find<'a>(nodes: &'a [Self], id: &str) -> Option<&'a Self> {
        nodes.iter().find_map(|node| {
            if node.id == id {
                Some(node)
            } else {
                Self::find(&node.children, id)
            }
        })
    }

    /// The ids of this node and every node under it, the node first.
    pub fn ids(&self, out: &mut Vec<String>) {
        out.push(self.id.clone());
        for child in &self.children {
            child.ids(out);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    #[serde(default)]
    pub collection_id: Option<String>,
    #[serde(default)]
    pub parent_document_id: Option<String>,
    #[serde(default)]
    pub title: String,
    /// Markdown; older self-hosted versions may leave it out of lists.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

impl Document {
    /// Published, not archived, not deleted.
    pub fn is_live(&self) -> bool {
        self.archived_at.is_none() && self.deleted_at.is_none() && self.published_at.is_some()
    }

    /// The path on the Outline.
    pub fn link(&self) -> Option<&str> {
        self.path.as_deref().or(self.url.as_deref())
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

impl Client {
    pub fn new(http: reqwest::Client, origin: &str, token: &str, limits: Limits) -> Self {
        Self {
            http,
            origin: origin.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            limits,
        }
    }

    /// `origin` + a path the API gave (`/doc/…`); an absolute URL as it is.
    pub fn absolute(&self, path: Option<&str>) -> Option<String> {
        let path = path?.trim();
        if path.is_empty() {
            return None;
        }
        if path.starts_with("http://") || path.starts_with("https://") {
            return Some(path.to_owned());
        }
        let slash = if path.starts_with('/') { "" } else { "/" };
        Some(format!("{}{slash}{path}", self.origin))
    }

    pub async fn auth_info(&self) -> Result<AuthInfo, ConnectorError> {
        self.post("auth.info", &json!({})).await
    }

    /// Every collection the key can read.
    pub async fn collections(&self) -> Result<Vec<Collection>, ConnectorError> {
        self.pages("collections.list", json!({})).await
    }

    /// The tree of the collection's documents.
    pub async fn collection_documents(
        &self,
        collection_id: &str,
    ) -> Result<Vec<NavigationNode>, ConnectorError> {
        self.post("collections.documents", &json!({ "id": collection_id }))
            .await
    }

    /// The collection's published documents with their text.
    pub async fn documents(&self, collection_id: &str) -> Result<Vec<Document>, ConnectorError> {
        self.pages(
            "documents.list",
            json!({
                "collectionId": collection_id,
                "statusFilter": ["published"],
                "sort": "updatedAt",
                "direction": "DESC",
            }),
        )
        .await
    }

    pub async fn document(&self, id: &str) -> Result<Document, ConnectorError> {
        self.post("documents.info", &json!({ "id": id })).await
    }

    /// Every page of a list method, [`PAGE`] at a time.
    async fn pages<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Vec<T>, ConnectorError> {
        let mut all = Vec::new();
        for page in 0..MAX_PAGES {
            let mut body = params.clone();
            body["limit"] = json!(PAGE);
            body["offset"] = json!(page * PAGE);
            let items: Vec<T> = self.post(method, &body).await?;
            let last = items.len() < PAGE;
            all.extend(items);
            if last {
                return Ok(all);
            }
        }
        Ok(all)
    }

    async fn post<T: DeserializeOwned>(
        &self,
        method: &str,
        body: &Value,
    ) -> Result<T, ConnectorError> {
        let url = format!("{}/api/{method}", self.origin);
        let mut retries = 0;
        loop {
            let response = self
                .http
                .post(&url)
                .bearer_auth(&self.token)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json")
                .body(body.to_string())
                .timeout(self.limits.timeout)
                .send()
                .await
                .map_err(|error| unreachable(&error))?;
            let status = response.status();
            if status == StatusCode::TOO_MANY_REQUESTS {
                if retries >= self.limits.retries {
                    return Err(ConnectorError::Unreachable(
                        "Outline просит подождать: слишком много запросов".to_owned(),
                    ));
                }
                retries += 1;
                let wait = retry_after(response.headers().get(header::RETRY_AFTER))
                    .min(self.limits.retry_cap);
                tokio::time::sleep(wait).await;
                continue;
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|error| unreachable(&error))?;
            return answer(status, &bytes);
        }
    }
}

/// The seconds of `Retry-After`; one second when it is missing or a date.
pub fn retry_after(value: Option<&header::HeaderValue>) -> Duration {
    value
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.trim().parse::<u64>().ok())
        .map_or(Duration::from_secs(1), Duration::from_secs)
}

/// Never the request itself in the message: its headers carry the key.
fn unreachable(error: &reqwest::Error) -> ConnectorError {
    let why = if error.is_timeout() {
        "Outline не ответил за 15 секунд"
    } else if error.is_connect() {
        "Не удалось подключиться к Outline"
    } else {
        "Outline не отвечает"
    };
    ConnectorError::Unreachable(why.to_owned())
}

fn answer<T: DeserializeOwned>(status: StatusCode, bytes: &[u8]) -> Result<T, ConnectorError> {
    let json: Option<Value> = serde_json::from_slice(bytes).ok();
    let outline = json.as_ref().is_some_and(Value::is_object);
    if status.is_success() {
        let Some(json) = json.filter(|_| outline) else {
            return Err(ConnectorError::Unreachable(NOT_OUTLINE.to_owned()));
        };
        return serde_json::from_value::<Envelope<T>>(json)
            .map(|envelope| envelope.data)
            .map_err(|_| ConnectorError::Unreachable(NOT_OUTLINE.to_owned()));
    }
    if status.is_server_error() {
        return Err(ConnectorError::Unreachable(format!(
            "Outline ответил ошибкой {}",
            status.as_u16()
        )));
    }
    // An error that is not Outline's JSON: something else answers there.
    if !outline {
        return Err(ConnectorError::Unreachable(NOT_OUTLINE.to_owned()));
    }
    Err(match status {
        StatusCode::UNAUTHORIZED => ConnectorError::Unauthorized,
        StatusCode::FORBIDDEN => ConnectorError::Forbidden,
        StatusCode::NOT_FOUND => ConnectorError::NotFound,
        other => {
            let message = json
                .as_ref()
                .and_then(|json| json.get("message").or_else(|| json.get("error")))
                .and_then(Value::as_str)
                .unwrap_or("ошибка запроса");
            ConnectorError::Other(format!("Outline: {message} ({})", other.as_u16()))
        }
    })
}
