//! The connectors' catalog, connecting and disconnecting, the projects'
//! sync and the brief before a call, against the fake Outline and the
//! in-memory secret store (`testing`). The scenarios are those of
//! `specs/connectors`, `outline-connector`, `project-sources`,
//! `project-brief` and `local-storage` of connectors-outline.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{Value, json};

use super::{
    Account, AuthMethod, BoxFuture, BrowseNode, Capability, Connector, ConnectorError,
    ConnectorKind, Credential, DESCRIPTORS, Descriptor, DocText, ErrorKind, ExternalRef, RemoteDoc,
    Resolved, SelectionItem, Session, SourceProvider, Verified, Workspace,
    secrets::SecretStore as _,
    service::{self, ConnectOutcome, ConnectorStatus, RejectedField},
    sync::{self, SyncOutcome},
    testing::{FakeOutline, Host, KEY, TEAM, block_on, collection, document, exclude},
};
use crate::{
    agent::claude_cli::{Agent, AgentError, AgentFuture, AgentRequest},
    error::CommandError,
    events::{Change, DataChanged, Entity},
    projects::{
        brief::run::{SYNC_BEFORE_CALL, prepare},
        builds::BriefBuilds,
    },
    storage::{
        connectors::{self as stored, ConnectionStatus, ItemStatus},
        projects::{self, BriefState},
        sources::{self, ConnectorChanges, ConnectorDocument, SourceStatus},
    },
};

/* The catalog */

// `Credential` never goes into a reply: it has neither serde nor specta.
static_assertions::assert_not_impl_any!(Credential: Serialize, serde::de::DeserializeOwned, specta::Type);

/// `connectors`, «Каталог коннекторов» (connectors-clickup): Outline and
/// ClickUp work, GitHub is «скоро».
#[test]
fn outline_and_clickup_work_github_is_coming() {
    let outline = ConnectorKind::Outline.descriptor();
    assert_eq!(outline.auth, AuthMethod::ApiKey { host: true });
    assert_eq!(outline.capabilities, [Capability::ProjectSources]);
    assert!(outline.available);
    let github = ConnectorKind::GitHub.descriptor();
    assert_eq!(github.auth, AuthMethod::DeviceCode);
    assert!(!github.available);
    let clickup = ConnectorKind::ClickUp.descriptor();
    assert_eq!(clickup.auth, AuthMethod::ApiKey { host: false });
    assert_eq!(clickup.capabilities, [Capability::ProjectSources]);
    assert!(clickup.available);
    assert_eq!(
        DESCRIPTORS
            .iter()
            .map(|descriptor| descriptor.kind)
            .collect::<Vec<_>>(),
        ConnectorKind::ALL
    );
    assert_eq!(
        serde_json::to_value(outline).unwrap(),
        json!({
            "kind": "outline",
            "auth": { "type": "apiKey", "host": true },
            "capabilities": ["projectSources"],
            "available": true,
        })
    );
    assert_eq!(
        serde_json::to_value(AuthMethod::BrowserOAuth).unwrap(),
        json!({ "type": "browserOAuth" })
    );
    let _: &Descriptor = github;
}

/// `connectors`, «Настройки без подключений».
#[test]
fn the_catalog_without_connections() {
    let host = Host::new();
    let views = block_on(service::list(host.as_ref())).unwrap();
    assert_eq!(views.len(), 3);
    assert!(
        views
            .iter()
            .all(|view| view.status == ConnectorStatus::Disconnected)
    );
    assert!(views.iter().all(|view| view.account.is_none()));
    assert_eq!(
        views.iter().map(|view| view.available).collect::<Vec<_>>(),
        [true, false, true]
    );
    // «скоро» can't be connected.
    let error = block_on(service::connect_api_key(
        &host,
        ConnectorKind::GitHub,
        "x",
        "y",
        None,
    ))
    .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
}

#[test]
fn outcomes_serialize_as_the_contract_says() {
    let rejected = ConnectOutcome::Rejected {
        field: RejectedField::Key,
        reason: "Ключ не подошёл".to_owned(),
    };
    assert_eq!(
        serde_json::to_value(&rejected).unwrap(),
        json!({ "rejected": { "field": "key", "reason": "Ключ не подошёл" } })
    );
    let host = Host::new();
    let fake = FakeOutline::start();
    let ConnectOutcome::Connected(view) = host.connect(&fake) else {
        panic!("connects");
    };
    let value = serde_json::to_value(ConnectOutcome::Connected(view)).unwrap();
    assert_eq!(value["connected"]["kind"], "outline");
    assert_eq!(value["connected"]["status"], "connected");
    assert_eq!(value["connected"]["account"]["teamName"], "Wandry");
    assert_eq!(value["connected"]["errorKind"], Value::Null);
}

/* Connecting */

fn connections(host: &Host) -> Vec<stored::StoredConnection> {
    block_on(host.storage.read(stored::connections)).unwrap()
}

fn connection_events(host: &Host) -> Vec<DataChanged> {
    host.events()
        .into_iter()
        .filter(|event| event.entity == Entity::Connections)
        .collect()
}

