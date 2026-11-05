//! Builds against an agent in process (decisions 4–6): the checks of the
//! replies and what is saved. The CLI itself runs in `fake_cli_tests.rs`.

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot};

use super::{
    CANCELLED, EFFORT, MODEL, SummaryProgress, SummaryStage, SummaryStageState, TIMEOUT,
    builds::SummaryBuilds,
    run::{self, CloseFuture, SummaryHost},
    summary_schema_argument,
    tests::CallData,
};
use crate::{
    agent::claude_cli::{Agent, AgentError, AgentFuture, AgentReply, AgentRequest, Usage},
    call::CallManager,
    events::{DataChanged, EventSink, testing::RecordingSink},
    projects::brief::run::AgentLookup,
    speech::events::TranscriptRefine,
    storage::{
        Storage, call_state,
        call_state::{QuestionAction, QuestionStatus},
        calls::{self, CallStatus},
        proposals::{self, ProposalDecision, ProposalKind, ProposalTarget},
        summaries::{
            self, FactSource, FactStatus, PointStatus, SummaryState, SummaryTranscriptPass,
        },
        transcript::TranscriptChannel::{Me, Others},
    },
};

pub fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/* A host without the app */

/// Storage in a temp folder, what the windows got, an agent that is ready
/// (`Some`) or not, and the call's manager once wired.
pub struct TestHost {
    pub data: tempfile::TempDir,
    storage: Storage,
    pub sink: RecordingSink,
    pub progress: Mutex<Vec<SummaryProgress>>,
    pub agent: Mutex<Option<Arc<dyn Agent>>>,
    pub news: broadcast::Sender<TranscriptRefine>,
    pub closed: Mutex<Vec<String>>,
    pub state_changed: Mutex<Vec<String>>,
    pub silence: Mutex<Duration>,
    /// `close_call` goes to it when set.
    pub calls: OnceLock<CallManager>,
}

impl TestHost {
    pub fn new(agent: Option<Arc<dyn Agent>>) -> Arc<Self> {
        let data = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(data.path());
        assert!(storage.error().is_none(), "{:?}", storage.error());
        Arc::new(Self {
            data,
            storage,
            sink: RecordingSink::default(),
            progress: Mutex::new(Vec::new()),
            agent: Mutex::new(agent),
            news: broadcast::channel(16).0,
            closed: Mutex::new(Vec::new()),
            state_changed: Mutex::new(Vec::new()),
            silence: Mutex::new(Duration::from_secs(5)),
            calls: OnceLock::new(),
        })
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub fn data<T>(&self, work: impl FnOnce(&CallData) -> T) -> T {
        self.storage
            .read_now(|connection| Ok(work(&CallData { connection })))
            .unwrap()
    }

    pub fn progress(&self) -> Vec<SummaryProgress> {
        self.progress.lock().unwrap().clone()
    }

    pub fn stages(&self) -> Vec<(SummaryStage, SummaryStageState)> {
        self.progress()
            .into_iter()
            .map(|progress| (progress.stage, progress.state))
            .collect()
    }

    pub fn last(&self) -> SummaryProgress {
        self.progress().pop().expect("no progress")
    }

    pub fn summary(&self, call_id: &str) -> summaries::CallSummary {
        self.storage
            .read_now(|connection| summaries::get(connection, call_id))
            .unwrap()
            .expect("no summary")
    }

    pub fn closed(&self) -> Vec<String> {
        self.closed.lock().unwrap().clone()
    }
}

impl EventSink for TestHost {
    fn data_changed(&self, event: DataChanged) {
        self.sink.data_changed(event);
    }
}

impl SummaryHost for TestHost {
    fn storage(&self) -> Option<&Storage> {
        Some(&self.storage)
    }

    fn progress(&self, progress: SummaryProgress) {
        self.progress.lock().unwrap().push(progress);
    }

    fn agent(&self) -> AgentLookup<'_> {
        let agent = self.agent.lock().unwrap().clone();
        Box::pin(async move { agent.ok_or_else(|| "Нужен вход в Claude Code".to_owned()) })
    }

    fn prompt_dir(&self) -> PathBuf {
        self.data.path().join("agent/summaries")
    }

    fn refine_news(&self) -> broadcast::Receiver<TranscriptRefine> {
        self.news.subscribe()
    }

