//! The ClickUp client, its rate gate and the connector against the fake
//! ClickUp (`clickup::fake`), and the scenarios of `clickup-connector`
//! through the app's sync and brief (`connectors::testing::Host`).

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant as StdInstant, SystemTime},
};

use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::Value;
use tokio::time::Instant;

use super::{
    ClickUpConnector,
    client::{Client, Filter},
    fake::{FakeClickUp, OTHER_TEAM, Rate, TEAM, TOKEN},
    rate::{FALLBACK_WAIT, Observed, RESET_MARGIN, RETRIES, RateGate, Reply, SPACING, THROTTLED},
};
use crate::{
    connectors::{
        Account, Connector as _, ConnectorError, ConnectorKind, Credential, ExternalRef, RefKind,
        SelectionItem, SelectionItemKind, Session, SourceProvider as _, Verified, Workspace,
        secrets::SecretStore as _,
        service::{self, ConnectOutcome, ConnectorStatus, RejectedField},
        sync::{self, SyncOutcome},
        testing::{Host, block_on},
    },
    error::CommandError,
    projects::{
        brief::run::{SYNC_BEFORE_CALL, prepare},
        builds::BriefBuilds,
    },
    storage::{
        connectors::{self as stored, ItemStatus},
        projects::BriefState,
        sources,
    },
};

const CLICKUP: ConnectorKind = ConnectorKind::ClickUp;

fn session() -> Session {
    Session {
        host: None,
        credential: Credential::ApiKey {
            key: TOKEN.to_owned(),
        },
        team: Some(TEAM.to_owned()),
    }
}

fn connector(fake: &FakeClickUp) -> ClickUpConnector {
    ClickUpConnector::with(&fake.base, Duration::from_secs(5))
}

fn client(fake: &FakeClickUp) -> Client {
    connector(fake).client(&session()).unwrap()
}

fn item(item_kind: SelectionItemKind, id: &str) -> SelectionItem {
    SelectionItem {
        item_kind,
        external_id: id.to_owned(),
        title: format!("Пункт {id}"),
        url: None,
    }
}

fn container(id: &str) -> SelectionItem {
    item(SelectionItemKind::Container, id)
}

fn task(id: &str) -> SelectionItem {
    item(SelectionItemKind::Document, id)
}

fn exclude(id: &str) -> SelectionItem {
    item(SelectionItemKind::Exclude, id)
}

/// A host with ClickUp connected to the fake's one workspace, and a
/// project.
fn connected(fake: &FakeClickUp) -> (Arc<Host>, String) {
    let host = Host::clickup(fake);
    let outcome = host.connect_clickup(TOKEN, None);
    assert!(
        matches!(outcome, ConnectOutcome::Connected(_)),
        "{outcome:?}"
    );
    let project = host.project("Телемедиа");
    (host, project)
}

fn clickup_view(host: &Host, project: &str) -> service::ProjectConnectorView {
    block_on(service::selection_get(host, project))
        .unwrap()
        .into_iter()
        .find(|view| view.kind == CLICKUP)
        .unwrap()
}

/* The client (task 2.1) */

#[test]
fn requests_carry_the_token_without_bearer() {
    let fake = FakeClickUp::start();
    let user = block_on(client(&fake).user()).unwrap();
    assert_eq!(user.username.as_deref(), Some("Дима Капиш"));
    assert_eq!(user.id, "81234567", "a numeric id read as text");
    let teams = block_on(client(&fake).teams()).unwrap();
    assert_eq!(teams[0].id, TEAM);
    for logged in &fake.state().log {
        assert_eq!(logged.authorization.as_deref(), Some(TOKEN));
    }
}

#[test]
fn task_pages_are_joined_and_filtered_by_the_picked_containers() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 230);
    }
    let client = client(&fake);
    let mut all = Vec::new();
    for page in 0..5 {
        let read = block_on(client.team_tasks(TEAM, Filter::Lists, &["l1".to_owned()], page, true))
            .unwrap();
        all.extend(read.tasks);
        if read.last {
            break;
        }
    }
    assert_eq!(all.len(), 230);
    let state = fake.state();
    let pages: Vec<&str> = state
        .log
        .iter()
        .filter(|logged| logged.path.ends_with("/task"))
        .map(|logged| logged.param("page").unwrap())
        .collect();
    assert_eq!(pages, ["0", "1", "2"]);
    let first = &state.log[0];
    assert_eq!(first.param("list_ids[]"), Some("l1"));
    assert_eq!(first.param("subtasks"), Some("true"));
    assert_eq!(first.param("include_closed"), Some("false"));
    assert_eq!(first.param("order_by"), Some("updated"));
    assert_eq!(first.param("include_markdown_description"), Some("true"));
}

#[test]
fn comment_pages_are_joined_oldest_first() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 1);
        for index in 1..=60 {
            state.comment("l1-1", "Аня", &format!("Комментарий {index}"));
        }
    }
    let comments = block_on(client(&fake).comments("l1-1")).unwrap();
    let texts: Vec<&str> = comments.iter().map(|c| c.comment_text.as_str()).collect();
    assert_eq!(texts.len(), 50, "two pages of 25");
    assert_eq!(texts[0], "Комментарий 11");
    assert_eq!(texts[49], "Комментарий 60");
    let state = fake.state();
    let calls: Vec<_> = state
        .log
        .iter()
        .filter(|logged| logged.path.ends_with("/comment"))
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].param("start"), None);
    assert_eq!(calls[1].param("start_id"), Some("l1-1-c36"));
}