/// `connectors`, «Ключ не в базе», `outline-connector`, «Успех».
#[test]
fn connecting_checks_then_keeps_the_key_in_the_store_only() {
    let host = Host::new();
    let fake = FakeOutline::start();
    let ConnectOutcome::Connected(view) = host.connect(&fake) else {
        panic!("connects");
    };
    assert_eq!(view.status, ConnectorStatus::Connected);
    let account = view.account.clone().unwrap();
    assert_eq!(account.host.as_deref(), Some(fake.origin.as_str()));
    assert_eq!(account.team_id, TEAM);
    assert!(view.last_ok_at.is_some());
    // One request checks it.
    assert_eq!(fake.state().log.len(), 1);
    assert_eq!(
        host.secrets.get(ConnectorKind::Outline).unwrap(),
        Credential::ApiKey {
            key: KEY.to_owned()
        }
    );
    assert_eq!(connections(&host).len(), 1);
    assert_eq!(
        connection_events(&host),
        [DataChanged::new(
            Entity::Connections,
            "outline",
            None,
            Change::Created
        )]
    );
    // Nothing in the database has the key.
    let dump: Vec<String> = block_on(host.storage.read(|db| {
        let mut statement = db.prepare("SELECT * FROM connections")?;
        let columns = statement.column_count();
        let rows = statement.query_map([], |row| {
            (0..columns)
                .map(|index| {
                    row.get::<_, rusqlite::types::Value>(index)
                        .map(|v| format!("{v:?}"))
                })
                .collect::<Result<Vec<_>, _>>()
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?.concat())
    }))
    .unwrap();
    assert!(dump.iter().all(|cell| !cell.contains(KEY)), "{dump:?}");
    // «После перезапуска»: the list reads the same connection.
    let listed = block_on(service::list(host.as_ref())).unwrap();
    assert_eq!(listed[0].account, Some(account));
}

/// `connectors`, «Неверный ключ при первом подключении»;
/// `outline-connector`, «Неверный ключ».
#[test]
fn a_refused_key_connects_nothing() {
    let host = Host::new();
    let fake = FakeOutline::start();
    let outcome = host.connect_with(&fake.origin, "ol_api_wrong");
    assert_eq!(
        outcome,
        ConnectOutcome::Rejected {
            field: RejectedField::Key,
            reason: "Ключ не подошёл".to_owned()
        }
    );
    assert!(host.secrets.raw().is_empty());
    assert!(connections(&host).is_empty());
    assert!(host.events().is_empty());
    // An empty key is refused before any request.
    let outcome = host.connect_with(&fake.origin, "  ");
    assert!(matches!(
        outcome,
        ConnectOutcome::Rejected {
            field: RejectedField::Key,
            ..
        }
    ));
    assert_eq!(fake.state().log.len(), 1);
}

/// `outline-connector`, «Адрес не отвечает», «Свой Outline по http»: the
/// error is at the address; nothing is saved (the key stays in the field:
/// the screen's).
#[test]
fn a_bad_address_is_refused_at_the_host_field() {
    let host = Host::new();
    let outcome = host.connect_with("http://docs.pixel.agency", KEY);
    assert_eq!(
        outcome,
        ConnectOutcome::Rejected {
            field: RejectedField::Host,
            reason: "Нужен адрес с https".to_owned()
        }
    );
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let silent = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let outcome = host.connect_with(&silent, KEY);
    assert!(
        matches!(
            outcome,
            ConnectOutcome::Rejected {
                field: RejectedField::Host,
                ..
            }
        ),
        "{outcome:?}"
    );
    let fake = FakeOutline::start();
    fake.state().html = true;
    assert_eq!(
        host.connect_with(&fake.origin, KEY),
        ConnectOutcome::Rejected {
            field: RejectedField::Host,
            reason: "По этому адресу не Outline".to_owned()
        }
    );
    assert!(host.secrets.raw().is_empty());
    assert!(connections(&host).is_empty());
}

/// `connectors`, «Хранилище отказало».
#[test]
fn a_refused_store_write_connects_nothing() {
    let host = Host::new();
    let fake = FakeOutline::start();
    host.secrets.fail_writes(true);
    let error = block_on(service::connect_api_key(
        &host,
        ConnectorKind::Outline,
        &fake.origin,
        KEY,
        None,
    ))
    .unwrap_err();
    let CommandError::External { message, .. } = &error else {
        panic!("{error:?}");
    };
    assert!(message.contains("Keychain"), "{message}");
    assert!(!message.contains(KEY));
    assert!(connections(&host).is_empty());
    assert!(host.secrets.raw().is_empty());
}

/// The row can't be written: the secret goes back to what it was.
#[test]
fn a_failed_row_write_rolls_the_secret_back() {
    let fake = FakeOutline::start();
    let host = Host::new();
    // A database that can't take the row: no `connections` table.
    block_on(host.storage.read(|db| {
        db.execute_batch("DROP TABLE connections")?;
        Ok(())
    }))
    .unwrap();
    let error = block_on(service::connect_api_key(
        &host,
        ConnectorKind::Outline,
        &fake.origin,
        KEY,
        None,
    ));
    assert!(error.is_err());
    assert!(host.secrets.raw().is_empty(), "the new key is gone");

    // With a key there before, that key comes back.
    let old = Credential::ApiKey {
        key: "ol_api_old_key_kept_here".to_owned(),
    };
    host.secrets.set(ConnectorKind::Outline, &old).unwrap();
    assert!(
        block_on(service::connect_api_key(
            &host,
            ConnectorKind::Outline,
            &fake.origin,
            KEY,
            None,
        ))
        .is_err()
    );
    assert_eq!(host.secrets.get(ConnectorKind::Outline).unwrap(), old);
}

/// `connectors`, «Ключ отозвали», then «Обновить ключ»: the selection of the
/// projects stays.
#[test]
fn a_revoked_key_breaks_the_connection_and_a_new_one_fixes_it() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();

    fake.state().key = "ol_api_new_key_after_revoke".to_owned();
    block_on(service::verify(host.as_ref(), ConnectorKind::Outline)).unwrap();
    let view = &block_on(service::list(host.as_ref())).unwrap()[0];
    assert_eq!(view.status, ConnectorStatus::Error);
    assert_eq!(view.error_kind, Some(ErrorKind::Unauthorized));
    assert_eq!(view.error.as_deref(), Some("Ключ больше не подходит"));

    let ConnectOutcome::Connected(view) =
        host.connect_with(&fake.origin, "ol_api_new_key_after_revoke")
    else {
        panic!("reconnects");
    };
    assert_eq!(view.status, ConnectorStatus::Connected);
    assert_eq!(view.error_kind, None);
    assert_eq!(
        host.secrets.get(ConnectorKind::Outline).unwrap(),
        Credential::ApiKey {
            key: "ol_api_new_key_after_revoke".to_owned()
        }
    );
    let selection = block_on(service::selection_get(host.as_ref(), &project)).unwrap();
    assert_eq!(selection[0].items.len(), 1);
    assert_eq!(selection[0].items[0].external_id, "tm");
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
}

/// `connectors`, «Нет интернета»: still connected, «не удалось обновить»,
/// the last success kept.
#[test]
fn no_network_is_not_a_revoked_key() {
    let host = Host::new();
    let fake = FakeOutline::start();
    host.connect(&fake);
    let before = connections(&host)[0].clone();
    fake.state().down = true;
    block_on(service::verify_all(host.as_ref())).unwrap();
    let after = connections(&host)[0].clone();
    assert_eq!(after.status, ConnectionStatus::Connected);
    assert_eq!(after.error_kind, Some(ErrorKind::Unreachable));
    assert_eq!(after.last_ok_at, before.last_ok_at);
    assert!(after.last_attempt_at >= before.last_attempt_at);
    // Back online: the error clears.
    fake.state().down = false;
    block_on(service::verify_all(host.as_ref())).unwrap();
    let back = connections(&host)[0].clone();
    assert_eq!(back.error_kind, None);
    assert!(back.last_ok_at >= before.last_ok_at);
}

/// A key the OS store no longer gives (another signature after a rebuild):
/// «Обновить ключ», not a crash.
#[test]
fn a_key_missing_from_the_store_asks_for_a_new_one() {
    let host = Host::new();
    let fake = FakeOutline::start();
    host.connect(&fake);
    host.secrets.delete(ConnectorKind::Outline).unwrap();
    block_on(service::verify(host.as_ref(), ConnectorKind::Outline)).unwrap();
    let connection = connections(&host)[0].clone();
    assert_eq!(connection.status, ConnectionStatus::Error);
    assert_eq!(connection.error_kind, Some(ErrorKind::Unauthorized));
}

