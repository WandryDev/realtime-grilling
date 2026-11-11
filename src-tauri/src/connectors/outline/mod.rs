//! The Outline connector (`specs/outline-connector`; design.md, decision 5):
//! sign-in by address and API key, collections and documents as the
//! project's sources. Read only.

pub mod address;
pub mod client;

#[cfg(test)]
mod tests;

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use self::client::{Client, Document, Limits, NOT_OUTLINE, NavigationNode};
use super::{
    Account, BoxFuture, BrowseNode, Connector, ConnectorError, ConnectorKind, Credential,
    Descriptor, DocText, ExternalRef, RefKind, RemoteDoc, Resolved, SelectionItem,
    SelectionItemKind, Session, SourceProvider,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct OutlineConnector {
    http: reqwest::Client,
    pub limits: Limits,
}

impl Default for OutlineConnector {
    fn default() -> Self {
        Self::with_limits(Limits::default())
    }
}

impl OutlineConnector {
    pub fn with_limits(limits: Limits) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT.min(limits.timeout))
            // A key goes only to the address the manager typed.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Grill/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { http, limits }
    }

    fn client(&self, session: &Session) -> Result<Client, ConnectorError> {
        let host = session
            .host
            .as_deref()
            .ok_or_else(|| ConnectorError::Other("Не задан адрес Outline".to_owned()))?;
        let Credential::ApiKey { key } = &session.credential else {
            return Err(ConnectorError::Unauthorized);
        };
        Ok(Client::new(self.http.clone(), host, key, self.limits))
    }
}

/// A missing item is `unavailable`; anything else stops the sync.
fn unavailable(error: &ConnectorError) -> bool {
    matches!(error, ConnectorError::Forbidden | ConnectorError::NotFound)
}

fn node(client: &Client, node: &NavigationNode) -> BrowseNode {
    let children: Vec<BrowseNode> = node
        .children
        .iter()
        .map(|child| self::node(client, child))
        .collect();
    BrowseNode {
        id: node.id.clone(),
        kind: RefKind::Document,
        title: node.title.clone(),
        url: client.absolute(node.url.as_deref()),
        has_children: !children.is_empty(),
        document_count: u32::try_from(node.count()).unwrap_or(u32::MAX),
        children,
    }
}

fn remote(client: &Client, document: &Document) -> RemoteDoc {
    RemoteDoc {
        external_id: document.id.clone(),
        title: document.title.clone(),
        url: client.absolute(document.link()),
        version: document.updated_at.clone(),
        prefetched: document.text.clone(),
    }
}

/// A collection's tree and documents, read once per resolve.
#[derive(Default)]
struct Collections {
    trees: HashMap<String, Result<Vec<NavigationNode>, ConnectorError>>,
    documents: HashMap<String, Result<Vec<Document>, ConnectorError>>,
}

impl Collections {
    async fn documents(
        &mut self,
        client: &Client,
        id: &str,
    ) -> &Result<Vec<Document>, ConnectorError> {
        if !self.documents.contains_key(id) {
            let read = client.documents(id).await;
            self.documents.insert(id.to_owned(), read);
        }
        &self.documents[id]
    }

    async fn tree(
        &mut self,
        client: &Client,
        id: &str,
    ) -> &Result<Vec<NavigationNode>, ConnectorError> {
        if !self.trees.contains_key(id) {
            let read = client.collection_documents(id).await;
            self.trees.insert(id.to_owned(), read);
        }
        &self.trees[id]
    }
}

/// A failure other than a missing or forbidden item stops the resolve.
fn stop_on(result: &Result<impl Sized, ConnectorError>) -> Result<(), ConnectorError> {
    match result {
        Err(error) if !unavailable(error) => Err(error.clone()),
        _ => Ok(()),
    }
}

