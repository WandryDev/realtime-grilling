//! The Outline client and connector against the fake Outline
//! (`connectors::testing`): every answer the client handles, and how a
//! selection expands.

use std::time::{Duration, Instant};

use reqwest::header::HeaderValue;
use serde_json::json;

use super::{
    OutlineConnector,
    client::{Client, Limits, NOT_OUTLINE, PAGE, RETRY_CAP, retry_after},
};
use crate::connectors::{
    Connector as _, ConnectorError, Credential, ExternalRef, RefKind, Session, SourceProvider as _,
    testing::{FakeOutline, KEY, TEAM, block_on, collection, document, exclude, limits},
};

fn session(fake: &FakeOutline) -> Session {
    Session {
        host: Some(fake.origin.clone()),
        credential: Credential::ApiKey {
            key: KEY.to_owned(),
        },
    }
}

fn client(fake: &FakeOutline) -> Client {
    Client::new(reqwest::Client::new(), &fake.origin, KEY, limits())
}

fn connector() -> OutlineConnector {
    OutlineConnector::with_limits(limits())
}

/* The client */

#[test]
fn requests_post_json_with_the_bearer_key() {
    let fake = FakeOutline::start();
    let info = block_on(client(&fake).auth_info()).unwrap();
    assert_eq!(info.team.id, TEAM);
    assert_eq!(info.team.name, "Wandry");
    assert_eq!(info.user.name, "Дима Капиш");
    let state = fake.state();
    let logged = &state.log[0];
    assert_eq!(logged.method, "auth.info");
    assert_eq!(
        logged.authorization.as_deref(),
        Some(format!("Bearer {KEY}").as_str())
    );
    assert_eq!(logged.content_type.as_deref(), Some("application/json"));
}

#[test]
fn a_refused_key_is_unauthorized() {
    let fake = FakeOutline::start();
    fake.state().key = "ol_api_another".to_owned();
    assert_eq!(
        block_on(client(&fake).auth_info()),
        Err(ConnectorError::Unauthorized)
    );
}

#[test]
fn forbidden_and_missing_are_told_apart() {
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("hidden", "Секрет", 1);
        state.collections[0].forbidden = true;
    }
    let client = client(&fake);
    assert_eq!(
        block_on(client.collection_documents("hidden")),
        Err(ConnectorError::Forbidden)
    );
    assert_eq!(
        block_on(client.documents("hidden")),
        Err(ConnectorError::Forbidden)
    );
    assert_eq!(
        block_on(client.collection_documents("gone")),
        Err(ConnectorError::NotFound)
    );
    assert_eq!(
        block_on(client.document("gone")),
        Err(ConnectorError::NotFound)
    );
}