/// `connectors`, «Отключить Outline» and «Подключить снова»;
/// `local-storage`, «Отключение не трогает проекты».
#[test]
fn disconnecting_keeps_the_projects_and_reconnecting_syncs_them_again() {
    let host = Host::new();
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("tm", "Телемедиа", 3);
        state.add_collection("lapa", "Лапа", 2);
    }
    host.connect(&fake);
    let telemedia = host.project("Телемедиа");
    let lapa = host.project("Лапа");
    host.select(&telemedia, vec![collection("tm")]).unwrap();
    host.select(&lapa, vec![collection("lapa")]).unwrap();

    block_on(service::disconnect(host.as_ref(), ConnectorKind::Outline)).unwrap();
    assert!(host.secrets.raw().is_empty(), "the key left the store");
    assert!(connections(&host).is_empty());
    assert_eq!(
        connection_events(&host).last(),
        Some(&DataChanged::new(
            Entity::Connections,
            "outline",
            None,
            Change::Deleted
        ))
    );
    assert_eq!(host.outline_ids(&telemedia), ["tm-1", "tm-2", "tm-3"]);
    assert_eq!(host.outline_ids(&lapa), ["lapa-1", "lapa-2"]);
    let views = block_on(service::selection_get(host.as_ref(), &telemedia)).unwrap();
    assert!(!views[0].connected);
    assert_eq!(views[0].items.len(), 1);

    // While disconnected nothing updates; the project says why.
    fake.state().edit("tm-1", "Новый текст");
    assert_eq!(host.sync(&telemedia).unwrap(), SyncOutcome::Disconnected);
    assert_eq!(host.text_of(&telemedia, "tm-1"), "Текст документа tm-1.");
    let sync_state = block_on(service::selection_get(host.as_ref(), &telemedia)).unwrap()[0]
        .sync
        .clone()
        .unwrap();
    assert_eq!(sync_state.error_kind, Some(ErrorKind::Disconnected));
    assert_eq!(sync_state.error.as_deref(), Some("Outline отключён"));
    assert!(sync_state.last_ok_at.is_some());

    // Connected again: the selections sync without picking again.
    host.connect(&fake);
    let deadline = Instant::now() + Duration::from_secs(10);
    while host.text_of(&telemedia, "tm-1") != "Новый текст" {
        assert!(Instant::now() < deadline, "the selection synced again");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/* The sync */

fn sync_ok(changed: bool, skipped: u32) -> SyncOutcome {
    SyncOutcome::Synced { changed, skipped }
}

/// `outline-connector`, «Выбрать коллекцию»; `project-sources`, «Файлы и
/// Outline вместе»; one `DataChanged` for the sync.
#[test]
fn a_selected_collection_becomes_sources_with_one_event() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 12);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    let view = block_on(service::selection_set(
        host.as_ref(),
        &project,
        ConnectorKind::Outline,
        vec![collection("tm")],
    ))
    .unwrap();
    assert_eq!(view.items.len(), 1);
    assert_eq!(view.items[0].status, ItemStatus::Ok);
    let before = host.events().len();
    assert_eq!(
        block_on(sync::sync_fresh(&host, &project, ConnectorKind::Outline)).unwrap(),
        sync_ok(true, 0)
    );
    let events = host.events()[before..].to_vec();
    assert_eq!(events, [projects::changed(&project)], "one event per sync");

    let listed = host.sources(&project);
    assert_eq!(listed.len(), 12);
    let source = listed
        .iter()
        .find(|source| source.origin.as_ref().unwrap().external_id == "tm-3")
        .unwrap();
    assert_eq!(source.name, "Документ tm-3");
    assert_eq!(source.status, SourceStatus::Ready);
    let origin = source.origin.as_ref().unwrap();
    assert_eq!(origin.connector, ConnectorKind::Outline);
    assert_eq!(
        origin.url.as_deref(),
        Some(format!("{}/doc/slug-tm-3", fake.origin).as_str())
    );
    let state = block_on(service::selection_get(host.as_ref(), &project)).unwrap();
    let sync_state = state[0].sync.clone().unwrap();
    assert!(sync_state.last_ok_at.is_some());
    assert_eq!(sync_state.error_kind, None);
    assert_eq!(sync_state.skipped, 0);
    assert!(!state[0].syncing);
}

/// `outline-connector`, «Документ изменили», then «Ничего не изменилось»;
/// `project-brief`, «Изменился документ Outline».
#[test]
fn a_changed_document_outdates_the_brief_and_nothing_changed_keeps_it() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 3);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    host.build_brief(&project);
    assert_eq!(host.brief_state(&project), BriefState::Fresh);
    let rows = |host: &Host| {
        let id = project.clone();
        block_on(host.storage.read(move |db| {
            let mut statement = db.prepare(
                "SELECT id, updated_at, text FROM project_sources WHERE project_id = ?1
                 ORDER BY id",
            )?;
            let rows = statement.query_map([&id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }))
        .unwrap()
    };

    // Nothing changed in Outline: no row is touched, the brief is fresh,
    // no text is fetched, and the event is only the sync state's.
    let untouched = rows(&host);
    let fingerprint = host.fingerprint(&project);
    let before = host.events().len();
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(host.sync(&project).unwrap(), sync_ok(false, 0));
    assert_eq!(rows(&host), untouched);
    assert_eq!(host.fingerprint(&project), fingerprint);
    assert_eq!(host.brief_state(&project), BriefState::Fresh);
    assert_eq!(
        host.events()[before..],
        [stored::selection_changed(&project, ConnectorKind::Outline)]
    );
    assert_eq!(fake.state().requests("documents.info"), 0);

    // A document changed: new text in the same row, the brief may be old.
    let id_before = untouched
        .iter()
        .find(|row| row.2.contains("tm-2"))
        .unwrap()
        .0
        .clone();
    fake.state()
        .edit("tm-2", "Новые требования: 300 звонков в день");
    assert_eq!(host.sync(&project).unwrap(), sync_ok(true, 0));
    assert_eq!(
        host.text_of(&project, "tm-2"),
        "Новые требования: 300 звонков в день"
    );
    let after = rows(&host);
    assert!(
        after
            .iter()
            .any(|row| row.0 == id_before && row.2.starts_with("Новые"))
    );
    assert_eq!(host.brief_state(&project), BriefState::Outdated);
}

/// `outline-connector`, «Документ архивировали».
#[test]
fn an_archived_document_leaves_the_sources() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 3);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    fake.state().archive("tm-1");
    assert_eq!(host.sync(&project).unwrap(), sync_ok(true, 0));
    assert_eq!(host.outline_ids(&project), ["tm-2", "tm-3"]);
}

/// `outline-connector`, «Ключ отозвали перед звонком» (the sync's part):
/// the sources keep their last text, the project says why, the connection
/// breaks.
#[test]
fn a_revoked_key_stops_the_sync_without_changing_sources() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    let synced_at = block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0]
        .sync
        .clone()
        .unwrap()
        .last_ok_at;
    {
        let mut state = fake.state();
        state.edit("tm-1", "Не должно прийти");
        state.key = "revoked".to_owned();
    }
    let outcome = host.sync(&project).unwrap();
    assert_eq!(
        outcome,
        SyncOutcome::Failed {
            kind: ErrorKind::Unauthorized,
            message: "Ключ больше не подходит".to_owned()
        }
    );
    assert_eq!(host.text_of(&project, "tm-1"), "Текст документа tm-1.");
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
    let view = block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0].clone();
    let state = view.sync.unwrap();
    assert_eq!(state.error_kind, Some(ErrorKind::Unauthorized));
    assert_eq!(state.error.as_deref(), Some("Ключ больше не подходит"));
    assert_eq!(state.last_ok_at, synced_at);
    assert_eq!(connections(&host)[0].status, ConnectionStatus::Error);

    // Outline not answering: the same sources, the connection stands.
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    fake.state().down = true;
    assert!(matches!(
        host.sync(&project).unwrap(),
        SyncOutcome::Failed {
            kind: ErrorKind::Unreachable,
            ..
        }
    ));
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
    assert_eq!(connections(&host)[0].status, ConnectionStatus::Connected);
    assert_eq!(
        connections(&host)[0].error_kind,
        Some(ErrorKind::Unreachable)
    );
}

/// `project-sources`, «Исключить документ коллекции»; «Документ попал в
/// выбор дважды».
#[test]
fn an_excluded_document_stays_out_and_a_double_pick_comes_once() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 3);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm"), document("tm-2")])
        .unwrap();
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2", "tm-3"]);

    host.select(&project, vec![collection("tm"), exclude("tm-2")])
        .unwrap();
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-3"]);
    fake.state().edit("tm-2", "Изменён");
    host.sync(&project).unwrap();
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-3"]);
}

/// `project-sources`, «Снять коллекцию»: its documents go, the brief may be
/// old.
#[test]
fn removing_the_collection_removes_its_sources() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    host.build_brief(&project);
    assert_eq!(
        host.select(&project, Vec::new()).unwrap(),
        SyncOutcome::Empty { changed: true }
    );
    assert!(host.outline_ids(&project).is_empty());
    assert_eq!(host.brief_state(&project), BriefState::Outdated);
    let view = &block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0];
    assert!(view.items.is_empty());
    assert_eq!(view.sync, None);
}

/// `outline-connector`, «Слишком большая коллекция».
#[test]
fn a_selection_over_the_limit_is_not_saved() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("huge", "Архив", 340);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    let error = block_on(service::selection_set(
        host.as_ref(),
        &project,
        ConnectorKind::Outline,
        vec![collection("huge")],
    ))
    .unwrap_err();
    let CommandError::Invalid { message } = &error else {
        panic!("{error:?}");
    };
    assert!(message.contains("200"), "{message}");
    assert!(message.contains("340"), "{message}");
    let view = &block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0];
    assert!(view.items.is_empty());
}

