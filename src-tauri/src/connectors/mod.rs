//! Connectors to the team's services (`specs/connectors`; connectors-outline
//! design.md, decision 1): a descriptor and capabilities per service, the
//! sign-in check every connector has ([`Connector`]) and the project
//! sources some of them give ([`SourceProvider`]).
//!
//! The app reads the services itself, over their REST APIs; the agent never
//! gets a secret, a service's address or a tool (decision 6, task 3.5). A
//! service's documents reach it only as the project's sources.
//!
//! Secrets live in the OS store ([`secrets`]); the database keeps the
//! connection without them (`storage::connectors`).

pub mod outline;
pub mod secrets;
pub mod service;
pub mod sync;

#[cfg(all(test, unix))]
mod agent_tests;
#[cfg(test)]
pub mod testing;
#[cfg(test)]
mod tests;

use std::{collections::HashMap, fmt, future::Future, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize};
use specta::Type;

use self::{secrets::SecretStore, sync::SyncFlights};

/// At most this many documents of a connector go into a project
/// (`outline-connector`, «Выбор документов для проекта»).
pub const MAX_DOCUMENTS: usize = 200;

/// A boxed future: the traits below are used as `Arc<dyn …>`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The services the app knows; one connection per service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum ConnectorKind {
    #[serde(rename = "outline")]
    Outline,
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "clickup")]
    ClickUp,
}

impl ConnectorKind {
    pub const ALL: [Self; 3] = [Self::Outline, Self::GitHub, Self::ClickUp];

    /// The name in the database and in the OS store.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Outline => "outline",
            Self::GitHub => "github",
            Self::ClickUp => "clickup",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// The name people know, for messages and source names.
    pub fn label(self) -> &'static str {
        match self {
            Self::Outline => "Outline",
            Self::GitHub => "GitHub",
            Self::ClickUp => "ClickUp",
        }
    }

    pub fn descriptor(self) -> &'static Descriptor {
        DESCRIPTORS
            .iter()
            .find(|descriptor| descriptor.kind == self)
            .expect("every kind has a descriptor")
    }
}

/// How a connector signs in. Only `apiKey` works in this change; the other
/// two describe GitHub and ClickUp (design.md, decision 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthMethod {
    /// An address (when `host`) and an API key.
    ApiKey { host: bool },
    /// A code the manager enters on the service's page.
    DeviceCode,
    /// OAuth in the browser.
    BrowserOAuth,
}

/// What a connector can do for the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// Documents as the project's sources.
    ProjectSources,
    /// Search during a call (later).
    CallSearch,
    /// Incoming questions (later).
    Inbox,
    /// Writing the call's results (later).
    Publish,
}

/// A connector as the screens list it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub kind: ConnectorKind,
    pub auth: AuthMethod,
    pub capabilities: &'static [Capability],
    /// `false`: shown as «скоро», never connected.
    pub available: bool,
}

/// The catalog, in the order of the screens.
pub static DESCRIPTORS: [Descriptor; 3] = [
    Descriptor {
        kind: ConnectorKind::Outline,
        auth: AuthMethod::ApiKey { host: true },
        capabilities: &[Capability::ProjectSources],
        available: true,
    },
    Descriptor {
        kind: ConnectorKind::GitHub,
        auth: AuthMethod::DeviceCode,
        capabilities: &[Capability::ProjectSources, Capability::CallSearch],
        available: false,
    },
    Descriptor {
        kind: ConnectorKind::ClickUp,
        auth: AuthMethod::BrowserOAuth,
        capabilities: &[
            Capability::ProjectSources,
            Capability::Inbox,
            Capability::Publish,
        ],
        available: false,
    },
];

/// A connector's secret. Read only inside Rust when the app calls the
/// service: it is not `Serialize` (no reply can carry it), and `Debug`
/// masks it. The OS store keeps it as JSON through [`secrets`].
#[derive(Clone, PartialEq, Eq)]
pub enum Credential {
    ApiKey {
        key: String,
    },
    /// For the OAuth connectors to come.
    #[allow(dead_code, reason = "ClickUp and GitHub sign in with tokens later")]
    OAuth {
        access: String,
        refresh: Option<String>,
        /// Milliseconds since the Unix epoch.
        expires_at: Option<i64>,
    },
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ApiKey { key } => write!(f, "ApiKey({})", mask(key)),
            Self::OAuth { expires_at, .. } => {
                write!(f, "OAuth(***, expires_at: {expires_at:?})")
            }
        }
    }
}

/// A secret for logs and errors: its last 4 characters at most, and only
/// of a long one.
pub fn mask(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() < 16 {
        return "***".to_owned();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("***{tail}")
}

/// What a connector talks to: the service's address (Outline) and the
/// secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    /// The normalized origin (`https://wandry.getoutline.com`); `None` for a
    /// service with one address.
    pub host: Option<String>,
    pub credential: Credential,
}

/// Who the secret belongs to, as the service says. Stored with the
/// connection (no secret in it) and shown in the settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// The service's address (Outline).
    pub host: Option<String>,
    /// The workspace the key opens: a selection belongs to it.
    pub team_id: String,
    pub team_name: String,
    pub user_name: Option<String>,
}

/// Why a call to a service failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectorError {
    /// The service refused the secret (401): «Ключ не подошёл».
    #[error("Ключ не подошёл")]
    Unauthorized,
    /// The secret works, but not for this (403).
    #[error("Нет доступа")]
    Forbidden,
    /// No such collection or document (404).
    #[error("Не найдено")]
    NotFound,
    /// No answer, a timeout, not the service at this address, a server
    /// error, or still «too many requests» after the retries.
    #[error("{0}")]
    Unreachable(String),
    #[error("{0}")]
    Other(String),
}