    fn close_call(&self, call_id: &str) -> CloseFuture<'_> {
        self.closed.lock().unwrap().push(call_id.to_owned());
        let calls = self.calls.get().cloned();
        let call_id = call_id.to_owned();
        Box::pin(async move {
            if let Some(calls) = calls {
                let _ = calls.close(&call_id).await;
            }
        })
    }

    fn call_state_changed(&self, recording_id: &str) {
        self.state_changed
            .lock()
            .unwrap()
            .push(recording_id.to_owned());
    }

    fn silence(&self) -> Duration {
        *self.silence.lock().unwrap()
    }
}

/* An agent in process */

type Hook = Box<dyn FnOnce() + Send>;

/// Answers call A with `summary` and call B with `proposals`, recording
/// what it was asked; `before` runs once, just before an answer.
pub struct ScriptedAgent {
    summary: Mutex<Result<Value, AgentError>>,
    proposals: Mutex<Result<Value, AgentError>>,
    pub requests: Mutex<Vec<AgentRequest>>,
    pub before: Mutex<Option<Hook>>,
    calls: AtomicUsize,
}

impl ScriptedAgent {
    pub fn new(
        summary: Result<Value, AgentError>,
        proposals: Result<Value, AgentError>,
    ) -> Arc<Self> {
        Arc::new(Self {
            summary: Mutex::new(summary),
            proposals: Mutex::new(proposals),
            requests: Mutex::new(Vec::new()),
            before: Mutex::new(None),
            calls: AtomicUsize::new(0),
        })
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub fn set(&self, summary: Result<Value, AgentError>, proposals: Result<Value, AgentError>) {
        *self.summary.lock().unwrap() = summary;
        *self.proposals.lock().unwrap() = proposals;
    }
}

impl Agent for ScriptedAgent {
    fn run(&self, request: AgentRequest, _cancel: oneshot::Receiver<()>) -> AgentFuture<'_> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reply = if request.schema == summary_schema_argument() {
            self.summary.lock().unwrap().clone()
        } else {
            self.proposals.lock().unwrap().clone()
        };
        self.requests.lock().unwrap().push(request);
        let before = self.before.lock().unwrap().take();
        Box::pin(async move {
            if let Some(before) = before {
                before();
            }
            reply.map(|patch| AgentReply {
                patch,
                usage: Usage::default(),
            })
        })
    }
}

/* The call of the scenarios */

/// «Обменник» with Игорь (tech 3) on the call, a refined recording, a
/// topic with an asked question and a hidden one.
pub struct Exchange {
    pub igor: String,
    pub call: String,
    pub recording: String,
    pub asked: String,
    pub hidden: String,
}

pub fn exchange(host: &TestHost, status: CallStatus) -> Exchange {
    host.data(|data| {
        let project = data.project("Обменник");
        let igor = data.person(&project, "Игорь", "CTO");
        data.brief(
            &project,
            "",
            &json!({
                "product": "Приложение обменника для туристов",
                "stack": ["Monobank API"],
                "modules": [],
                "glossary": [{ "term": "Курс дня", "definition": "Курс на утро" }],
                "keyDocuments": []
            }),
        );
        data.profile(&igor, json!({ "tech": 3 }));
        let call = data.call(Some(&project), &[&igor], CallStatus::Live);
        let recording = data.recording(&call, 0, &[(Others, 1_000, "живая")]);
        data.refine(
            &recording,
            &[
                (
                    Others,
                    5_000,
                    "Курс у нас обновляется раз в минуту, это важно",
                ),
                (
                    Others,
                    20_000,
                    "USD МІКС это у нас корзина из доллара и гривны",
                ),
                (Me, 30_000, "А когда это будет готово, как поймём?"),
                (
                    Others,
                    41_000,
                    "Готово, когда курс совпадает с банком до копейки",
                ),
                (Others, 50_000, "Обновлять курс надо раз в час, не чаще"),
            ],
        );
        let (_, questions) =
            data.topic(&recording, "Курс валют", &["Когда готово?", "Кто платит?"]);
        call_state::act(data.connection, &questions[0], QuestionAction::Asked).unwrap();
        call_state::act(data.connection, &questions[1], QuestionAction::Hide).unwrap();
        let patch = calls::CallUpdate {
            status: Some(status),
            ..calls::CallUpdate::default()
        };
        calls::update(data.connection, &call, patch).unwrap();
        Exchange {
            igor,
            call,
            recording,
            asked: questions[0].clone(),
            hidden: questions[1].clone(),
        }
    })
}