#[test]
fn answers_map_to_errors_without_the_token() {
    let fake = FakeClickUp::start();
    let client = client(&fake);
    assert_eq!(block_on(client.list("nope")), Err(ConnectorError::NotFound));
    fake.state().token = "pk_other".to_owned();
    assert_eq!(block_on(client.user()), Err(ConnectorError::Unauthorized));
    fake.state().down = true;
    let down = block_on(client.user()).unwrap_err();
    assert!(matches!(down, ConnectorError::Unreachable(_)), "{down:?}");

    // No answer at all: the timeout.
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/api/v2", silent.local_addr().unwrap());
    let slow = ClickUpConnector::with(&base, Duration::from_millis(300));
    let started = StdInstant::now();
    let error = block_on(slow.client(&session()).unwrap().user()).unwrap_err();
    assert_eq!(
        error,
        ConnectorError::Unreachable("ClickUp не ответил за 15 секунд".to_owned())
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(silent);

    let debug = format!("{client:?} {:?} {down:?} {error:?}", session());
    assert!(!debug.contains(TOKEN), "{debug}");
    assert!(
        !debug.contains("Q9WZK3HLM2XPRT7VYB4NC6DJ8FGA5SEU"),
        "{debug}"
    );
}

/* The rate gate (task 2.2), on Tokio's paused clock */

fn headers(remaining: &str, reset: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-ratelimit-limit", HeaderValue::from_static("100"));
    headers.insert(
        "x-ratelimit-remaining",
        HeaderValue::from_str(remaining).unwrap(),
    );
    headers.insert("x-ratelimit-reset", HeaderValue::from_str(reset).unwrap());
    headers
}

fn unix_in(seconds: u64) -> SystemTime {
    SystemTime::now() + Duration::from_secs(seconds)
}

#[test]
fn rate_headers_are_read_leniently() {
    let observed = Observed::from_headers(&headers("0", "1767225660"));
    assert_eq!(observed.remaining, Some(0));
    assert_eq!(
        observed.reset,
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_767_225_660))
    );
    let fractional = Observed::from_headers(&headers("7", "1767225660.5"));
    assert_eq!(fractional.remaining, Some(7));
    assert_eq!(
        Observed::from_headers(&HeaderMap::new()),
        Observed::default()
    );
    assert_eq!(
        Observed::from_headers(&headers("lots", "soon")),
        Observed::default()
    );
}

/// A scripted ClickUp: each attempt takes the next answer.
fn script(
    answers: Vec<(Observed, bool)>,
) -> impl FnMut() -> std::future::Ready<(Observed, Reply<u32>)> {
    let answers = Arc::new(Mutex::new(answers.into_iter()));
    let mut count = 0;
    move || {
        count += 1;
        let (observed, throttled) = answers
            .lock()
            .unwrap()
            .next()
            .unwrap_or((Observed::default(), false));
        std::future::ready((
            observed,
            if throttled {
                Reply::Throttled
            } else {
                Reply::Answered(Ok(count))
            },
        ))
    }
}

fn exhausted(seconds: u64) -> Observed {
    Observed {
        remaining: Some(0),
        reset: Some(unix_in(seconds)),
    }
}

fn plenty() -> Observed {
    Observed {
        remaining: Some(99),
        reset: Some(unix_in(60)),
    }
}

/// «Остаток 0 → ждём до сброса»: the next request waits for the reset
/// plus a second.
#[tokio::test(start_paused = true)]
async fn none_remaining_waits_for_the_reset() {
    let gate = RateGate::default();
    let started = Instant::now();
    gate.send(script(vec![(exhausted(10), false)]))
        .await
        .unwrap();
    assert!(Instant::now() - started < Duration::from_millis(10));
    gate.send(script(vec![(plenty(), false)])).await.unwrap();
    let waited = Instant::now() - started;
    assert!(
        waited >= Duration::from_secs(9) + RESET_MARGIN,
        "{waited:?}"
    );
    assert!(
        waited <= Duration::from_secs(10) + RESET_MARGIN,
        "{waited:?}"
    );
    // The window is known again: no more waiting.
    let before = Instant::now();
    gate.send(script(vec![(plenty(), false)])).await.unwrap();
    assert_eq!(Instant::now(), before);
}

/// «429 → повтор после сброса».
#[tokio::test(start_paused = true)]
async fn a_429_is_retried_after_the_reset() {
    let gate = RateGate::default();
    let started = Instant::now();
    let tries = gate
        .send(script(vec![(exhausted(20), true), (plenty(), false)]))
        .await
        .unwrap();
    assert_eq!(tries, 2);
    let waited = Instant::now() - started;
    assert!(waited >= Duration::from_secs(19), "{waited:?}");
    assert!(waited <= Duration::from_secs(21), "{waited:?}");
}

/// A 429 without the reset header waits a minute.
#[tokio::test(start_paused = true)]
async fn a_429_without_a_reset_waits_a_minute() {
    let gate = RateGate::default();
    let started = Instant::now();
    gate.send(script(vec![(Observed::default(), true), (plenty(), false)]))
        .await
        .unwrap();
    assert_eq!(Instant::now() - started, FALLBACK_WAIT);
}

/// «Пять 429 → Unreachable»: five retries, then «ClickUp ограничил
/// запросы»; never a refused token.
#[tokio::test(start_paused = true)]
async fn throttled_after_every_retry_is_unreachable() {
    let gate = RateGate::default();
    let tries = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&tries);
    let result: Result<u32, _> = gate
        .send(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            std::future::ready((exhausted(5), Reply::Throttled))
        })
        .await;
    assert_eq!(
        result,
        Err(ConnectorError::Unreachable(THROTTLED.to_owned()))
    );
    assert!(!result.unwrap_err().refuses_secret());
    assert_eq!(tries.load(Ordering::SeqCst), 1 + RETRIES as usize);

    // Five 429s and then an answer: it goes through.
    let mut answers = vec![(exhausted(5), true); RETRIES as usize];
    answers.push((plenty(), false));
    assert_eq!(gate.send(script(answers)).await, Ok(1 + RETRIES));
}