/// `outline-connector`, «Коллекция разрослась»: the 200 most recently
/// changed, and how many were left out.
#[test]
fn a_collection_that_grew_keeps_the_200_most_recent() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 150);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    {
        let mut state = fake.state();
        for index in 151..=230 {
            state.add_doc("tm", &format!("tm-{index}"), None);
        }
    }
    assert_eq!(host.sync(&project).unwrap(), sync_ok(true, 30));
    let ids = host.outline_ids(&project);
    assert_eq!(ids.len(), 200);
    // The oldest 30 (tm-1…tm-30) are the ones left out.
    assert!(!ids.contains(&"tm-30".to_owned()));
    assert!(ids.contains(&"tm-31".to_owned()));
    assert!(ids.contains(&"tm-230".to_owned()));
    let view = &block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0];
    assert_eq!(view.sync.as_ref().unwrap().skipped, 30);
}

/// `outline-connector`, «Коллекцию удалили».
#[test]
fn a_deleted_collection_is_unavailable_and_its_documents_go() {
    let host = Host::new();
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("tm", "Телемедиа", 2);
        state.add_collection("old", "Старое", 2);
    }
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm"), collection("old")])
        .unwrap();
    fake.state().delete_collection("old");
    assert_eq!(host.sync(&project).unwrap(), sync_ok(true, 0));
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
    let view = &block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0];
    let old = view
        .items
        .iter()
        .find(|item| item.external_id == "old")
        .unwrap();
    assert_eq!(old.status, ItemStatus::Unavailable);
    let tm = view
        .items
        .iter()
        .find(|item| item.external_id == "tm")
        .unwrap();
    assert_eq!(tm.status, ItemStatus::Ok);
}

/// `outline-connector`, «Пустой документ»: «нет текста», not for the agent.
#[test]
fn a_document_with_only_a_title_has_no_text() {
    let host = Host::new();
    let fake = FakeOutline::start();
    {
        let mut state = fake.state();
        state.add_collection("tm", "Телемедиа", 2);
        state.edit("tm-2", "  \n ");
    }
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    let empty = host
        .sources(&project)
        .into_iter()
        .find(|source| source.origin.as_ref().unwrap().external_id == "tm-2")
        .unwrap();
    assert_eq!(empty.status, SourceStatus::NoText);
    assert_eq!(empty.error.as_deref(), Some("В документе нет текста"));
    let id = project.clone();
    let texts = block_on(host.storage.read(move |db| sources::ready_texts(db, &id))).unwrap();
    assert_eq!(
        texts
            .iter()
            .map(|source| source.name.as_str())
            .collect::<Vec<_>>(),
        ["Outline: Документ tm-1"]
    );
}

/// A selection made with another team: «недоступно», and nothing removed.
#[test]
fn a_selection_of_another_team_is_unavailable_and_removes_nothing() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    {
        let mut state = fake.state();
        state.team = ("team-other".to_owned(), "Другая".to_owned());
    }
    host.connect(&fake);
    host.sync(&project).unwrap();
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
    let view = &block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0];
    assert!(view.items[0].other_account);
    assert_eq!(view.items[0].status, ItemStatus::Unavailable);
}

/// One sync per project: a second request joins the running one.
#[test]
fn two_requests_make_one_sync() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    let lists = fake.state().requests("documents.list");
    fake.state().delay = Duration::from_millis(300);
    let (first, second) = block_on(async {
        tokio::join!(
            sync::sync_project(&host, &project, ConnectorKind::Outline),
            sync::sync_project(&host, &project, ConnectorKind::Outline),
        )
    });
    assert_eq!(first, second);
    assert_eq!(fake.state().requests("documents.list"), lists + 1);
    assert!(
        !host
            .connectors
            .flights
            .is_running(&project, ConnectorKind::Outline)
    );
}

/* Replies never carry the key (task 3.4) */

#[test]
fn no_reply_has_the_key() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    let project = host.project("Телемедиа");
    let mut replies: Vec<Value> = vec![serde_json::to_value(host.connect(&fake)).unwrap()];
    replies.push(serde_json::to_value(block_on(service::list(host.as_ref())).unwrap()).unwrap());
    replies.push(
        serde_json::to_value(
            block_on(service::browse(host.as_ref(), ConnectorKind::Outline, None)).unwrap(),
        )
        .unwrap(),
    );
    replies.push(
        serde_json::to_value(
            block_on(service::selection_set(
                host.as_ref(),
                &project,
                ConnectorKind::Outline,
                vec![collection("tm")],
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    host.sync(&project).unwrap();
    replies.push(
        serde_json::to_value(block_on(service::selection_get(host.as_ref(), &project)).unwrap())
            .unwrap(),
    );
    replies.push(serde_json::to_value(host.sources(&project)).unwrap());
    fake.state().key = "revoked".to_owned();
    host.sync(&project).unwrap();
    let error = block_on(service::browse(host.as_ref(), ConnectorKind::Outline, None)).unwrap_err();
    replies.push(serde_json::to_value(&error).unwrap());
    replies.push(serde_json::to_value(block_on(service::list(host.as_ref())).unwrap()).unwrap());
    replies.push(serde_json::to_value(host.events()).unwrap());
    for reply in replies {
        assert!(!reply.to_string().contains(KEY), "{reply}");
        assert!(!reply.to_string().contains("ol_api_"), "{reply}");
    }
}

/* The brief before a call (`project-brief`) */

/// An agent that runs until it is cancelled.
struct Waiting;

impl Agent for Waiting {
    fn run(
        &self,
        _request: AgentRequest,
        cancel: tokio::sync::oneshot::Receiver<()>,
    ) -> AgentFuture<'_> {
        Box::pin(async move {
            let _ = cancel.await;
            Err(AgentError::Cancelled)
        })
    }
}

/// «Документ Outline изменился до звонка»: the sync brings the new text and
/// the brief starts to rebuild.
#[test]
fn prepare_syncs_first_then_rebuilds_an_outdated_brief() {
    let host = Host::new();
    *host.agent.lock().unwrap() = Some(Arc::new(Waiting));
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    host.build_brief(&project);
    let builds = BriefBuilds::default();
    assert!(
        !block_on(prepare(&host, &builds, &project)).unwrap(),
        "fresh: nothing to do"
    );

    fake.state().edit("tm-1", "Перезвон за 3 минуты");
    assert!(block_on(prepare(&host, &builds, &project)).unwrap());
    assert_eq!(host.text_of(&project, "tm-1"), "Перезвон за 3 минуты");
    assert!(builds.is_building(&project));
    builds.cancel(&project);
}

/// «Ключ отозвали перед звонком»: the brief is built from the last text,
/// the project says the sources were not updated.
#[test]
fn prepare_with_a_revoked_key_builds_from_the_last_text() {
    let host = Host::new();
    *host.agent.lock().unwrap() = Some(Arc::new(Waiting));
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    fake.state().key = "revoked".to_owned();
    let builds = BriefBuilds::default();
    // No brief yet, materials are there: it builds.
    assert!(block_on(prepare(&host, &builds, &project)).unwrap());
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
    let view = &block_on(service::selection_get(host.as_ref(), &project)).unwrap()[0];
    assert_eq!(
        view.sync.as_ref().unwrap().error.as_deref(),
        Some("Ключ больше не подходит")
    );
    builds.cancel(&project);
}

/// Outline that never answers: `resolve` waits forever.
struct Silent {
    entered: AtomicBool,
}

impl Connector for Silent {
    fn descriptor(&self) -> &'static Descriptor {
        ConnectorKind::Outline.descriptor()
    }

    fn verify<'a>(&'a self, _: &'a Session) -> BoxFuture<'a, Result<Account, ConnectorError>> {
        Box::pin(std::future::pending())
    }
}

impl SourceProvider for Silent {
    fn browse<'a>(
        &'a self,
        _: &'a Session,
        _: Option<&'a ExternalRef>,
    ) -> BoxFuture<'a, Result<Vec<BrowseNode>, ConnectorError>> {
        Box::pin(std::future::pending())
    }

    fn resolve<'a>(
        &'a self,
        _: &'a Session,
        _: &'a [SelectionItem],
    ) -> BoxFuture<'a, Result<Resolved, ConnectorError>> {
        self.entered.store(true, Ordering::SeqCst);
        Box::pin(std::future::pending())
    }

    fn fetch<'a>(
        &'a self,
        _: &'a Session,
        _: &'a [RemoteDoc],
    ) -> BoxFuture<'a, Result<Vec<DocText>, ConnectorError>> {
        Box::pin(std::future::pending())
    }
}