/// Call A's reply about the exchange call: one true point, one with a
/// made-up quote; facts with a quote, without one, with the project; the
/// asked question answered, the hidden one too (not allowed).
pub fn summary_reply() -> Value {
    json!({
        "title": "Курс и корзина для туристов",
        "tldr": "Обсудили, как часто обновлять курс. Клиент сказал, когда работа готова.",
        "topics": [{
            "refs": ["T1", "T9"],
            "title": "Курс валют",
            "from": "S1",
            "to": "S5",
            "points": [
                {
                    "text": "Курс обновляется раз в минуту",
                    "status": "fact",
                    "evidence": [{ "id": "S1", "quote": "курс у нас обновляется раз в минуту" }]
                },
                {
                    "text": "Клиент принимает биткоин",
                    "status": "fact",
                    "evidence": [{ "id": "S2", "quote": "мы принимаем биткоин в кассе" }]
                },
                {
                    "text": "Частота обновления не ясна",
                    "status": "contradiction",
                    "evidence": [
                        { "id": "S1", "quote": "курс у нас обновляется раз в минуту" },
                        { "id": "S5", "quote": "обновлять курс надо раз в час" }
                    ]
                },
                {
                    "text": "Менеджер спросил о готовности",
                    "status": "fact",
                    "evidence": [{ "id": "S3", "quote": "а когда это будет готово" }]
                }
            ],
            "card": {
                "title": "",
                "fields": [
                    {
                        "field": "acceptance",
                        "facts": [{
                            "text": "Курс совпадает с банком",
                            "status": "confirmed",
                            "evidence": [{ "id": "S4", "quote": "курс совпадает с банком до копейки" }]
                        }]
                    },
                    {
                        "field": "users",
                        "facts": [
                            { "text": "Туристы", "status": "confirmed", "evidence": [{ "id": "P1", "quote": "обменник валют для туристов" }] },
                            { "text": "Кассиры", "status": "confirmed", "evidence": [{ "id": "S2", "quote": "кассиры смотрят курс" }] }
                        ]
                    },
                    {
                        "field": "goal",
                        "facts": [{
                            "text": "Одна цифра курса",
                            "status": "contradiction",
                            "evidence": [{ "id": "S1", "quote": "курс у нас обновляется раз в минуту" }]
                        }]
                    },
                    { "field": "edgeCases", "facts": [{ "text": "Не обсуждали", "status": "empty", "evidence": [] }] }
                ]
            }
        }],
        "answered": [
            { "ref": "Q1", "evidence": [{ "id": "S4", "quote": "готово когда курс совпадает с банком" }] },
            { "ref": "Q2", "evidence": [{ "id": "S4", "quote": "готово когда курс совпадает с банком" }] },
            { "ref": "Q7", "evidence": [{ "id": "S4", "quote": "готово когда курс совпадает с банком" }] }
        ],
        "next": [
            { "text": "Что делать, если банк не ответил?", "topic": 1, "field": "edgeCases", "gap": "empty" },
            { "text": "Раз в минуту или раз в час?", "topic": 3, "field": "goal", "gap": "contradiction" }
        ]
    })
}

/// Call B's reply: a new term with the client's quote, the product as it
/// is, the levels.
pub fn proposals_reply() -> Value {
    json!({
        "proposals": [
            {
                "target": "brief", "field": "glossary",
                "after": "USD МІКС — корзина из доллара и гривны", "kind": "said",
                "evidence": [{ "id": "S2", "quote": "USD МІКС это у нас корзина" }]
            },
            {
                "target": "brief", "field": "product",
                "after": "Приложение обменника для туристов", "kind": "said",
                "evidence": [{ "id": "P1", "quote": "обменник валют для туристов" }]
            },
            { "target": "H1", "field": "tech", "after": " 4 ", "kind": "inferred", "evidence": [] },
            { "target": "H1", "field": "project", "after": "7", "kind": "inferred", "evidence": [] },
            { "target": "H9", "field": "role", "after": "CEO", "kind": "inferred", "evidence": [] },
            {
                "target": "H1", "field": "howToAsk",
                "after": "Коротко и с цифрами", "kind": "said",
                "evidence": [{ "id": "S2", "quote": "мы любим цифры и коротко" }]
            }
        ]
    })
}

fn build(host: &Arc<TestHost>, builds: &SummaryBuilds, call_id: &str) {
    let running = run::start(host, builds, call_id).expect("a build starts");
    block_on(running).unwrap();
}