/// Without rate headers the requests go 600 ms apart.
#[tokio::test(start_paused = true)]
async fn without_headers_requests_are_spaced() {
    let gate = RateGate::default();
    let started = Instant::now();
    for _ in 0..3 {
        gate.send(script(vec![(Observed::default(), false)]))
            .await
            .unwrap();
    }
    assert_eq!(Instant::now() - started, SPACING * 2);
}

/// At most four requests at once per connection.
#[tokio::test(start_paused = true)]
async fn at_most_four_requests_at_once() {
    let gate = Arc::new(RateGate::default());
    // ClickUp told its window: no spacing.
    gate.send(script(vec![(plenty(), false)])).await.unwrap();
    let now = Arc::new(AtomicUsize::new(0));
    let most = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let (gate, now, most) = (Arc::clone(&gate), Arc::clone(&now), Arc::clone(&most));
        tasks.push(tokio::spawn(async move {
            gate.send(|| {
                let (now, most) = (Arc::clone(&now), Arc::clone(&most));
                async move {
                    let running = now.fetch_add(1, Ordering::SeqCst) + 1;
                    most.fetch_max(running, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    now.fetch_sub(1, Ordering::SeqCst);
                    (plenty(), Reply::Answered(Ok(())))
                }
            })
            .await
        }));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert_eq!(most.load(Ordering::SeqCst), 4);
}

/// A request dropped while it waits (its sync cancelled) ends the wait and
/// gives its place to the next one.
#[tokio::test(start_paused = true)]
async fn a_cancelled_wait_frees_its_place() {
    let gate = Arc::new(RateGate::default());
    gate.exhaust_until(Instant::now() + Duration::from_secs(50));
    let mut waiting = Vec::new();
    for _ in 0..4 {
        let gate = Arc::clone(&gate);
        waiting.push(tokio::spawn(async move {
            gate.send(script(vec![(plenty(), false)])).await
        }));
    }
    while gate.sleeping.load(Ordering::SeqCst) < 4 {
        tokio::task::yield_now().await;
    }
    for task in &waiting {
        task.abort();
    }
    for task in waiting {
        assert!(task.await.unwrap_err().is_cancelled());
    }
    assert_eq!(gate.sleeping.load(Ordering::SeqCst), 0);
    // The places are free; the window still waits for its reset.
    let started = Instant::now();
    gate.send(script(vec![(plenty(), false)])).await.unwrap();
    assert!(Instant::now() - started <= Duration::from_secs(50));
}

/// «Отмена полёта прерывает ожидание»: a sync waiting for the limit ends
/// when ClickUp is disconnected, without a request.
#[tokio::test(start_paused = true)]
async fn cancelling_the_sync_ends_its_wait_for_the_limit() {
    let fake = FakeClickUp::start();
    let clickup = Arc::new(connector(&fake));
    clickup
        .gate()
        .exhaust_until(Instant::now() + Duration::from_secs(55));
    let host = Host::clickup_with(Arc::clone(&clickup));
    let project = seeded(&host, &[container("list:l1")]).await;
    let running = {
        let (host, project) = (Arc::clone(&host), project.clone());
        tokio::spawn(async move { sync::sync_project(&host, &project, CLICKUP).await })
    };
    while clickup.gate().sleeping.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let started = Instant::now();
    service::disconnect(host.as_ref(), CLICKUP).await.unwrap();
    let result = running.await.unwrap();
    assert!(result.is_err(), "{result:?}");
    assert!(Instant::now() - started < Duration::from_secs(55));
    assert_eq!(clickup.gate().sleeping.load(Ordering::SeqCst), 0);
    assert!(!host.connectors.flights.is_running(&project, CLICKUP));
    assert!(fake.state().log.is_empty(), "no request was made");
}

/// ClickUp connected to the fake's workspace with `items` selected and the
/// token in the store, without a request (for the paused clock).
async fn seeded(host: &Arc<Host>, items: &[SelectionItem]) -> String {
    let project = host
        .storage
        .write(&host.sink, |db| {
            crate::storage::projects::create(
                db,
                crate::storage::projects::ProjectCreate {
                    name: "Телемедиа".to_owned(),
                    ..crate::storage::projects::ProjectCreate::default()
                },
            )
        })
        .await
        .unwrap()
        .id;
    let (id, items) = (project.clone(), items.to_vec());
    host.storage
        .write(&host.sink, move |db| {
            let account = Account {
                host: None,
                team_id: TEAM.to_owned(),
                team_name: "Pixel Agency".to_owned(),
                user_name: None,
            };
            stored::save_connected(db, CLICKUP, &account, 1)?;
            stored::replace_selection(db, &id, CLICKUP, Some(TEAM), &items, 1)?;
            Ok(((), Vec::new()))
        })
        .await
        .unwrap();
    host.secrets
        .set(
            CLICKUP,
            &Credential::ApiKey {
                key: TOKEN.to_owned(),
            },
        )
        .unwrap();
    project
}

/* Signing in and the picker (task 2.3) */

#[test]
fn one_workspace_connects_at_once() {
    let fake = FakeClickUp::start();
    let host = Host::clickup(&fake);
    let ConnectOutcome::Connected(view) = host.connect_clickup(&format!("  {TOKEN} "), None) else {
        panic!("connects");
    };
    assert_eq!(view.status, ConnectorStatus::Connected);
    assert_eq!(
        view.account,
        Some(Account {
            host: None,
            team_id: TEAM.to_owned(),
            team_name: "Pixel Agency".to_owned(),
            user_name: Some("Дима Капиш".to_owned()),
        })
    );
    assert_eq!(fake.state().requests("/user"), 1);
    assert_eq!(fake.state().requests("/team"), 1);
    assert_eq!(
        host.secrets.get(CLICKUP).unwrap(),
        Credential::ApiKey {
            key: TOKEN.to_owned()
        }
    );
    // The token is nowhere in the database.
    let rows = block_on(host.storage.read(|db| {
        Ok(db.query_row(
            "SELECT json_group_array(account) FROM connections",
            [],
            |row| row.get::<_, String>(0),
        )?)
    }))
    .unwrap();
    assert!(!rows.contains(TOKEN), "{rows}");
}

#[test]
fn several_workspaces_are_picked_from_and_a_stranger_is_refused() {
    let fake = FakeClickUp::start();
    fake.state()
        .teams
        .push((OTHER_TEAM.to_owned(), "Личное".to_owned()));
    let host = Host::clickup(&fake);
    assert_eq!(
        host.connect_clickup(TOKEN, None),
        ConnectOutcome::ChooseWorkspace {
            workspaces: vec![
                Workspace {
                    id: TEAM.to_owned(),
                    name: "Pixel Agency".to_owned()
                },
                Workspace {
                    id: OTHER_TEAM.to_owned(),
                    name: "Личное".to_owned()
                },
            ]
        }
    );
    assert!(host.secrets.raw().is_empty());
    assert!(
        block_on(host.storage.read(stored::connections))
            .unwrap()
            .is_empty()
    );

    assert_eq!(
        host.connect_clickup(TOKEN, Some("9999")),
        ConnectOutcome::Rejected {
            field: RejectedField::Key,
            reason: "Токен не открывает это пространство".to_owned()
        }
    );
    assert!(host.secrets.raw().is_empty());

    let ConnectOutcome::Connected(view) = host.connect_clickup(TOKEN, Some(OTHER_TEAM)) else {
        panic!("connects to the picked one");
    };
    assert_eq!(view.account.unwrap().team_name, "Личное");
    // The check of the connection stays in the picked workspace.
    block_on(service::verify(host.as_ref(), CLICKUP)).unwrap();
    let view = &block_on(service::list(host.as_ref())).unwrap()[2];
    assert_eq!(view.status, ConnectorStatus::Connected);
    assert_eq!(view.account.as_ref().unwrap().team_id, OTHER_TEAM);
}

#[test]
fn a_refused_token_is_unauthorized() {
    let fake = FakeClickUp::start();
    let host = Host::clickup(&fake);
    assert_eq!(
        host.connect_clickup("pk_wrong_token", None),
        ConnectOutcome::Rejected {
            field: RejectedField::Key,
            reason: "Токен не подошёл".to_owned()
        }
    );
    assert_eq!(
        host.connect_clickup(" ", None),
        ConnectOutcome::Rejected {
            field: RejectedField::Key,
            reason: "Введите токен".to_owned()
        }
    );
    // ClickUp down: shown at the token's field (there is no other), the
    // token kept by the screen.
    fake.state().down = true;
    let outcome = host.connect_clickup(TOKEN, None);
    assert!(
        matches!(
            outcome,
            ConnectOutcome::Rejected {
                field: RejectedField::Key,
                ..
            }
        ),
        "{outcome:?}"
    );
    assert!(host.secrets.raw().is_empty());
    assert_eq!(
        block_on(connector(&fake).verify(&Session {
            credential: Credential::ApiKey {
                key: "pk_x".to_owned()
            },
            ..session()
        })),
        Err(ConnectorError::Unreachable(
            "ClickUp ответил ошибкой 503".to_owned()
        ))
    );
    fake.state().down = false;
    let verified = block_on(connector(&fake).verify_in(
        &Session {
            credential: Credential::ApiKey {
                key: "pk_x".to_owned(),
            },
            ..session()
        },
        None,
    ));
    assert_eq!(verified, Err(ConnectorError::Unauthorized));
}

/// The tree of a space with a folder and a list without one, down to the
/// tasks with their subtasks.
#[test]
fn the_tree_goes_space_folder_list_task() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_space("s2", "Внутреннее");
        state.add_folder("s1", "f1", "Телемедиа");
        state.add_list("s1", Some("f1"), "l1", 2);
        state.add_list("s1", Some("f1"), "l2", 3);
        state.add_list("s1", None, "l3", 1);
        state.add_task("l1", "l1-1a", Some("l1-1"));
        state.add_task("l1", "l1-1b", Some("l1-1"));
        state.close("l1-2");
    }
    let connector = connector(&fake);
    let session = session();
    let browse = |parent: Option<(&str, RefKind)>| {
        let parent = parent.map(|(id, kind)| ExternalRef {
            id: id.to_owned(),
            kind,
        });
        block_on(connector.browse(&session, parent.as_ref())).unwrap()
    };

    let spaces = browse(None);
    let ids: Vec<&str> = spaces.iter().map(|node| node.id.as_str()).collect();
    assert_eq!(ids, ["space:s1", "space:s2"]);
    assert!(spaces.iter().all(|node| node.kind == RefKind::Container
        && node.has_children
        && node.document_count == 0));

    let inside = browse(Some(("space:s1", RefKind::Container)));
    let summary: Vec<(&str, u32, usize)> = inside
        .iter()
        .map(|node| (node.id.as_str(), node.document_count, node.children.len()))
        .collect();
    assert_eq!(
        summary,
        [("folder:f1", 7, 2), ("list:l3", 1, 0)],
        "a folder counts its lists' tasks and brings them along"
    );
    assert_eq!(inside[0].children[1].id, "list:l2");
    assert_eq!(inside[0].children[1].title, "Список l2");

    let lists = browse(Some(("folder:f1", RefKind::Container)));
    assert_eq!(
        lists.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        ["list:l1", "list:l2"]
    );

    let tasks = browse(Some(("list:l1", RefKind::Container)));
    assert_eq!(tasks.len(), 1, "the closed task is not offered");
    let top = &tasks[0];
    assert_eq!(top.id, "l1-1");
    assert_eq!(top.kind, RefKind::Document);
    assert_eq!(top.document_count, 3);
    assert_eq!(top.url.as_deref(), Some("https://app.clickup.com/t/l1-1"));
    let mut subtasks: Vec<&str> = top.children.iter().map(|n| n.id.as_str()).collect();
    subtasks.sort_unstable();
    assert_eq!(subtasks, ["l1-1a", "l1-1b"]);

    let of_task = browse(Some(("l1-1", RefKind::Document)));
    assert_eq!(of_task.len(), 2);
}