/// «Outline не отвечает перед звонком», on tokio's paused clock: after 30 s
/// the outdated brief rebuilds from the text already there, and the sync
/// runs on.
#[tokio::test(start_paused = true)]
async fn prepare_waits_for_a_silent_outline_at_most_30_seconds() {
    let silent = Arc::new(Silent {
        entered: AtomicBool::new(false),
    });
    let host = Host::with(Arc::clone(&silent) as Arc<dyn SourceProvider>);
    *host.agent.lock().unwrap() = Some(Arc::new(Waiting));
    let project = host
        .storage
        .write(&host.sink, |db| {
            projects::create(
                db,
                projects::ProjectCreate {
                    name: "Телемедиа".to_owned(),
                    ..projects::ProjectCreate::default()
                },
            )
        })
        .await
        .unwrap()
        .id;
    let id = project.clone();
    host.storage
        .write(&host.sink, move |db| {
            let account = Account {
                host: Some("https://wandry.getoutline.com".to_owned()),
                team_id: TEAM.to_owned(),
                team_name: "Wandry".to_owned(),
                user_name: None,
            };
            stored::save_connected(db, ConnectorKind::Outline, &account, 1)?;
            stored::replace_selection(
                db,
                &id,
                ConnectorKind::Outline,
                Some(TEAM),
                &[collection("tm")],
                1,
            )?;
            let text = "Старый текст".to_owned();
            let changes = ConnectorChanges {
                upserts: vec![ConnectorDocument {
                    external_id: "tm-1".to_owned(),
                    title: "Бриф".to_owned(),
                    url: None,
                    version: "v1".to_owned(),
                    status: SourceStatus::Ready,
                    sha256: crate::projects::sha256_hex(text.as_bytes()),
                    text_chars: 12,
                    text,
                    truncated: false,
                    error: None,
                }],
                account_ref: TEAM.to_owned(),
                removals: Vec::new(),
            };
            sources::apply_connector_changes(db, &id, ConnectorKind::Outline, &changes, 1)?;
            Ok(((), Vec::new()))
        })
        .await
        .unwrap();
    host.secrets
        .set(
            ConnectorKind::Outline,
            &Credential::ApiKey {
                key: KEY.to_owned(),
            },
        )
        .unwrap();

    let builds = BriefBuilds::default();
    let started = (tokio::time::Instant::now(), Instant::now());
    let task = {
        let (host, builds, project) = (Arc::clone(&host), builds.clone(), project.clone());
        tokio::spawn(async move { prepare(&host, &builds, &project).await })
    };
    // Busy until the sync asked Outline: the paused clock only jumps when
    // the runtime idles.
    while !silent.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    let started_build = task.await.unwrap().unwrap();
    assert!(
        started_build,
        "the brief (none yet) builds from the last text"
    );
    assert!(tokio::time::Instant::now() - started.0 >= SYNC_BEFORE_CALL);
    assert!(
        started.1.elapsed() < Duration::from_secs(10),
        "virtual time"
    );
    assert!(
        host.connectors
            .flights
            .is_running(&project, ConnectorKind::Outline),
        "the sync runs on"
    );
    let id = project.clone();
    let texts = host
        .storage
        .read(move |db| sources::ready_texts(db, &id))
        .await
        .unwrap();
    assert_eq!(texts[0].text, "Старый текст");
    assert_eq!(texts[0].name, "Outline: Бриф");
    builds.cancel(&project);
}

/// A key document of the brief may name an Outline source: the build keeps
/// it (`F1…` resolve to every `ready` source).
#[test]
fn a_key_document_may_be_an_outline_source() {
    use crate::projects::{
        brief::{input::compose, run::brief_of},
        brief_inputs,
    };

    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 1);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    let id = project.clone();
    let inputs = block_on(host.storage.read(move |db| brief_inputs::read(db, &id))).unwrap();
    let message = compose(&inputs).unwrap();
    assert!(
        message.text.contains("name=\"Outline: Документ tm-1\""),
        "{}",
        message.text
    );
    let source_id = host.sources(&project)[0].id.clone();
    assert_eq!(message.documents["F1"], source_id);
    let reply = json!({
        "product": "Колл-центр",
        "stack": [],
        "modules": [],
        "glossary": [],
        "keyDocuments": [{ "sourceId": "F1", "title": "Бриф", "why": "Главный документ" }],
        "gaps": [],
    });
    let mut brief = brief_of(reply, &message).unwrap();
    let ready: Vec<String> = host
        .sources(&project)
        .into_iter()
        .filter(|source| source.status == SourceStatus::Ready)
        .map(|source| source.id)
        .collect();
    brief.keep_documents(&ready);
    assert_eq!(brief.key_documents.len(), 1);
    assert_eq!(brief.key_documents[0].source_id, source_id);
}

/* Storage events (task 1.4) */

#[test]
fn connection_writes_send_their_events() {
    let connection = crate::storage::open_in_memory().unwrap();
    let account = Account {
        host: None,
        team_id: "t".to_owned(),
        team_name: "T".to_owned(),
        user_name: None,
    };
    let kind = ConnectorKind::Outline;
    let (_, events) = stored::save_connected(&connection, kind, &account, 1).unwrap();
    assert_eq!(events[0].entity, Entity::Connections);
    assert_eq!(events[0].change, Change::Created);
    // A success that only moves the time sends nothing of its own.
    assert!(
        stored::record_ok(&connection, kind, None, 2)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        stored::record_failure(
            &connection,
            kind,
            ErrorKind::Unreachable,
            "нет сети",
            false,
            3
        )
        .unwrap()
        .len(),
        1
    );
    assert_eq!(
        stored::record_ok(&connection, kind, None, 4).unwrap().len(),
        1
    );
    assert_eq!(
        serde_json::to_value(stored::selection_changed("p", kind)).unwrap(),
        json!({ "entity": "connectorSelections", "id": "outline", "projectId": "p", "change": "updated" })
    );
}

/* Review fixes */

fn selection_view(host: &Host, project: &str) -> service::ProjectConnectorView {
    block_on(service::selection_get(host, project)).unwrap()[0].clone()
}

/// Reconnects the fake as another team that has its own collection `b`
/// and no longer the first team's `tm`.
fn switch_team(host: &Arc<Host>, fake: &FakeOutline) {
    {
        let mut state = fake.state();
        state.team = ("team-other".to_owned(), "Другая".to_owned());
        state.delete_collection("tm");
        state.add_collection("b", "Вторая", 2);
    }
    host.connect(fake);
}

/// Saving the selection again keeps another team's item that team's:
/// «другая команда», its documents stay (nothing of it is removed until
/// the manager decides).
#[test]
fn saving_again_keeps_the_other_teams_items_and_sources() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    switch_team(&host, &fake);

    host.select(&project, vec![collection("tm"), collection("b")])
        .unwrap();
    let view = selection_view(&host, &project);
    let other: Vec<_> = view
        .items
        .iter()
        .map(|item| (item.external_id.as_str(), item.other_account))
        .collect();
    assert_eq!(other, [("tm", true), ("b", false)]);
    assert_eq!(host.outline_ids(&project), ["b-1", "b-2", "tm-1", "tm-2"]);
    host.sync(&project).unwrap();
    assert_eq!(host.outline_ids(&project), ["b-1", "b-2", "tm-1", "tm-2"]);
}