async fn resolve(client: &Client, selection: &[SelectionItem]) -> Result<Resolved, ConnectorError> {
    let excluded: HashSet<&str> = selection
        .iter()
        .filter(|item| item.item_kind == SelectionItemKind::Exclude)
        .map(|item| item.external_id.as_str())
        .collect();
    let mut collections = Collections::default();
    let mut found: Vec<Document> = Vec::new();
    let mut unavailable_items = Vec::new();
    for item in selection {
        match item.item_kind {
            SelectionItemKind::Exclude => {}
            SelectionItemKind::Container => {
                let documents = collections.documents(client, &item.external_id).await;
                stop_on(documents)?;
                match documents {
                    Ok(documents) => found.extend(documents.iter().cloned()),
                    Err(_) => unavailable_items.push(item.external_id.clone()),
                }
            }
            SelectionItemKind::Document => {
                let document = match client.document(&item.external_id).await {
                    Ok(document) if document.is_live() => document,
                    Ok(_) => {
                        unavailable_items.push(item.external_id.clone());
                        continue;
                    }
                    Err(error) if unavailable(&error) => {
                        unavailable_items.push(item.external_id.clone());
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let nested = match document.collection_id.clone() {
                    Some(collection) => {
                        nested(client, &mut collections, &collection, &document.id).await?
                    }
                    None => Vec::new(),
                };
                found.push(document);
                found.extend(nested);
            }
        }
    }
    let mut seen = HashSet::new();
    let docs = found
        .iter()
        .filter(|document| document.is_live())
        .filter(|document| !excluded.contains(document.id.as_str()))
        .filter(|document| seen.insert(document.id.clone()))
        .map(|document| remote(client, document))
        .collect();
    Ok(Resolved {
        docs,
        unavailable: unavailable_items,
    })
}

/// The documents nested in `id`, from its collection's tree and list.
async fn nested(
    client: &Client,
    collections: &mut Collections,
    collection: &str,
    id: &str,
) -> Result<Vec<Document>, ConnectorError> {
    let tree = collections.tree(client, collection).await;
    stop_on(tree)?;
    let mut ids = Vec::new();
    if let Ok(tree) = tree
        && let Some(node) = NavigationNode::find(tree, id)
    {
        for child in &node.children {
            child.ids(&mut ids);
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let documents = collections.documents(client, collection).await;
    stop_on(documents)?;
    let Ok(documents) = documents else {
        return Ok(Vec::new());
    };
    Ok(documents
        .iter()
        .filter(|document| ids.contains(&document.id))
        .cloned()
        .collect())
}

impl Connector for OutlineConnector {
    fn descriptor(&self) -> &'static Descriptor {
        ConnectorKind::Outline.descriptor()
    }

    fn verify<'a>(
        &'a self,
        session: &'a Session,
    ) -> BoxFuture<'a, Result<Account, ConnectorError>> {
        Box::pin(async move {
            let client = self.client(session)?;
            let info = client.auth_info().await.map_err(|error| match error {
                // `/api/auth.info` that isn't there: not an Outline.
                ConnectorError::NotFound => ConnectorError::Unreachable(NOT_OUTLINE.to_owned()),
                other => other,
            })?;
            Ok(Account {
                host: session.host.clone(),
                team_id: info.team.id,
                team_name: info.team.name,
                user_name: Some(info.user.name).filter(|name| !name.trim().is_empty()),
            })
        })
    }
}

impl SourceProvider for OutlineConnector {
    fn browse<'a>(
        &'a self,
        session: &'a Session,
        parent: Option<&'a ExternalRef>,
    ) -> BoxFuture<'a, Result<Vec<BrowseNode>, ConnectorError>> {
        Box::pin(async move {
            let client = self.client(session)?;
            match parent {
                None => browse_collections(&client).await,
                Some(ExternalRef {
                    id,
                    kind: RefKind::Container,
                }) => {
                    let tree = client.collection_documents(id).await?;
                    Ok(tree.iter().map(|child| node(&client, child)).collect())
                }
                Some(ExternalRef {
                    id,
                    kind: RefKind::Document,
                }) => {
                    let document = client.document(id).await?;
                    let Some(collection) = document.collection_id else {
                        return Ok(Vec::new());
                    };
                    let tree = client.collection_documents(&collection).await?;
                    Ok(NavigationNode::find(&tree, id)
                        .map(|found| {
                            found
                                .children
                                .iter()
                                .map(|child| node(&client, child))
                                .collect()
                        })
                        .unwrap_or_default())
                }
            }
        })
    }

    fn resolve<'a>(
        &'a self,
        session: &'a Session,
        selection: &'a [SelectionItem],
    ) -> BoxFuture<'a, Result<Resolved, ConnectorError>> {
        Box::pin(async move { resolve(&self.client(session)?, selection).await })
    }

    fn fetch<'a>(
        &'a self,
        session: &'a Session,
        docs: &'a [RemoteDoc],
    ) -> BoxFuture<'a, Result<Vec<DocText>, ConnectorError>> {
        Box::pin(async move {
            let client = self.client(session)?;
            let mut texts = Vec::with_capacity(docs.len());
            for doc in docs {
                let text = match &doc.prefetched {
                    Some(text) => text.clone(),
                    // An older Outline lists documents without their text.
                    None => match client.document(&doc.external_id).await {
                        Ok(document) => document.text.unwrap_or_default(),
                        // Gone since the listing: the next sync drops it.
                        Err(error) if unavailable(&error) => continue,
                        Err(error) => return Err(error),
                    },
                };
                texts.push(DocText {
                    external_id: doc.external_id.clone(),
                    text,
                });
            }
            Ok(texts)
        })
    }
}

/// The collections with how many documents each brings, their trees read
/// side by side.
async fn browse_collections(client: &Client) -> Result<Vec<BrowseNode>, ConnectorError> {
    let collections = client.collections().await?;
    let mut tasks = tokio::task::JoinSet::new();
    for (index, collection) in collections.iter().enumerate() {
        let (client, id) = (client.clone(), collection.id.clone());
        tasks.spawn(async move { (index, client.collection_documents(&id).await) });
    }
    let mut counts = vec![0_usize; collections.len()];
    while let Some(joined) = tasks.join_next().await {
        let (index, tree) = joined
            .map_err(|error| ConnectorError::Other(format!("Обзор Outline прерван: {error}")))?;
        counts[index] = match tree {
            Ok(tree) => tree.iter().map(NavigationNode::count).sum(),
            Err(error) if unavailable(&error) => 0,
            Err(error) => return Err(error),
        };
    }
    Ok(collections
        .iter()
        .zip(counts)
        .map(|(collection, count)| BrowseNode {
            id: collection.id.clone(),
            kind: RefKind::Container,
            title: collection.name.clone(),
            url: client.absolute(collection.url.as_deref()),
            has_children: count > 0,
            document_count: u32::try_from(count).unwrap_or(u32::MAX),
            children: Vec::new(),
        })
        .collect())
}