/* Resolve and fetch (task 2.4) */

/// «Выбрать список»: its open tasks become sources with their links.
#[test]
fn a_selected_list_becomes_task_sources() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 14);
    }
    let (host, project) = connected(&fake);
    let outcome = host
        .select_in(CLICKUP, &project, vec![container("list:l1")])
        .unwrap();
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            changed: true,
            skipped: 0
        }
    );
    let sources = host.sources(&project);
    assert_eq!(sources.len(), 14);
    let source = sources
        .iter()
        .find(|source| source.origin.as_ref().unwrap().external_id == "l1-3")
        .unwrap();
    assert_eq!(source.name, "Задача l1-3");
    assert_eq!(
        source.origin.as_ref().unwrap().url.as_deref(),
        Some("https://app.clickup.com/t/l1-3")
    );
    assert_eq!(source.origin.as_ref().unwrap().connector, CLICKUP);
}

/// «Выбрать задачу с подзадачами»: she and both subtasks.
#[test]
fn a_selected_task_brings_its_subtasks() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 3);
        state.add_task("l1", "mis-a", Some("l1-1"));
        state.add_task("l1", "mis-b", Some("l1-1"));
        state.add_task("l1", "mis-c", Some("l1-1"));
        state.close("mis-c");
    }
    let (host, project) = connected(&fake);
    host.select_in(CLICKUP, &project, vec![task("l1-1")])
        .unwrap();
    assert_eq!(host.ids_of(&project, CLICKUP), ["l1-1", "mis-a", "mis-b"]);
}