/// With another team's item kept, the connected team's documents still
/// leave: archived ones on a sync, unpicked ones with their item.
#[test]
fn another_teams_items_protect_only_that_teams_sources() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    switch_team(&host, &fake);
    host.select(&project, vec![collection("tm"), collection("b")])
        .unwrap();

    fake.state().archive("b-1");
    host.sync(&project).unwrap();
    assert_eq!(host.outline_ids(&project), ["b-2", "tm-1", "tm-2"]);

    host.select(&project, vec![collection("tm")]).unwrap();
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);

    // The manager takes the other team's item off too: its documents go.
    host.select(&project, Vec::new()).unwrap();
    assert!(host.outline_ids(&project).is_empty());
}

/// `outline-connector`: the selection can always be changed or removed,
/// Outline connected or not; only something new needs the connection.
#[test]
fn a_disconnected_selection_can_be_cut_but_not_grown() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    fake.state().add_collection("dc", "Документы", 1);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm"), collection("dc")])
        .unwrap();
    block_on(service::disconnect(host.as_ref(), ConnectorKind::Outline)).unwrap();

    let view = block_on(service::selection_set(
        host.as_ref(),
        &project,
        ConnectorKind::Outline,
        vec![collection("tm")],
    ))
    .unwrap();
    assert_eq!(view.items.len(), 1);
    assert_eq!(view.items[0].external_id, "tm");
    assert!(!view.items[0].other_account);

    let error = block_on(service::selection_set(
        host.as_ref(),
        &project,
        ConnectorKind::Outline,
        vec![collection("tm"), collection("new")],
    ))
    .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(selection_view(&host, &project).items.len(), 1);

    // Reconnected: the kept item is the team's own and syncs.
    host.connect(&fake);
    host.sync(&project).unwrap();
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
}

/// A Keychain that refuses to read (locked, the prompt denied) is not a
/// revoked key: the connection stands, the error says Keychain.
#[test]
fn a_refused_keychain_read_does_not_break_the_connection() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    host.secrets.fail_reads(true);

    block_on(service::verify(host.as_ref(), ConnectorKind::Outline)).unwrap();
    let connection = connections(&host)[0].clone();
    assert_eq!(connection.status, ConnectionStatus::Connected);
    assert_eq!(connection.error_kind, Some(ErrorKind::Other));
    assert!(
        connection.error.as_deref().unwrap().contains("Keychain"),
        "{:?}",
        connection.error
    );

    let outcome = host.sync(&project).unwrap();
    assert!(matches!(
        outcome,
        SyncOutcome::Failed {
            kind: ErrorKind::Other,
            ..
        }
    ));
    assert_eq!(host.outline_ids(&project), ["tm-1", "tm-2"]);
    let error = block_on(service::browse(host.as_ref(), ConnectorKind::Outline, None)).unwrap_err();
    assert!(error.to_string().contains("Keychain"), "{error}");
    assert_eq!(connections(&host)[0].status, ConnectionStatus::Connected);

    host.secrets.fail_reads(false);
    block_on(service::verify(host.as_ref(), ConnectorKind::Outline)).unwrap();
    assert_eq!(connections(&host)[0].error_kind, None);
}

/// A connect that can't read the key already there writes nothing: a
/// rollback could not put it back.
#[test]
fn a_connect_that_cannot_read_the_old_key_writes_nothing() {
    let host = Host::new();
    let fake = FakeOutline::start();
    host.connect(&fake);
    let before = host.secrets.raw();
    host.secrets.fail_reads(true);
    let error = block_on(service::connect_api_key(
        &host,
        ConnectorKind::Outline,
        &fake.origin,
        KEY,
        None,
    ))
    .unwrap_err();
    assert!(error.to_string().contains("Keychain"), "{error}");
    assert_eq!(host.secrets.raw(), before);
}

/// A 403 on `auth.info` refuses the whole key: `error`, «Нет доступа»; a
/// 403 on one collection only makes that item unavailable.
#[test]
fn a_forbidden_key_breaks_the_connection_a_forbidden_collection_does_not() {
    let host = Host::new();
    let fake = FakeOutline::start();
    fake.state().add_collection("tm", "Телемедиа", 2);
    fake.state().add_collection("hidden", "Секрет", 1);
    host.connect(&fake);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm"), collection("hidden")])
        .unwrap();

    fake.state().collections[1].forbidden = true;
    host.sync(&project).unwrap();
    let view = selection_view(&host, &project);
    assert_eq!(view.items[1].status, ItemStatus::Unavailable);
    assert_eq!(connections(&host)[0].status, ConnectionStatus::Connected);
    block_on(service::verify(host.as_ref(), ConnectorKind::Outline)).unwrap();
    assert_eq!(connections(&host)[0].status, ConnectionStatus::Connected);

    fake.state().auth_forbidden = true;
    block_on(service::verify(host.as_ref(), ConnectorKind::Outline)).unwrap();
    let view = &block_on(service::list(host.as_ref())).unwrap()[0];
    assert_eq!(view.status, ConnectorStatus::Error);
    assert_eq!(view.error_kind, Some(ErrorKind::Forbidden));
    assert_eq!(view.error.as_deref(), Some("Нет доступа к Outline"));
}

/// A project with an Outline connection, a selection of `tm`, a key in
/// the store and no request made, for a provider of the test's own.
async fn seeded(host: &Arc<Host>) -> String {
    let project = host
        .storage
        .write(&host.sink, |db| {
            projects::create(
                db,
                projects::ProjectCreate {
                    name: "Телемедиа".to_owned(),
                    ..projects::ProjectCreate::default()
                },
            )
        })
        .await
        .unwrap()
        .id;
    let id = project.clone();
    host.storage
        .write(&host.sink, move |db| {
            let account = Account {
                host: Some("https://wandry.getoutline.com".to_owned()),
                team_id: TEAM.to_owned(),
                team_name: "Wandry".to_owned(),
                user_name: None,
            };
            stored::save_connected(db, ConnectorKind::Outline, &account, 1)?;
            stored::replace_selection(
                db,
                &id,
                ConnectorKind::Outline,
                Some(TEAM),
                &[collection("tm")],
                1,
            )?;
            Ok(((), Vec::new()))
        })
        .await
        .unwrap();
    host.secrets
        .set(
            ConnectorKind::Outline,
            &Credential::ApiKey {
                key: KEY.to_owned(),
            },
        )
        .unwrap();
    project
}

/// A provider whose `resolve` panics, or answers «unreachable» after
/// `delay` (tokio's clock).
struct Scripted {
    panics: bool,
    delay: Duration,
    entered: AtomicBool,
}

impl Scripted {
    fn new(panics: bool, delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            panics,
            delay,
            entered: AtomicBool::new(false),
        })
    }
}

impl Connector for Scripted {
    fn descriptor(&self) -> &'static Descriptor {
        ConnectorKind::Outline.descriptor()
    }

    fn verify<'a>(&'a self, _: &'a Session) -> BoxFuture<'a, Result<Account, ConnectorError>> {
        Box::pin(std::future::pending())
    }
}

impl SourceProvider for Scripted {
    fn browse<'a>(
        &'a self,
        _: &'a Session,
        _: Option<&'a ExternalRef>,
    ) -> BoxFuture<'a, Result<Vec<BrowseNode>, ConnectorError>> {
        Box::pin(std::future::pending())
    }

    fn resolve<'a>(
        &'a self,
        _: &'a Session,
        _: &'a [SelectionItem],
    ) -> BoxFuture<'a, Result<Resolved, ConnectorError>> {
        self.entered.store(true, Ordering::SeqCst);
        Box::pin(async move {
            assert!(!self.panics, "a bug in the connector");
            tokio::time::sleep(self.delay).await;
            Err(ConnectorError::Unreachable("Outline не ответил".to_owned()))
        })
    }

    fn fetch<'a>(
        &'a self,
        _: &'a Session,
        _: &'a [RemoteDoc],
    ) -> BoxFuture<'a, Result<Vec<DocText>, ConnectorError>> {
        Box::pin(std::future::pending())
    }
}