#[test]
fn lists_come_in_pages_of_100() {
    let fake = FakeOutline::start();
    fake.state().add_collection("big", "Большая", 230);
    let documents = block_on(client(&fake).documents("big")).unwrap();
    assert_eq!(documents.len(), 230);
    let state = fake.state();
    let pages: Vec<(u64, u64)> = state
        .log
        .iter()
        .map(|logged| {
            assert_eq!(logged.body["collectionId"], "big");
            assert_eq!(logged.body["statusFilter"], json!(["published"]));
            (
                logged.body["offset"].as_u64().unwrap(),
                logged.body["limit"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(pages, [(0, 100), (100, 100), (200, 100)]);
    assert_eq!(PAGE, 100);
    // Every document has its text and version.
    assert!(documents.iter().all(|document| document.text.is_some()));
    assert!(
        documents
            .iter()
            .all(|document| !document.updated_at.is_empty())
    );
}

#[test]
fn an_exact_page_asks_once_more_and_stops_on_an_empty_one() {
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        for index in 0..100 {
            state.add_collection(&format!("c{index}"), "К", 0);
        }
    }
    let collections = block_on(client(&fake).collections()).unwrap();
    assert_eq!(collections.len(), 100);
    assert_eq!(fake.state().requests("collections.list"), 2);
}

#[test]
fn too_many_requests_waits_and_retries() {
    let fake = FakeOutline::start();
    fake.state().rate_limited = 2;
    let info = block_on(client(&fake).auth_info()).unwrap();
    assert_eq!(info.team.id, TEAM);
    assert_eq!(fake.state().requests("auth.info"), 3);

    // Still limited after 3 retries: gives up.
    fake.state().rate_limited = 10;
    let error = block_on(client(&fake).auth_info()).unwrap_err();
    assert!(matches!(error, ConnectorError::Unreachable(_)), "{error:?}");
    assert_eq!(fake.state().requests("auth.info"), 3 + 4);
}

#[test]
fn retry_after_is_honoured_up_to_the_cap() {
    assert_eq!(
        retry_after(Some(&HeaderValue::from_static("7"))),
        Duration::from_secs(7)
    );
    assert_eq!(
        retry_after(Some(&HeaderValue::from_static(" 2 "))),
        Duration::from_secs(2)
    );
    // A date or nothing: one second.
    assert_eq!(
        retry_after(Some(&HeaderValue::from_static(
            "Wed, 21 Oct 2026 07:28:00 GMT"
        ))),
        Duration::from_secs(1)
    );
    assert_eq!(retry_after(None), Duration::from_secs(1));
    assert_eq!(RETRY_CAP, Duration::from_secs(60));
    assert_eq!(Limits::default().retries, 3);
    assert_eq!(Limits::default().timeout, Duration::from_secs(15));

    // The wait is capped: `Retry-After: 120` waits the cap (50 ms here).
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.rate_limited = 1;
        state.retry_after = "120";
    }
    let started = Instant::now();
    block_on(client(&fake).auth_info()).unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn an_address_that_never_answers_times_out() {
    let fake = FakeOutline::start();
    fake.state().stall = true;
    let short = Limits {
        timeout: Duration::from_millis(300),
        ..limits()
    };
    let client = Client::new(reqwest::Client::new(), &fake.origin, KEY, short);
    let started = Instant::now();
    let error = block_on(client.auth_info()).unwrap_err();
    assert_eq!(
        error,
        ConnectorError::Unreachable("Outline не ответил за 15 секунд".to_owned())
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn nobody_listening_is_unreachable() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let client = Client::new(reqwest::Client::new(), &origin, KEY, limits());
    let error = block_on(client.auth_info()).unwrap_err();
    assert!(matches!(error, ConnectorError::Unreachable(_)), "{error:?}");
}

#[test]
fn not_outline_and_server_errors_are_unreachable() {
    let fake = FakeOutline::start();
    fake.state().html = true;
    assert_eq!(
        block_on(client(&fake).auth_info()),
        Err(ConnectorError::Unreachable(NOT_OUTLINE.to_owned()))
    );
    {
        let mut state = fake.state();
        state.html = false;
        state.down = true;
    }
    assert_eq!(
        block_on(client(&fake).auth_info()),
        Err(ConnectorError::Unreachable(
            "Outline ответил ошибкой 503".to_owned()
        ))
    );
}

#[test]
fn no_error_carries_the_key() {
    let fake = FakeOutline::start();
    fake.state().stall = true;
    let short = Limits {
        timeout: Duration::from_millis(100),
        ..limits()
    };
    let client = Client::new(reqwest::Client::new(), &fake.origin, KEY, short);
    let error = block_on(client.auth_info()).unwrap_err();
    assert!(!format!("{error} {error:?}").contains(KEY));
}

/* The connector */

#[test]
fn verify_names_the_team_and_the_user() {
    let fake = FakeOutline::start();
    let account = block_on(connector().verify(&session(&fake))).unwrap();
    assert_eq!(account.host.as_deref(), Some(fake.origin.as_str()));
    assert_eq!(account.team_id, TEAM);
    assert_eq!(account.team_name, "Wandry");
    assert_eq!(account.user_name.as_deref(), Some("Дима Капиш"));
    // One request.
    assert_eq!(fake.state().log.len(), 1);

    // Not an Outline: an HTML page, or no `/api/auth.info` there.
    fake.state().html = true;
    assert_eq!(
        block_on(connector().verify(&session(&fake))),
        Err(ConnectorError::Unreachable(NOT_OUTLINE.to_owned()))
    );
}

#[test]
fn browse_shows_collections_with_counts_and_their_trees() {
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("tm", "Телемедиа", 2);
        state.add_doc("tm", "tm-child", Some("tm-1"));
        state.add_doc("tm", "tm-grandchild", Some("tm-child"));
        state.add_collection("empty", "Пустая", 0);
    }
    let connector = connector();
    let session = session(&fake);
    let top = block_on(connector.browse(&session, None)).unwrap();
    assert_eq!(top.len(), 2);
    assert_eq!(top[0].id, "tm");
    assert_eq!(top[0].kind, RefKind::Container);
    assert_eq!(top[0].title, "Телемедиа");
    assert_eq!(top[0].document_count, 4);
    assert!(top[0].has_children);
    assert_eq!(
        top[0].url.as_deref(),
        Some(format!("{}/collection/slug-tm", fake.origin).as_str())
    );
    assert_eq!(top[1].document_count, 0);
    assert!(!top[1].has_children);

    let parent = ExternalRef {
        id: "tm".to_owned(),
        kind: RefKind::Container,
    };
    let tree = block_on(connector.browse(&session, Some(&parent))).unwrap();
    assert_eq!(tree.len(), 2);
    let first = tree.iter().find(|node| node.id == "tm-1").unwrap();
    assert_eq!(first.kind, RefKind::Document);
    assert_eq!(first.document_count, 3);
    assert_eq!(first.children[0].id, "tm-child");
    assert_eq!(first.children[0].children[0].id, "tm-grandchild");

    let doc = ExternalRef {
        id: "tm-1".to_owned(),
        kind: RefKind::Document,
    };
    let children = block_on(connector.browse(&session, Some(&doc))).unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].id, "tm-child");
}

fn ids(resolved: &crate::connectors::Resolved) -> Vec<String> {
    let mut ids: Vec<String> = resolved
        .docs
        .iter()
        .map(|doc| doc.external_id.clone())
        .collect();
    ids.sort();
    ids
}

/// `outline-connector`, «Выбрать коллекцию»: every document of it, with its
/// text from the listing.
#[test]
fn a_collection_expands_into_its_documents() {
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 12);
    let resolved = block_on(connector().resolve(&session(&fake), &[collection("tm")])).unwrap();
    assert_eq!(resolved.docs.len(), 12);
    assert!(resolved.unavailable.is_empty());
    let doc = resolved
        .docs
        .iter()
        .find(|doc| doc.external_id == "tm-3")
        .unwrap();
    assert_eq!(doc.title, "Документ tm-3");
    assert_eq!(doc.prefetched.as_deref(), Some("Текст документа tm-3."));
    assert_eq!(
        doc.url.as_deref(),
        Some(format!("{}/doc/slug-tm-3", fake.origin).as_str())
    );
    assert!(!doc.version.is_empty());
}