/// «Список разросся»: the 200 most recently changed, 30 counted as not
/// loaded.
#[test]
fn a_list_that_grew_keeps_the_200_most_recent() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 150);
    }
    let (host, project) = connected(&fake);
    host.select_in(CLICKUP, &project, vec![container("list:l1")])
        .unwrap();
    for index in 151..=230 {
        fake.state().add_task("l1", &format!("l1-{index}"), None);
    }
    assert_eq!(
        host.sync_in(CLICKUP, &project).unwrap(),
        SyncOutcome::Synced {
            changed: true,
            skipped: 30
        }
    );
    let ids = host.ids_of(&project, CLICKUP);
    assert_eq!(ids.len(), 200);
    assert!(!ids.contains(&"l1-30".to_owned()), "the oldest left out");
    assert!(ids.contains(&"l1-31".to_owned()));
    assert!(ids.contains(&"l1-230".to_owned()));
    let sync = clickup_view(&host, &project).sync.unwrap();
    assert_eq!(sync.skipped, 30);
}

/// «Слишком большое пространство»: refused before saving.
#[test]
fn a_selection_over_the_limit_is_not_saved() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 200);
        state.add_list("s1", None, "l2", 140);
    }
    let (host, project) = connected(&fake);
    let error = block_on(service::selection_set(
        host.as_ref(),
        &project,
        CLICKUP,
        vec![container("space:s1")],
    ))
    .unwrap_err();
    let CommandError::Invalid { message } = &error else {
        panic!("{error:?}");
    };
    assert!(message.contains("200 задач"), "{message}");
    assert!(message.contains("340"), "{message}");
    assert!(clickup_view(&host, &project).items.is_empty());
}

/// «Задача попала в выбор дважды», exclusions of a list in a picked space
/// and of a task with its subtasks.
#[test]
fn a_double_pick_comes_once_and_exclusions_hold() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_folder("s1", "f1", "Телемедиа");
        state.add_list("s1", Some("f1"), "l1", 2);
        state.add_list("s1", None, "l2", 2);
        state.add_task("l1", "l1-1a", Some("l1-1"));
        state.add_task("l1", "l1-1aa", Some("l1-1a"));
    }
    let (host, project) = connected(&fake);
    host.select_in(
        CLICKUP,
        &project,
        vec![container("list:l1"), task("l1-2"), container("folder:f1")],
    )
    .unwrap();
    assert_eq!(
        host.ids_of(&project, CLICKUP),
        ["l1-1", "l1-1a", "l1-1aa", "l1-2"]
    );

    host.select_in(
        CLICKUP,
        &project,
        vec![container("space:s1"), exclude("list:l2"), exclude("l1-1")],
    )
    .unwrap();
    assert_eq!(
        host.ids_of(&project, CLICKUP),
        ["l1-2"],
        "the list's tasks and the task's subtasks at any depth are out"
    );
    let filters: Vec<String> = fake
        .state()
        .log
        .iter()
        .filter(|logged| logged.path.ends_with("/task"))
        .flat_map(|logged| logged.query.iter().map(|(key, _)| key.clone()))
        .filter(|key| key.ends_with("_ids[]"))
        .collect();
    assert!(filters.contains(&"space_ids[]".to_owned()));
    assert!(filters.contains(&"project_ids[]".to_owned()));
}