/// A sync that panics frees its place: the callers get an error, the
/// project is not «syncing» forever, and the next request starts anew.
#[test]
fn a_panicking_sync_leaves_no_flight_behind() {
    let host = Host::with(Scripted::new(true, Duration::ZERO) as Arc<dyn SourceProvider>);
    let project = block_on(seeded(&host));
    for _ in 0..2 {
        let (first, second) = block_on(async {
            tokio::join!(
                sync::sync_project(&host, &project, ConnectorKind::Outline),
                sync::sync_project(&host, &project, ConnectorKind::Outline),
            )
        });
        assert!(first.is_err(), "{first:?}");
        assert!(second.is_err(), "{second:?}");
        assert!(
            !host
                .connectors
                .flights
                .is_running(&project, ConnectorKind::Outline)
        );
    }
}

/// The 30 s before a call cut only the waiting: the connectors after a
/// slow one still sync (here GitHub, «не подключён»).
#[tokio::test(start_paused = true)]
async fn prepare_lets_every_connector_sync_after_30_seconds() {
    let slow = Scripted::new(false, Duration::from_secs(40));
    let host = Host::with(Arc::clone(&slow) as Arc<dyn SourceProvider>);
    *host.agent.lock().unwrap() = Some(Arc::new(Waiting));
    let project = seeded(&host).await;
    let id = project.clone();
    host.storage
        .write(&host.sink, move |db| {
            stored::replace_selection(
                db,
                &id,
                ConnectorKind::GitHub,
                Some(TEAM),
                &[collection("repo")],
                1,
            )?;
            Ok(((), Vec::new()))
        })
        .await
        .unwrap();

    let builds = BriefBuilds::default();
    let task = {
        let (host, builds, project) = (Arc::clone(&host), builds.clone(), project.clone());
        tokio::spawn(async move { prepare(&host, &builds, &project).await })
    };
    while !slow.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    task.await.unwrap().unwrap();
    let github = || {
        let id = project.clone();
        let host = Arc::clone(&host);
        async move {
            host.storage
                .read(move |db| stored::sync_state(db, &id, ConnectorKind::GitHub))
                .await
                .unwrap()
        }
    };
    assert_eq!(github().await, None, "Outline is still being synced");
    let mut state = None;
    for _ in 0..120 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        state = github().await;
        if state.is_some() {
            break;
        }
    }
    assert_eq!(
        state.and_then(|state| state.error_kind),
        Some(ErrorKind::Disconnected)
    );
    builds.cancel(&project);
}

/* Workspaces and nested containers (connectors-clickup, tasks 1.1–1.2) */

/// A service whose key opens two workspaces (registered as Outline: the
/// service's logic is the same for every connector that signs in with a
/// key).
struct TwoWorkspaces;

fn two_workspaces() -> Vec<Workspace> {
    vec![
        Workspace {
            id: "w-pixel".to_owned(),
            name: "Pixel Agency".to_owned(),
        },
        Workspace {
            id: "w-own".to_owned(),
            name: "Личное".to_owned(),
        },
    ]
}

impl Connector for TwoWorkspaces {
    fn descriptor(&self) -> &'static Descriptor {
        ConnectorKind::Outline.descriptor()
    }

    fn verify<'a>(&'a self, _: &'a Session) -> BoxFuture<'a, Result<Account, ConnectorError>> {
        Box::pin(async { Err(ConnectorError::Other("не тот вызов".to_owned())) })
    }

    fn verify_in<'a>(
        &'a self,
        session: &'a Session,
        workspace: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Verified, ConnectorError>> {
        Box::pin(async move {
            if session.credential
                != (Credential::ApiKey {
                    key: KEY.to_owned(),
                })
            {
                return Err(ConnectorError::Unauthorized);
            }
            let all = two_workspaces();
            Ok(
                match all.iter().find(|w| Some(w.id.as_str()) == workspace) {
                    Some(picked) => Verified::Account(Account {
                        host: session.host.clone(),
                        team_id: picked.id.clone(),
                        team_name: picked.name.clone(),
                        user_name: Some("Дима".to_owned()),
                    }),
                    None => Verified::Choose(all),
                },
            )
        })
    }
}

impl SourceProvider for TwoWorkspaces {
    fn browse<'a>(
        &'a self,
        _: &'a Session,
        _: Option<&'a ExternalRef>,
    ) -> BoxFuture<'a, Result<Vec<BrowseNode>, ConnectorError>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn resolve<'a>(
        &'a self,
        _: &'a Session,
        _: &'a [SelectionItem],
    ) -> BoxFuture<'a, Result<Resolved, ConnectorError>> {
        Box::pin(async { Ok(Resolved::default()) })
    }

    fn fetch<'a>(
        &'a self,
        _: &'a Session,
        _: &'a [RemoteDoc],
    ) -> BoxFuture<'a, Result<Vec<DocText>, ConnectorError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

fn connect_in(host: &Arc<Host>, workspace: Option<&str>) -> ConnectOutcome {
    block_on(service::connect_api_key(
        host,
        ConnectorKind::Outline,
        "https://docs.example.com",
        KEY,
        workspace,
    ))
    .unwrap()
}

/// `clickup-connector`, «Несколько пространств»: nothing is saved until one
/// is picked, then the connection is the picked one's.
#[test]
fn a_key_of_several_workspaces_connects_only_after_a_pick() {
    let host = Host::with(Arc::new(TwoWorkspaces));
    let outcome = connect_in(&host, None);
    assert_eq!(
        outcome,
        ConnectOutcome::ChooseWorkspace {
            workspaces: two_workspaces()
        }
    );
    assert_eq!(
        serde_json::to_value(&outcome).unwrap(),
        json!({ "chooseWorkspace": { "workspaces": [
            { "id": "w-pixel", "name": "Pixel Agency" },
            { "id": "w-own", "name": "Личное" },
        ] } })
    );
    assert!(host.secrets.raw().is_empty(), "no secret before the pick");
    assert!(connections(&host).is_empty(), "no row before the pick");
    assert!(host.events().is_empty());

    let ConnectOutcome::Connected(view) = connect_in(&host, Some("w-own")) else {
        panic!("connects to the picked one");
    };
    let account = view.account.unwrap();
    assert_eq!(
        (account.team_id.as_str(), account.team_name.as_str()),
        ("w-own", "Личное")
    );
    assert_eq!(connections(&host)[0].account.team_id, "w-own");
    assert_eq!(
        host.secrets.get(ConnectorKind::Outline).unwrap(),
        Credential::ApiKey {
            key: KEY.to_owned()
        }
    );
}

/// A workspace the key doesn't open is refused at the key, nothing saved.
#[test]
fn a_workspace_the_key_does_not_open_is_refused() {
    let host = Host::with(Arc::new(TwoWorkspaces));
    assert_eq!(
        connect_in(&host, Some("w-stranger")),
        ConnectOutcome::Rejected {
            field: RejectedField::Key,
            reason: "Ключ не открывает это пространство".to_owned()
        }
    );
    assert!(host.secrets.raw().is_empty());
    assert!(connections(&host).is_empty());
}

/// Outline has one team per key: `verify_in` is its `verify`, and a
/// workspace given is checked against that team.
#[test]
fn outline_connects_as_before_with_or_without_a_workspace() {
    let host = Host::new();
    let fake = FakeOutline::start();
    let connect = |workspace| {
        block_on(service::connect_api_key(
            &host,
            ConnectorKind::Outline,
            &fake.origin,
            KEY,
            workspace,
        ))
        .unwrap()
    };
    assert_eq!(
        connect(Some("team-other")),
        ConnectOutcome::Rejected {
            field: RejectedField::Key,
            reason: "Ключ не открывает это пространство".to_owned()
        }
    );
    assert!(connections(&host).is_empty());
    assert!(matches!(connect(Some(TEAM)), ConnectOutcome::Connected(_)));
    assert!(matches!(connect(None), ConnectOutcome::Connected(_)));
    assert_eq!(fake.state().requests("auth.info"), 3);
}