use SummaryStage::{Proposals, Saving, Summary, Transcript};
use SummaryStageState::{Done, Running};

/// «Итоги готовы», «Выдуманная цитата», «Ответ найден после звонка»,
/// «Новый термин»: what the checks keep, in one transaction.
#[test]
fn a_build_saves_what_passes_the_checks() {
    let agent = ScriptedAgent::new(Ok(summary_reply()), Ok(proposals_reply()));
    let host = TestHost::new(Some(agent.clone()));
    let builds = SummaryBuilds::default();
    let call = exchange(&host, CallStatus::Finishing);

    build(&host, &builds, &call.call);

    assert_eq!(
        host.stages(),
        vec![
            (Transcript, Running),
            (Transcript, Done),
            (Summary, Running),
            (Summary, Done),
            (Proposals, Running),
            (Proposals, Done),
            (Saving, Running),
            (Saving, Done),
        ]
    );
    let counts = host.last().counts.unwrap();
    assert_eq!(
        (
            counts.segments,
            counts.topics,
            counts.transcript_pass,
            counts.proposals
        ),
        (5, 1, SummaryTranscriptPass::Refined, Some(3))
    );
    assert_eq!(host.closed(), vec![call.call.clone()]);
    assert!(!builds.is_building(&call.call));

    // Both calls: the model, the effort, the time limit, the rules.
    let requests = agent.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert_eq!(
            (
                request.options.model,
                request.options.effort,
                request.options.timeout
            ),
            (Some(MODEL), Some(EFFORT), Some(TIMEOUT))
        );
        assert!(
            request
                .user_message
                .contains("[S2] 00:00:20 Клиент: USD МІКС")
        );
    }
    assert!(requests[0].user_message.ends_with(super::SUMMARY_CLOSING));
    assert!(requests[1].user_message.ends_with(super::PROPOSALS_CLOSING));

    let summary = host.summary(&call.call);
    assert_eq!(summary.state, SummaryState::Ready);
    assert_eq!(summary.title, "Курс и корзина для туристов");
    assert_eq!(
        summary.transcript_pass,
        Some(SummaryTranscriptPass::Refined)
    );
    let content = summary.content.unwrap();
    let topic = &content.topics[0];
    assert_eq!(topic.title, "Курс валют");
    assert_eq!(topic.topic_ids.len(), 1, "T9 was not in the input");
    assert_eq!((topic.from.start_ms, topic.to.start_ms), (5_000, 50_000));
    // «Выдуманная цитата»: the made-up point is gone, the others stay; a
    // contradiction rests on two phrases; the manager's words are no basis.
    let points: Vec<(&str, PointStatus)> = topic
        .points
        .iter()
        .map(|point| (point.text.as_str(), point.status))
        .collect();
    assert_eq!(
        points,
        vec![
            ("Курс обновляется раз в минуту", PointStatus::Fact),
            ("Частота обновления не ясна", PointStatus::Contradiction),
        ]
    );
    let evidence = &topic.points[0].evidence[0];
    assert_eq!(
        (evidence.recording_id.as_str(), evidence.start_ms),
        (call.recording.as_str(), 5_000)
    );
    // The card: a quote of the client, the project, «вывод агента».
    let card = &content.cards[0];
    assert_eq!(card.title, "Курс валют");
    assert_eq!(card.topic_id, topic.id);
    let facts: Vec<(&str, FactStatus, FactSource, usize)> = card
        .fields
        .iter()
        .flat_map(|field| &field.facts)
        .map(|fact| {
            (
                fact.text.as_str(),
                fact.status,
                fact.source,
                fact.evidence.len(),
            )
        })
        .collect();
    assert_eq!(
        facts,
        vec![
            (
                "Одна цифра курса",
                FactStatus::Assumption,
                FactSource::Client,
                1
            ),
            ("Туристы", FactStatus::Confirmed, FactSource::Project, 0),
            ("Кассиры", FactStatus::Assumption, FactSource::Agent, 0),
            ("Не обсуждали", FactStatus::Empty, FactSource::Agent, 0),
            (
                "Курс совпадает с банком",
                FactStatus::Confirmed,
                FactSource::Client,
                1
            ),
        ]
    );
    // Up to five questions for next time, the topic only when it exists.
    assert_eq!(content.next.len(), 2);
    assert_eq!(content.next[0].topic_id.as_deref(), Some(topic.id.as_str()));
    assert_eq!(content.next[1].topic_id, None);

    // «Ответ найден после звонка»: the asked question is answered with the
    // client's words; the hidden one stays hidden.
    let state = host
        .storage()
        .read_now(|db| call_state::get(db, &call.recording))
        .unwrap();
    let asked = state.questions.iter().find(|q| q.id == call.asked).unwrap();
    assert_eq!(asked.status, QuestionStatus::Answered);
    assert!(!asked.visible);
    assert_eq!(
        asked.answer_evidence.as_ref().unwrap()[0].quote,
        "готово когда курс совпадает с банком"
    );
    let hidden = state
        .questions
        .iter()
        .find(|q| q.id == call.hidden)
        .unwrap();
    assert_eq!(hidden.status, QuestionStatus::Hidden);
    assert_eq!(
        *host.state_changed.lock().unwrap(),
        vec![call.recording.clone()]
    );

    // «Новый термин» with the client's quote; the product as it is, a level
    // out of 1–5 and a stranger are dropped; `before` is the data's.
    let proposals = host
        .storage()
        .read_now(|db| proposals::list(db, &call.call))
        .unwrap();
    let made: Vec<(ProposalTarget, &str, Option<&str>, &str, ProposalKind)> = proposals
        .iter()
        .map(|p| {
            (
                p.target,
                p.field.as_str(),
                p.before.as_deref(),
                p.after.as_str(),
                p.kind,
            )
        })
        .collect();
    assert_eq!(
        made,
        vec![
            (
                ProposalTarget::Brief,
                "glossary",
                None,
                "USD МІКС — корзина из доллара и гривны",
                ProposalKind::Said
            ),
            (
                ProposalTarget::Person,
                "tech",
                Some("3"),
                "4",
                ProposalKind::Inferred
            ),
            (
                ProposalTarget::Person,
                "howToAsk",
                None,
                "Коротко и с цифрами",
                ProposalKind::Inferred
            ),
        ]
    );
    assert_eq!(proposals[0].evidence[0].start_ms, 20_000);
    assert_eq!(proposals[1].person_id.as_deref(), Some(call.igor.as_str()));
    assert!(
        proposals
            .iter()
            .all(|p| p.decision == ProposalDecision::Pending)
    );

    // The call is named after its summary.
    let named = host
        .storage()
        .read_now(|db| calls::get(db, &call.call))
        .unwrap();
    assert_eq!(named.title, "Курс и корзина для туристов");
    // The prompt files go with the build.
    let prompts = std::fs::read_dir(host.data.path().join("agent/summaries")).unwrap();
    assert_eq!(prompts.count(), 0);
}