/// «Задачу закрыли» and «Закрыли отдельно выбранную задачу».
#[test]
fn a_closed_task_leaves_unless_picked_by_itself() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 3);
        state.add_list("s1", None, "l2", 1);
    }
    let (host, project) = connected(&fake);
    host.select_in(CLICKUP, &project, vec![container("list:l1"), task("l2-1")])
        .unwrap();
    assert_eq!(
        host.ids_of(&project, CLICKUP),
        ["l1-1", "l1-2", "l1-3", "l2-1"]
    );
    fake.state().close("l1-2");
    fake.state().close("l2-1");
    host.sync_in(CLICKUP, &project).unwrap();
    assert_eq!(host.ids_of(&project, CLICKUP), ["l1-1", "l1-3", "l2-1"]);
    assert!(
        host.text_of(&project, "l2-1").contains("Статус: complete"),
        "{}",
        host.text_of(&project, "l2-1")
    );

    // Archived: no longer a source even when picked by itself.
    fake.state().archive("l2-1");
    host.sync_in(CLICKUP, &project).unwrap();
    assert_eq!(host.ids_of(&project, CLICKUP), ["l1-1", "l1-3"]);
    let view = clickup_view(&host, &project);
    let status = |id: &str| {
        view.items
            .iter()
            .find(|item| item.external_id == id)
            .unwrap()
            .status
    };
    assert_eq!(status("l2-1"), ItemStatus::Unavailable);
    assert_eq!(status("list:l1"), ItemStatus::Ok);
}

/// «Список удалили»: unavailable, its tasks gone; a list of a workspace the
/// token no longer opens (401) too, while the token stays good.
#[test]
fn a_deleted_list_is_unavailable_and_its_tasks_go() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 2);
        state.add_list("s1", None, "l2", 1);
    }
    let (host, project) = connected(&fake);
    host.select_in(
        CLICKUP,
        &project,
        vec![container("list:l1"), container("list:l2")],
    )
    .unwrap();
    fake.state().delete_list("l1");
    host.sync_in(CLICKUP, &project).unwrap();
    assert_eq!(host.ids_of(&project, CLICKUP), ["l2-1"]);
    let view = clickup_view(&host, &project);
    assert_eq!(view.items[0].external_id, "list:l1");
    assert_eq!(view.items[0].status, ItemStatus::Unavailable);
    assert_eq!(view.items[1].status, ItemStatus::Ok);
    let connection = block_on(service::list(host.as_ref())).unwrap()[2].clone();
    assert_eq!(connection.status, ConnectorStatus::Connected);
}

#[test]
fn a_401_on_an_item_is_unavailable_only_while_the_token_works() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state
            .teams
            .push((OTHER_TEAM.to_owned(), "Личное".to_owned()));
        state.add_space_in(OTHER_TEAM, "s9", "Чужое");
        state.add_list("s9", None, "l9", 1);
        state.foreign_teams.push(OTHER_TEAM.to_owned());
    }
    let connector = connector(&fake);
    let resolved =
        block_on(connector.resolve(&session(), &[task("l9-1"), container("list:l9")])).unwrap();
    assert!(resolved.docs.is_empty());
    assert_eq!(resolved.unavailable, ["list:l9", "l9-1"]);
    fake.state().token = "pk_revoked".to_owned();
    assert_eq!(
        block_on(connector.resolve(&session(), &[task("l9-1")])),
        Err(ConnectorError::Unauthorized)
    );
}

/// «Задача с комментариями»: the name, status, list, description and the
/// comments with their authors, the oldest first.
#[test]
fn a_task_text_has_its_comments() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_folder("s1", "f1", "Телемедиа");
        state.add_list("s1", Some("f1"), "l1", 1);
        state.add_list("s1", None, "l2", 1);
        state.edit("l1-1", "Нужна **интеграция** с МИС.");
        state.comment("l1-1", "Аня", "Уточнить у клиента сроки");
        state.comment("l1-1", "Дима", "Клиент ответил: до марта");
        state.comment("l1-1", "Аня", "Ок, ставлю в план");
        let bare = state.task_mut("l2-1");
        bare.description = String::new();
        bare.assignees.clear();
    }
    let (host, project) = connected(&fake);
    host.select_in(
        CLICKUP,
        &project,
        vec![container("list:l1"), container("list:l2")],
    )
    .unwrap();
    let text = host.text_of(&project, "l1-1");
    assert!(
        text.starts_with(
            "# Задача l1-1\nСтатус: to do · Список: Телемедиа / Список l1 · Исполнители: Аня\n\n\
             Нужна **интеграция** с МИС.\n\n## Комментарии\n**Аня, "
        ),
        "{text}"
    );
    let first = text.find("Уточнить у клиента сроки").unwrap();
    let second = text.find("**Дима, ").unwrap();
    let third = text.find("Ок, ставлю в план").unwrap();
    assert!(first < second && second < third, "{text}");
    assert_eq!(
        host.text_of(&project, "l2-1"),
        "# Задача l2-1\nСтатус: to do · Список: Список l2",
        "a task with no description nor comments: its name and status"
    );
}

/* The sync and the brief (task 2.5) */

/// «Задачу изменили» and «Ничего не изменилось».
#[test]
fn a_changed_task_outdates_the_brief_and_nothing_changed_keeps_it() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 3);
    }
    let (host, project) = connected(&fake);
    host.select_in(CLICKUP, &project, vec![container("list:l1")])
        .unwrap();
    host.build_brief(&project);
    let fingerprint = host.fingerprint(&project);
    let comments_before = fake.state().requests("/task/");

    assert_eq!(
        host.sync_in(CLICKUP, &project).unwrap(),
        SyncOutcome::Synced {
            changed: false,
            skipped: 0
        }
    );
    assert_eq!(host.fingerprint(&project), fingerprint);
    assert_eq!(host.brief_state(&project), BriefState::Fresh);
    assert_eq!(
        fake.state().requests("/task/"),
        comments_before,
        "nothing changed: no comments read"
    );

    fake.state().edit("l1-2", "Перезвон за 3 минуты");
    assert_eq!(
        host.sync_in(CLICKUP, &project).unwrap(),
        SyncOutcome::Synced {
            changed: true,
            skipped: 0
        }
    );
    assert!(
        host.text_of(&project, "l1-2")
            .contains("Перезвон за 3 минуты")
    );
    assert_eq!(host.brief_state(&project), BriefState::Outdated);
    assert_eq!(
        fake.state().requests("/task/"),
        comments_before + 1,
        "only the changed task's comments"
    );
}