/// «Документ попал в выбор дважды»: a collection and a document of it.
#[test]
fn a_document_selected_twice_comes_once() {
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 3);
    let resolved =
        block_on(connector().resolve(&session(&fake), &[collection("tm"), document("tm-2")]))
            .unwrap();
    assert_eq!(ids(&resolved), ["tm-1", "tm-2", "tm-3"]);
}

#[test]
fn a_document_brings_its_nested_ones_and_excludes_stay_out() {
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("tm", "Телемедиа", 2);
        state.add_doc("tm", "child", Some("tm-1"));
        state.add_doc("tm", "grandchild", Some("child"));
        state.add_doc("tm", "other-child", Some("tm-2"));
    }
    let session = session(&fake);
    let resolved = block_on(connector().resolve(&session, &[document("tm-1")])).unwrap();
    assert_eq!(ids(&resolved), ["child", "grandchild", "tm-1"]);

    let resolved =
        block_on(connector().resolve(&session, &[collection("tm"), exclude("child")])).unwrap();
    assert_eq!(
        ids(&resolved),
        ["grandchild", "other-child", "tm-1", "tm-2"]
    );

    // The picker's rules (selection.ts): an exclude leaves a nested
    // document of a picked one out too, alone; an exclude nothing brings
    // (its collection was unchecked) changes nothing; a document picked by
    // itself is never left out.
    let resolved =
        block_on(connector().resolve(&session, &[document("tm-1"), exclude("child")])).unwrap();
    assert_eq!(ids(&resolved), ["grandchild", "tm-1"]);
    let resolved =
        block_on(connector().resolve(&session, &[document("tm-2"), exclude("child")])).unwrap();
    assert_eq!(ids(&resolved), ["other-child", "tm-2"]);
    let resolved = block_on(connector().resolve(
        &session,
        &[collection("tm"), document("tm-1"), exclude("tm-1")],
    ))
    .unwrap();
    assert_eq!(
        ids(&resolved),
        ["child", "grandchild", "other-child", "tm-1", "tm-2"]
    );
}