/// Task 1.2: a container left out of a picked container (a list in a
/// picked space) is stored and given back like a left-out document; the
/// ids are the connector's, opaque here.
#[test]
fn an_excluded_container_is_stored_like_an_excluded_document() {
    let host = Host::with(Arc::new(TwoWorkspaces));
    connect_in(&host, Some("w-pixel"));
    let project = host.project("Телемедиа");
    let items = vec![
        collection("space:90"),
        exclude("list:901"),
        exclude("task-7"),
        document("task-9"),
    ];
    block_on(service::selection_set(
        host.as_ref(),
        &project,
        ConnectorKind::Outline,
        items.clone(),
    ))
    .unwrap();
    let view = selection_view(&host, &project);
    let stored: Vec<SelectionItem> = view
        .items
        .iter()
        .map(|item| SelectionItem {
            item_kind: item.item_kind,
            external_id: item.external_id.clone(),
            title: item.title.clone(),
            url: item.url.clone(),
        })
        .collect();
    assert_eq!(stored, items);
    assert!(view.items.iter().all(|item| !item.other_account));
    assert!(view.items.iter().all(|item| item.status == ItemStatus::Ok));
}

/// Disconnecting cancels a sync that waits (for ClickUp's rate limit):
/// its callers get an error at once and the place is free again.
#[tokio::test(start_paused = true)]
async fn disconnecting_cancels_a_running_sync() {
    let slow = Scripted::new(false, Duration::from_secs(3600));
    let host = Host::with(Arc::clone(&slow) as Arc<dyn SourceProvider>);
    let project = seeded(&host).await;
    let waiting = {
        let (host, project) = (Arc::clone(&host), project.clone());
        tokio::spawn(
            async move { sync::sync_project(&host, &project, ConnectorKind::Outline).await },
        )
    };
    while !slow.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    let started = tokio::time::Instant::now();
    service::disconnect(host.as_ref(), ConnectorKind::Outline)
        .await
        .unwrap();
    let result = waiting.await.unwrap();
    assert!(result.is_err(), "{result:?}");
    assert!(tokio::time::Instant::now() - started < Duration::from_secs(60));
    assert!(
        !host
            .connectors
            .flights
            .is_running(&project, ConnectorKind::Outline)
    );
}

/* Cancelled syncs (connectors-clickup review) */

/// A cancelled sync frees its place at once: the project is no longer
/// «syncing» on the read after the disconnect, and the cancelled task,
/// leaving later, doesn't free the place of a sync started after it.
#[tokio::test]
async fn a_cancelled_sync_frees_its_place_at_once() {
    let silent = Arc::new(Silent {
        entered: AtomicBool::new(false),
    });
    let host = Host::with(Arc::clone(&silent) as Arc<dyn SourceProvider>);
    let project = seeded(&host).await;
    let outline = ConnectorKind::Outline;
    let first = {
        let (host, project) = (Arc::clone(&host), project.clone());
        tokio::spawn(async move { sync::sync_project(&host, &project, outline).await })
    };
    while !silent.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    host.connectors.flights.cancel(outline);
    assert!(!host.connectors.flights.is_running(&project, outline));
    let views = service::selection_get(host.as_ref(), &project)
        .await
        .unwrap();
    assert!(!views[0].syncing);

    silent.entered.store(false, Ordering::SeqCst);
    let second = {
        let (host, project) = (Arc::clone(&host), project.clone());
        tokio::spawn(async move { sync::sync_project(&host, &project, outline).await })
    };
    while !silent.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    assert!(first.await.unwrap().is_err(), "the cancelled one's callers");
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert!(
        host.connectors.flights.is_running(&project, outline),
        "the newer sync keeps its place"
    );
    host.connectors.flights.cancel(outline);
    assert!(second.await.unwrap().is_err());
}

const NEW_KEY: &str = "ol_api_rotated_7Hq2LmT9vRb4KcN8wYp3HsDa";

/// A service whose old key ([`KEY`]) is revoked: a sync with it waits
/// until `release`, then is refused; the new key ([`NEW_KEY`]) works.
#[derive(Default)]
struct Rotated {
    entered: AtomicBool,
    release: tokio::sync::Notify,
    fresh: std::sync::atomic::AtomicUsize,
}

fn key_of(session: &Session) -> &str {
    match &session.credential {
        Credential::ApiKey { key } => key,
        Credential::OAuth { access, .. } => access,
    }
}

impl Connector for Rotated {
    fn descriptor(&self) -> &'static Descriptor {
        ConnectorKind::Outline.descriptor()
    }

    fn verify<'a>(
        &'a self,
        session: &'a Session,
    ) -> BoxFuture<'a, Result<Account, ConnectorError>> {
        Box::pin(async move {
            if key_of(session) != NEW_KEY {
                return Err(ConnectorError::Unauthorized);
            }
            Ok(Account {
                host: session.host.clone(),
                team_id: TEAM.to_owned(),
                team_name: "Wandry".to_owned(),
                user_name: None,
            })
        })
    }
}

impl SourceProvider for Rotated {
    fn browse<'a>(
        &'a self,
        _: &'a Session,
        _: Option<&'a ExternalRef>,
    ) -> BoxFuture<'a, Result<Vec<BrowseNode>, ConnectorError>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn resolve<'a>(
        &'a self,
        session: &'a Session,
        _: &'a [SelectionItem],
    ) -> BoxFuture<'a, Result<Resolved, ConnectorError>> {
        Box::pin(async move {
            if key_of(session) == NEW_KEY {
                self.fresh.fetch_add(1, Ordering::SeqCst);
                return Ok(Resolved::default());
            }
            self.entered.store(true, Ordering::SeqCst);
            self.release.notified().await;
            Err(ConnectorError::Unauthorized)
        })
    }

    fn fetch<'a>(
        &'a self,
        _: &'a Session,
        _: &'a [RemoteDoc],
    ) -> BoxFuture<'a, Result<Vec<DocText>, ConnectorError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// A reconnect with a new key cancels the sync that runs with the old one:
/// the resync starts anew with the new key, and the old key's refusal,
/// coming after, neither breaks the new connection nor reaches anyone.
#[tokio::test]
async fn a_reconnect_cancels_the_sync_of_the_old_key() {
    let rotated = Arc::new(Rotated::default());
    let host = Host::with(Arc::clone(&rotated) as Arc<dyn SourceProvider>);
    let project = seeded(&host).await;
    let outline = ConnectorKind::Outline;
    let old = {
        let (host, project) = (Arc::clone(&host), project.clone());
        tokio::spawn(async move { sync::sync_project(&host, &project, outline).await })
    };
    while !rotated.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    let outcome = service::connect_api_key(
        &host,
        outline,
        "https://wandry.getoutline.com",
        NEW_KEY,
        None,
    )
    .await
    .unwrap();
    assert!(
        matches!(outcome, ConnectOutcome::Connected(_)),
        "{outcome:?}"
    );
    // The old key's answer comes now: 401.
    rotated.release.notify_one();
    assert!(old.await.unwrap().is_err(), "the old sync was cancelled");
    for _ in 0..500 {
        if rotated.fresh.load(Ordering::SeqCst) > 0
            && !host.connectors.flights.is_running(&project, outline)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        rotated.fresh.load(Ordering::SeqCst),
        1,
        "a sync with the new key"
    );
    let connection = host
        .storage
        .read(move |db| stored::connection(db, outline))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(connection.status, ConnectionStatus::Connected);
    assert_eq!(connection.error, None);
    let id = project.clone();
    let state = host
        .storage
        .read(move |db| stored::sync_state(db, &id, outline))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.error, None, "{state:?}");
}