/// «Токен отозвали»: the sync stops, the tasks keep their last text, the
/// connector is in error.
#[test]
fn a_revoked_token_stops_the_sync_and_keeps_the_tasks() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 2);
    }
    let (host, project) = connected(&fake);
    host.select_in(CLICKUP, &project, vec![container("list:l1")])
        .unwrap();
    {
        let mut state = fake.state();
        state.edit("l1-1", "Новое описание");
        state.token = "pk_after_revoke".to_owned();
    }
    let outcome = host.sync_in(CLICKUP, &project).unwrap();
    assert_eq!(
        outcome,
        SyncOutcome::Failed {
            kind: crate::connectors::ErrorKind::Unauthorized,
            message: "Токен больше не подходит".to_owned()
        }
    );
    assert_eq!(host.ids_of(&project, CLICKUP), ["l1-1", "l1-2"]);
    assert!(
        host.text_of(&project, "l1-1")
            .contains("Описание задачи l1-1.")
    );
    let view = clickup_view(&host, &project);
    let sync = view.sync.unwrap();
    assert_eq!(
        sync.error_kind,
        Some(crate::connectors::ErrorKind::Unauthorized)
    );
    assert!(sync.last_ok_at.is_some());
    let connection = block_on(service::list(host.as_ref())).unwrap()[2].clone();
    assert_eq!(connection.status, ConnectorStatus::Error);
}

/// «Переподключили к другому пространству»: the old workspace's tasks stay
/// with their last text, marked another workspace's, and don't update.
#[test]
fn reconnecting_to_another_workspace_keeps_the_old_tasks() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state
            .teams
            .push((OTHER_TEAM.to_owned(), "Личное".to_owned()));
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 2);
        state.add_space_in(OTHER_TEAM, "s9", "Личное");
        state.add_list("s9", None, "l9", 1);
    }
    let host = Host::clickup(&fake);
    host.connect_clickup(TOKEN, Some(TEAM));
    let project = host.project("Телемедиа");
    host.select_in(CLICKUP, &project, vec![container("list:l1")])
        .unwrap();

    let ConnectOutcome::Connected(_) = host.connect_clickup(TOKEN, Some(OTHER_TEAM)) else {
        panic!("reconnects");
    };
    fake.state().edit("l1-1", "Изменено после переподключения");
    host.select_in(
        CLICKUP,
        &project,
        vec![container("list:l1"), container("list:l9")],
    )
    .unwrap();
    let view = clickup_view(&host, &project);
    let marks: Vec<(&str, bool, ItemStatus)> = view
        .items
        .iter()
        .map(|item| (item.external_id.as_str(), item.other_account, item.status))
        .collect();
    assert_eq!(
        marks,
        [
            ("list:l1", true, ItemStatus::Unavailable),
            ("list:l9", false, ItemStatus::Ok)
        ]
    );
    assert_eq!(host.ids_of(&project, CLICKUP), ["l1-1", "l1-2", "l9-1"]);
    assert!(
        host.text_of(&project, "l1-1")
            .contains("Описание задачи l1-1.")
    );
}

/// «Лимит перед звонком», on Tokio's paused clock, moved only by hand (a
/// blocking task keeps it from jumping while the fake answers over the
/// network): the limit is spent, the call starts after 30 s with the last
/// text, the sync ends later in the background with the new one.
#[tokio::test(start_paused = true)]
async fn the_limit_before_a_call_lets_the_sync_finish_in_the_background() {
    let (release, hold) = std::sync::mpsc::channel::<()>();
    let holder = tokio::task::spawn_blocking(move || {
        let _ = hold.recv();
    });
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 2);
    }
    let clickup = Arc::new(connector(&fake));
    let host = Host::clickup_with(Arc::clone(&clickup));
    *host.agent.lock().unwrap() = Some(Arc::new(Waiting));
    let outcome = service::connect_api_key(&host, CLICKUP, "", TOKEN, None)
        .await
        .unwrap();
    assert!(
        matches!(outcome, ConnectOutcome::Connected(_)),
        "{outcome:?}"
    );
    let project = host
        .storage
        .write(&host.sink, |db| {
            crate::storage::projects::create(
                db,
                crate::storage::projects::ProjectCreate {
                    name: "Телемедиа".to_owned(),
                    ..crate::storage::projects::ProjectCreate::default()
                },
            )
        })
        .await
        .unwrap()
        .id;
    service::selection_set(host.as_ref(), &project, CLICKUP, vec![container("list:l1")])
        .await
        .unwrap();
    sync::sync_fresh(&host, &project, CLICKUP).await.unwrap();
    // One answer says the limit is spent for 45 s more.
    fake.state().rate = Rate::Exhausted(45);
    service::browse(host.as_ref(), CLICKUP, None).await.unwrap();
    {
        let mut state = fake.state();
        state.rate = Rate::Plenty;
        state.edit("l1-1", "Новое перед звонком");
    }
    let requests = fake.state().log.len();

    let builds = BriefBuilds::default();
    let call = {
        let (host, builds, project) = (Arc::clone(&host), builds.clone(), project.clone());
        tokio::spawn(async move { prepare(&host, &builds, &project).await })
    };
    while clickup.gate().sleeping.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    assert_eq!(fake.state().log.len(), requests, "waiting, not asking");
    tokio::time::advance(SYNC_BEFORE_CALL).await;
    let started = call.await.unwrap().unwrap();
    assert!(started, "the brief (none yet) builds from the last text");
    assert!(host.connectors.flights.is_running(&project, CLICKUP));
    assert!(clickup_view_async(&host, &project).await.syncing);
    let text = text_async(&host, &project, "l1-1").await;
    assert!(text.contains("Описание задачи l1-1."), "{text}");

    tokio::time::advance(Duration::from_secs(20)).await;
    // Joins the running sync: it ends once the limit resets.
    let outcome = sync::sync_project(&host, &project, CLICKUP).await.unwrap();
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            changed: true,
            skipped: 0
        }
    );
    assert!(!host.connectors.flights.is_running(&project, CLICKUP));
    let text = text_async(&host, &project, "l1-1").await;
    assert!(text.contains("Новое перед звонком"), "{text}");
    builds.cancel(&project);
    let _ = release.send(());
    holder.await.unwrap();
}