impl ConnectorError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Unauthorized => ErrorKind::Unauthorized,
            Self::Forbidden => ErrorKind::Forbidden,
            Self::Unreachable(_) => ErrorKind::Unreachable,
            Self::NotFound | Self::Other(_) => ErrorKind::Other,
        }
    }

    /// The service refused the secret itself: the connection breaks. A
    /// network failure never does (`connectors`, «Проверка подключения»).
    pub fn refuses_secret(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }
}

/// The kind of a connection's or a sync's last error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The key no longer works: «Обновить ключ».
    Unauthorized,
    /// No access.
    Forbidden,
    /// The service did not answer: «Повторить».
    Unreachable,
    Other,
    /// Only of a project's sync: the connector is not connected.
    Disconnected,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::Unreachable => "unreachable",
            Self::Other => "other",
            Self::Disconnected => "disconnected",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Unauthorized,
            Self::Forbidden,
            Self::Unreachable,
            Self::Other,
            Self::Disconnected,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == text)
    }
}

/// What a node of the picker is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// An Outline collection: all its documents, later ones too.
    Container,
    /// A document with its nested ones.
    Document,
}

/// A container or a document in the service.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRef {
    pub id: String,
    pub kind: RefKind,
}

/// A node of the picker's tree (`connector_browse`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowseNode {
    pub id: String,
    pub kind: RefKind,
    pub title: String,
    /// The node in the service, to open in the browser.
    pub url: Option<String>,
    pub has_children: bool,
    /// Documents it brings into a project: a collection's all, a document
    /// with its nested ones.
    pub document_count: u32,
    /// Nested documents, when the service gave them with the node (Outline
    /// gives a collection's whole tree at once); empty for a collection.
    pub children: Vec<BrowseNode>,
}

/// What a selection item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SelectionItemKind {
    /// A whole container.
    Container,
    /// A document with its nested ones.
    Document,
    /// A document of a selected container left out.
    Exclude,
}

impl SelectionItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Container => "container",
            Self::Document => "document",
            Self::Exclude => "exclude",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [Self::Container, Self::Document, Self::Exclude]
            .into_iter()
            .find(|kind| kind.as_str() == text)
    }
}

/// An item of a project's selection, as the picker gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionItem {
    pub item_kind: SelectionItemKind,
    pub external_id: String,
    pub title: String,
    #[specta(optional)]
    #[serde(default)]
    pub url: Option<String>,
}

/// A document of the expanded selection, without its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDoc {
    pub external_id: String,
    pub title: String,
    pub url: Option<String>,
    /// Changes whenever the document does (Outline: `updatedAt`).
    pub version: String,
    /// The text, when the listing already gave it: `fetch` then needs no
    /// request.
    pub prefetched: Option<String>,
}

/// The selection expanded into documents.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Resolved {
    /// Each document once, the excluded ones left out.
    pub docs: Vec<RemoteDoc>,
    /// External ids of the selection's items the service no longer has or
    /// denies.
    pub unavailable: Vec<String>,
}

/// A document's Markdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocText {
    pub external_id: String,
    pub text: String,
}

/// Sign-in check: every connector has it.
pub trait Connector: Send + Sync {
    fn descriptor(&self) -> &'static Descriptor;

    /// Checks the secret with one request; the account it belongs to.
    fn verify<'a>(&'a self, session: &'a Session)
    -> BoxFuture<'a, Result<Account, ConnectorError>>;
}

/// `Capability::ProjectSources`.
pub trait SourceProvider: Connector {
    /// The picker's tree: containers for `None`, else what is inside
    /// `parent`.
    fn browse<'a>(
        &'a self,
        session: &'a Session,
        parent: Option<&'a ExternalRef>,
    ) -> BoxFuture<'a, Result<Vec<BrowseNode>, ConnectorError>>;

    /// Expands the selection into documents (no text).
    fn resolve<'a>(
        &'a self,
        session: &'a Session,
        selection: &'a [SelectionItem],
    ) -> BoxFuture<'a, Result<Resolved, ConnectorError>>;

    /// The Markdown of `docs` (the new and changed ones).
    fn fetch<'a>(
        &'a self,
        session: &'a Session,
        docs: &'a [RemoteDoc],
    ) -> BoxFuture<'a, Result<Vec<DocText>, ConnectorError>>;
}

/// The connectors of the app: managed as Tauri state.
pub struct Connectors {
    pub secrets: Arc<dyn SecretStore>,
    providers: HashMap<ConnectorKind, Arc<dyn SourceProvider>>,
    pub flights: SyncFlights,
}

impl Connectors {
    /// The app's: Keychain / Credential Manager, the real Outline client.
    pub fn for_app() -> Self {
        Self::new(
            Arc::new(secrets::KeyringStore),
            [(
                ConnectorKind::Outline,
                Arc::new(outline::OutlineConnector::default()) as Arc<dyn SourceProvider>,
            )],
        )
    }

    pub fn new(
        secrets: Arc<dyn SecretStore>,
        providers: impl IntoIterator<Item = (ConnectorKind, Arc<dyn SourceProvider>)>,
    ) -> Self {
        let providers: HashMap<_, _> = providers.into_iter().collect();
        for (kind, provider) in &providers {
            debug_assert_eq!(
                provider.descriptor().kind,
                *kind,
                "a provider under its kind"
            );
        }
        Self {
            secrets,
            providers,
            flights: SyncFlights::default(),
        }
    }

    /// The connector of an available kind; `None` for one shown «скоро».
    pub fn provider(&self, kind: ConnectorKind) -> Option<Arc<dyn SourceProvider>> {
        if !kind.descriptor().available {
            return None;
        }
        self.providers.get(&kind).cloned()
    }
}