/// «Звонок без проекта»: one agent call, no proposals stage, none saved.
#[test]
fn a_call_without_a_project_gets_no_proposals() {
    let agent = ScriptedAgent::new(Ok(summary_reply()), Ok(proposals_reply()));
    let host = TestHost::new(Some(agent.clone()));
    let builds = SummaryBuilds::default();
    let call = host.data(|data| {
        let call = data.call(None, &[], CallStatus::Finishing);
        let recording = data.recording(
            &call,
            0,
            &[(
                Others,
                5_000,
                "Курс у нас обновляется раз в минуту, это важно",
            )],
        );
        data.delete_audio(&recording);
        call
    });

    build(&host, &builds, &call);

    assert_eq!(agent.calls(), 1);
    assert!(host.stages().iter().all(|(stage, _)| *stage != Proposals));
    assert_eq!(host.last().state, Done);
    let summary = host.summary(&call);
    assert_eq!(summary.state, SummaryState::Ready);
    // Deleted audio: no second pass, the live transcript.
    assert_eq!(summary.transcript_pass, Some(SummaryTranscriptPass::Live));
    assert!(
        host.storage()
            .read_now(|db| proposals::list(db, &call))
            .unwrap()
            .is_empty()
    );
    assert!(
        !agent.requests.lock().unwrap()[0]
            .user_message
            .contains("H1")
    );
}