async fn text_async(host: &Host, project: &str, external_id: &str) -> String {
    let (id, external) = (project.to_owned(), external_id.to_owned());
    host.storage
        .read(move |db| {
            Ok(db.query_row(
                "SELECT text FROM project_sources WHERE project_id = ?1 AND external_id = ?2",
                [&id, &external],
                |row| row.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap()
}

async fn clickup_view_async(host: &Host, project: &str) -> service::ProjectConnectorView {
    service::selection_get(host, project)
        .await
        .unwrap()
        .into_iter()
        .find(|view| view.kind == CLICKUP)
        .unwrap()
}

/// An agent that runs until it is cancelled.
struct Waiting;

impl crate::agent::claude_cli::Agent for Waiting {
    fn run(
        &self,
        _request: crate::agent::claude_cli::AgentRequest,
        cancel: tokio::sync::oneshot::Receiver<()>,
    ) -> crate::agent::claude_cli::AgentFuture<'_> {
        Box::pin(async move {
            let _ = cancel.await;
            Err(crate::agent::claude_cli::AgentError::Cancelled)
        })
    }
}

/* Replies never carry the token */

#[test]
fn no_reply_has_the_token() {
    let fake = FakeClickUp::start();
    {
        let mut state = fake.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 2);
        state.comment("l1-1", "Аня", "Комментарий");
    }
    let host = Host::clickup(&fake);
    let project = host.project("Телемедиа");
    let mut replies: Vec<Value> =
        vec![serde_json::to_value(host.connect_clickup(TOKEN, None)).unwrap()];
    replies.push(serde_json::to_value(block_on(service::list(host.as_ref())).unwrap()).unwrap());
    replies.push(
        serde_json::to_value(block_on(service::browse(host.as_ref(), CLICKUP, None)).unwrap())
            .unwrap(),
    );
    replies.push(
        serde_json::to_value(
            block_on(service::selection_set(
                host.as_ref(),
                &project,
                CLICKUP,
                vec![container("list:l1")],
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    host.sync_in(CLICKUP, &project).unwrap();
    replies.push(
        serde_json::to_value(block_on(service::selection_get(host.as_ref(), &project)).unwrap())
            .unwrap(),
    );
    replies.push(serde_json::to_value(host.sources(&project)).unwrap());
    fake.state().token = "pk_revoked".to_owned();
    replies.push(serde_json::to_value(host.sync_in(CLICKUP, &project).is_ok()).unwrap());
    let error = block_on(service::browse(host.as_ref(), CLICKUP, None)).unwrap_err();
    replies.push(serde_json::to_value(&error).unwrap());
    replies.push(serde_json::to_value(block_on(service::list(host.as_ref())).unwrap()).unwrap());
    replies.push(serde_json::to_value(host.events()).unwrap());
    let texts = block_on(host.storage.read({
        let id = project.clone();
        move |db| sources::ready_texts(db, &id)
    }))
    .unwrap();
    assert!(!texts.is_empty());
    for text in texts {
        assert!(!text.text.contains(TOKEN));
    }
    for reply in replies {
        assert!(!reply.to_string().contains(TOKEN), "{reply}");
        assert!(!reply.to_string().contains("pk_8"), "{reply}");
    }
}

#[test]
fn verified_outcome_for_a_given_workspace() {
    let fake = FakeClickUp::start();
    fake.state()
        .teams
        .push((OTHER_TEAM.to_owned(), "Личное".to_owned()));
    let connector = connector(&fake);
    let without_team = Session {
        team: None,
        ..session()
    };
    assert!(matches!(
        block_on(connector.verify_in(&without_team, None)),
        Ok(Verified::Choose(ref all)) if all.len() == 2
    ));
    assert!(matches!(
        block_on(connector.verify_in(&without_team, Some(OTHER_TEAM))),
        Ok(Verified::Account(ref account)) if account.team_id == OTHER_TEAM
    ));
    // The connection's workspace gone from the token: no access.
    let gone = Session {
        team: Some("1".to_owned()),
        ..session()
    };
    assert_eq!(
        block_on(connector.verify(&gone)),
        Err(ConnectorError::Forbidden)
    );
}

/// Without rate headers from ClickUp the client keeps 600 ms between
/// requests (real time, against the fake).
#[test]
fn without_rate_headers_the_client_spaces_its_requests() {
    let fake = FakeClickUp::start();
    fake.state().rate = Rate::None;
    let client = client(&fake);
    let started = StdInstant::now();
    for _ in 0..3 {
        block_on(client.teams()).unwrap();
    }
    assert!(started.elapsed() >= SPACING * 2, "{:?}", started.elapsed());
}