/// A big team's collections: their trees are read at most
/// `BROWSE_CONCURRENCY` at a time, not all at once (429s).
#[test]
fn browsing_reads_at_most_six_trees_at_once() {
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        for index in 0..20 {
            state.add_collection(&format!("c{index}"), &format!("Коллекция {index}"), 1);
        }
        state.delay = Duration::from_millis(40);
    }
    let nodes = block_on(connector().browse(&session(&fake), None)).unwrap();
    assert_eq!(nodes.len(), 20);
    assert!(nodes.iter().all(|node| node.document_count == 1));
    let state = fake.state();
    assert_eq!(state.requests("collections.documents"), 20);
    assert!(
        state.max_in_flight <= super::BROWSE_CONCURRENCY,
        "{} at once",
        state.max_in_flight
    );
    assert!(state.max_in_flight > 1, "still side by side");
}

/// «Коллекцию удалили», an archived document, a document without access.
#[test]
fn missing_items_are_unavailable_and_archived_documents_go() {
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("tm", "Телемедиа", 3);
        state.archive("tm-3");
        state.add_collection("hidden", "Секрет", 1);
        state.collections[1].forbidden = true;
    }
    let resolved = block_on(connector().resolve(
        &session(&fake),
        &[
            collection("tm"),
            collection("deleted"),
            collection("hidden"),
            document("tm-3"),
            document("gone"),
            document("hidden-1"),
        ],
    ))
    .unwrap();
    assert_eq!(ids(&resolved), ["tm-1", "tm-2"]);
    assert_eq!(
        resolved.unavailable,
        ["deleted", "hidden", "tm-3", "gone", "hidden-1"]
    );
}

#[test]
fn a_refused_key_stops_the_resolve() {
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 3);
    fake.state().key = "revoked".to_owned();
    assert_eq!(
        block_on(connector().resolve(&session(&fake), &[collection("tm")])),
        Err(ConnectorError::Unauthorized)
    );
}

/// An older Outline lists documents without `text`: `fetch` asks
/// `documents.info` for those it is given, and only those.
#[test]
fn fetch_falls_back_to_documents_info_without_text() {
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("tm", "Телемедиа", 3);
        state.list_without_text = true;
    }
    let connector = connector();
    let session = session(&fake);
    let resolved = block_on(connector.resolve(&session, &[collection("tm")])).unwrap();
    assert!(resolved.docs.iter().all(|doc| doc.prefetched.is_none()));
    let wanted: Vec<_> = resolved
        .docs
        .iter()
        .filter(|doc| doc.external_id != "tm-2")
        .cloned()
        .collect();
    let texts = block_on(connector.fetch(&session, &wanted)).unwrap();
    assert_eq!(texts.len(), 2);
    assert!(
        texts
            .iter()
            .any(|text| text.text == "Текст документа tm-1.")
    );
    assert_eq!(fake.state().requests("documents.info"), 2);

    // With the text in the listing: no request.
    fake.state().list_without_text = false;
    let resolved = block_on(connector.resolve(&session, &[collection("tm")])).unwrap();
    let before = fake.state().log.len();
    let texts = block_on(connector.fetch(&session, &resolved.docs)).unwrap();
    assert_eq!(texts.len(), 3);
    assert_eq!(fake.state().log.len(), before);
}