/// A reply not by the schema: the stage fails, the previous summary and
/// proposals stay, the call still closes.
#[test]
fn a_reply_off_the_schema_keeps_the_previous_summary() {
    let agent = ScriptedAgent::new(Ok(summary_reply()), Ok(proposals_reply()));
    let host = TestHost::new(Some(agent.clone()));
    let builds = SummaryBuilds::default();
    let call = exchange(&host, CallStatus::Finished);
    build(&host, &builds, &call.call);
    let before = host.summary(&call.call);
    let proposals_before = host
        .storage()
        .read_now(|db| proposals::list(db, &call.call))
        .unwrap();

    agent.set(Ok(json!({ "summary": "не итоги" })), Ok(proposals_reply()));
    host.progress.lock().unwrap().clear();
    build(&host, &builds, &call.call);

    let last = host.last();
    assert_eq!(last.stage, Summary);
    let SummaryStageState::Failed { message } = last.state else {
        panic!("{last:?}");
    };
    assert!(message.contains("не по схеме"), "{message}");
    let after = host.summary(&call.call);
    assert_eq!(after.state, SummaryState::Failed);
    assert_eq!(after.error.as_deref(), Some(message.as_str()));
    assert_eq!(
        (&after.title, &after.content, after.built_at),
        (&before.title, &before.content, before.built_at)
    );
    assert_eq!(
        host.storage()
            .read_now(|db| proposals::list(db, &call.call))
            .unwrap(),
        proposals_before
    );
    assert_eq!(
        host.closed().len(),
        2,
        "the call closes after a failure too"
    );
}

/// «Отвеченный вопрос не возвращается»: a rebuild that does not mention
/// an answered question leaves it answered, and a hidden one hidden.
#[test]
fn an_answered_question_does_not_come_back() {
    let agent = ScriptedAgent::new(Ok(summary_reply()), Ok(proposals_reply()));
    let host = TestHost::new(Some(agent.clone()));
    let builds = SummaryBuilds::default();
    let call = exchange(&host, CallStatus::Finished);
    build(&host, &builds, &call.call);

    let mut silent = summary_reply();
    silent["answered"] = json!([]);
    agent.set(Ok(silent), Ok(json!({ "proposals": [] })));
    build(&host, &builds, &call.call);

    assert_eq!(host.summary(&call.call).state, SummaryState::Ready);
    let state = host
        .storage()
        .read_now(|db| call_state::get(db, &call.recording))
        .unwrap();
    let status = |id: &str| state.questions.iter().find(|q| q.id == id).unwrap().status;
    assert_eq!(status(&call.asked), QuestionStatus::Answered);
    assert_eq!(status(&call.hidden), QuestionStatus::Hidden);
    // A rebuild replaced the pending proposals with none.
    assert!(
        host.storage()
            .read_now(|db| proposals::list(db, &call.call))
            .unwrap()
            .is_empty()
    );
}

/// Call B failing does not cost the call its summary, nor the proposals of
/// the previous build.
#[test]
fn failed_proposals_keep_the_summary_and_the_pending_proposals() {
    let agent = ScriptedAgent::new(Ok(summary_reply()), Ok(proposals_reply()));
    let host = TestHost::new(Some(agent.clone()));
    let builds = SummaryBuilds::default();
    let call = exchange(&host, CallStatus::Finished);
    build(&host, &builds, &call.call);
    let pending = host
        .storage()
        .read_now(|db| proposals::list(db, &call.call))
        .unwrap();
    assert_eq!(pending.len(), 3);

    agent.set(Ok(summary_reply()), Err(AgentError::Timeout));
    host.progress.lock().unwrap().clear();
    build(&host, &builds, &call.call);

    assert!(host.stages().contains(&(
        Proposals,
        SummaryStageState::Failed {
            message: "Агент не ответил вовремя".to_owned()
        }
    )));
    assert!(!host.stages().contains(&(Proposals, Done)));
    assert_eq!(host.last().stage, Saving);
    assert_eq!(host.last().state, Done);
    assert_eq!(host.summary(&call.call).state, SummaryState::Ready);
    assert_eq!(
        host.storage()
            .read_now(|db| proposals::list(db, &call.call))
            .unwrap(),
        pending
    );
}

/// A call with nothing said is not worth an agent call.
#[test]
fn a_call_without_a_transcript_fails_before_the_agent() {
    let agent = ScriptedAgent::new(Ok(summary_reply()), Ok(proposals_reply()));
    let host = TestHost::new(Some(agent.clone()));
    let builds = SummaryBuilds::default();
    let call = host.data(|data| {
        let call = data.call(None, &[], CallStatus::Finishing);
        let recording = data.recording(&call, 0, &[]);
        data.delete_audio(&recording);
        call
    });
    build(&host, &builds, &call);
    assert_eq!(agent.calls(), 0);
    let last = host.last();
    assert_eq!(last.stage, Transcript);
    assert!(matches!(last.state, SummaryStageState::Failed { .. }));
    assert_eq!(host.summary(&call).state, SummaryState::Failed);
    assert_eq!(host.closed(), vec![call]);
}

/// A stop that comes after the replies, while the build waits for the
/// database to save: nothing is saved, the summary reads cancelled.
#[test]
fn a_stop_after_the_reply_but_before_the_save_saves_nothing() {
    let agent = ScriptedAgent::new(Ok(summary_reply()), Ok(proposals_reply()));
    let host = TestHost::new(Some(agent.clone()));
    let builds = SummaryBuilds::default();
    let call = exchange(&host, CallStatus::Finishing);

    // Just before B answers, the database gets taken.
    let (release, released) = std::sync::mpsc::channel::<()>();
    let holder = Arc::clone(&host);
    let hook: Hook = Box::new(move || {
        let (held, is_held) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            block_on(holder.storage().write(&holder.sink, move |_| {
                held.send(()).unwrap();
                released.recv().ok();
                Ok(((), Vec::new()))
            }))
            .unwrap();
        });
        is_held.recv().unwrap();
    });
    // A's answer arms B's.
    let agent_for_b = Arc::clone(&agent);
    *agent.before.lock().unwrap() = Some(Box::new(move || {
        *agent_for_b.before.lock().unwrap() = Some(hook);
    }));

    let running = run::start(&host, &builds, &call.call).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !host.stages().contains(&(Saving, Running)) {
        assert!(std::time::Instant::now() < deadline, "saving did not start");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(builds.stop(&call.call, super::builds::Stop::Stopped));
    release.send(()).unwrap();
    block_on(running).unwrap();

    assert_eq!(
        host.last(),
        SummaryProgress {
            call_id: call.call.clone(),
            stage: Saving,
            state: SummaryStageState::Cancelled,
            counts: host.last().counts,
        }
    );
    let summary = host.summary(&call.call);
    assert_eq!(summary.state, SummaryState::Failed);
    assert_eq!(summary.error.as_deref(), Some(CANCELLED));
    assert_eq!(summary.content, None);
    assert!(
        host.storage()
            .read_now(|db| proposals::list(db, &call.call))
            .unwrap()
            .is_empty()
    );
    // «Остановить» closes the call.
    assert_eq!(host.closed(), vec![call.call.clone()]);
}

/// «Сбой во время сборки»: the app died during a build and starts again;
/// the call is «завершён» and its summary reads failed / interrupted, with
/// «Собрать итоги» on the page.
#[test]
fn a_crash_during_a_build_leaves_a_finished_call_to_build_again() {
    let dir = tempfile::tempdir().unwrap();
    let (call, rebuilt) = {
        let storage = Storage::open_in(dir.path());
        storage
            .read_now(|connection| {
                let data = CallData { connection };
                let call = data.call(None, &[], CallStatus::Finishing);
                summaries::start_building(connection, &call)?;
                // A finished call whose rebuild was running keeps its summary.
                let rebuilt = data.call(None, &[], CallStatus::Finished);
                let ready = summaries::ReadySummary {
                    title: "Прежние итоги".to_owned(),
                    tldr: String::new(),
                    transcript_pass: SummaryTranscriptPass::Live,
                    content: summaries::SummaryContent::default(),
                };
                summaries::save_ready(connection, &rebuilt, &ready)?;
                summaries::start_building(connection, &rebuilt)?;
                Ok((call, rebuilt))
            })
            .unwrap()
    };

    let storage = Storage::open_in(dir.path());
    let (call, summary, kept) = storage
        .read_now(|connection| {
            Ok((
                calls::get(connection, &call)?,
                summaries::get(connection, &call)?.unwrap(),
                summaries::get(connection, &rebuilt)?.unwrap(),
            ))
        })
        .unwrap();
    assert_eq!(call.status, CallStatus::Finished);
    assert_eq!(summary.state, SummaryState::Failed);
    assert_eq!(summary.error.as_deref(), Some(summaries::INTERRUPTED));
    assert_eq!(summary.content, None);
    assert_eq!(kept.state, SummaryState::Failed);
    assert_eq!(kept.title, "Прежние итоги");
    assert!(kept.content.is_some());
}
