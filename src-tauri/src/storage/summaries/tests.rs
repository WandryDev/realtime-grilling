use rusqlite_migration::Migrations;

use super::*;
use crate::storage::{
    DATABASE_FILE, MIGRATION_LIST, MIGRATIONS, SCHEMA_VERSION,
    call_state::{
        EvidenceSource, NewQuestion, QuestionAction, QuestionStatus, ValidatedOp, ValidatedPatch,
    },
    calls::{CallCreate, CallUpdate},
    new_id, open, open_in_memory, people,
    people::PersonCreate,
    projects::{self, ProjectCreate},
    proposals::{DecisionChange, ProposalDecision, ProposalKind, ProposalTarget},
    recordings::{self, RecordingFiles, RecordingLinks},
};

fn files(id: &str) -> RecordingFiles {
    RecordingFiles {
        me: format!("recordings/{id}/me.opus"),
        others: format!("recordings/{id}/others.opus"),
    }
}

fn project(connection: &Connection, name: &str) -> String {
    let input = ProjectCreate {
        name: name.to_owned(),
        ..ProjectCreate::default()
    };
    projects::create(connection, input).unwrap().0.id
}

fn person(connection: &Connection, project_id: &str, name: &str) -> String {
    let input = PersonCreate {
        project_id: project_id.to_owned(),
        name: name.to_owned(),
        ..PersonCreate::default()
    };
    people::create(connection, input).unwrap().0.id
}

fn call(connection: &Connection, project_id: Option<&str>, status: CallStatus) -> String {
    let input = CallCreate {
        project_id: project_id.map(str::to_owned),
        status: Some(status),
        ..CallCreate::default()
    };
    calls::create(connection, input).unwrap().0.id
}

fn recording(connection: &Connection, call_id: &str) -> String {
    let id = recordings::create(connection, &RecordingLinks::call(call_id), 1_000, files).unwrap();
    // Not `recordings::finish`: it reads columns a version 6 database lacks.
    connection
        .execute(
            "UPDATE recordings SET status = 'finished', ended_at = 60000 WHERE id = ?1",
            [&id],
        )
        .unwrap();
    id
}

fn quote(text: &str) -> Vec<Evidence> {
    vec![Evidence {
        source: EvidenceSource::Segment,
        id: "S1".to_owned(),
        quote: text.to_owned(),
    }]
}

/// A recording of the call with one topic and a question per text; returns
/// the question ids in order.
fn questions(connection: &Connection, call_id: &str, texts: &[&str]) -> Vec<String> {
    let id = recording(connection, call_id);
    let mut ops = vec![
        ValidatedOp::CreateTopic {
            title: "Очередь".to_owned(),
        },
        ValidatedOp::SetCardField {
            field: CardLens::Goal,
            value: "Разгрузить операторов".to_owned(),
            evidence: quote("разгрузить"),
        },
    ];
    ops.extend(texts.iter().map(|text| {
        ValidatedOp::AddQuestion(NewQuestion {
            text: (*text).to_owned(),
            description: String::new(),
            card_field: CardLens::Goal,
            gap_type: GapType::Empty,
            priority: 2,
            evidence: quote("цитата"),
        })
    }));
    call_state::apply_patch(connection, &id, &ValidatedPatch { ops })
        .unwrap()
        .question_ids
}

fn status(connection: &Connection, question_id: &str) -> QuestionStatus {
    let recording_id: String = connection
        .query_row(
            "SELECT recording_id FROM questions WHERE id = ?1",
            [question_id],
            |row| row.get(0),
        )
        .unwrap();
    call_state::get(connection, &recording_id)
        .unwrap()
        .questions
        .into_iter()
        .find(|question| question.id == question_id)
        .unwrap()
        .status
}

fn evidence(text: &str) -> CallEvidence {
    CallEvidence {
        recording_id: "r".to_owned(),
        segment_id: "s".to_owned(),
        start_ms: 1_200,
        quote: text.to_owned(),
    }
}

fn moment(start_ms: i64) -> SegmentMoment {
    SegmentMoment {
        recording_id: "r".to_owned(),
        segment_id: format!("s{start_ms}"),
        start_ms,
        end_ms: start_ms + 500,
    }
}

fn content(topic: &str) -> SummaryContent {
    let topic_id = new_id();
    SummaryContent {
        topics: vec![SummaryTopic {
            id: topic_id.clone(),
            topic_ids: Vec::new(),
            title: topic.to_owned(),
            from: moment(0),
            to: moment(60_000),
            points: vec![SummaryPoint {
                text: "Операторы не успевают".to_owned(),
                status: PointStatus::Fact,
                evidence: vec![evidence("не успевают")],
            }],
        }],
        cards: vec![SummaryCard {
            id: new_id(),
            topic_id: topic_id.clone(),
            title: topic.to_owned(),
            decision: TaskCardDecision::Pending,
            fields: vec![SummaryCardField {
                field: CardLens::Goal,
                facts: vec![CardFact {
                    text: "Разгрузить операторов".to_owned(),
                    status: FactStatus::Confirmed,
                    source: FactSource::Client,
                    evidence: vec![evidence("разгрузить")],
                }],
            }],
        }],
        next: vec![NextQuestion {
            text: "Как поймём, что готово?".to_owned(),
            topic_id: Some(topic_id),
            field: Some(CardLens::Acceptance),
            gap: GapType::Empty,
        }],
    }
}

fn ready(title: &str, topic: &str) -> ReadySummary {
    ReadySummary {
        title: title.to_owned(),
        tldr: "Договорились о пилоте.".to_owned(),
        transcript_pass: SummaryTranscriptPass::Refined,
        content: content(topic),
    }
}

fn brief(after: &str) -> NewProposal {
    NewProposal {
        target: ProposalTarget::Brief,
        person_id: None,
        field: "glossary".to_owned(),
        before: None,
        after: after.to_owned(),
        kind: ProposalKind::Said,
        evidence: vec![evidence(after)],
    }
}

fn about(person_id: &str, field: &str, after: &str) -> NewProposal {
    NewProposal {
        target: ProposalTarget::Person,
        person_id: Some(person_id.to_owned()),
        field: field.to_owned(),
        before: Some("3".to_owned()),
        after: after.to_owned(),
        kind: ProposalKind::Inferred,
        evidence: Vec::new(),
    }
}

fn build(summary: ReadySummary, proposals: Vec<NewProposal>) -> SummaryBuild {
    SummaryBuild {
        summary,
        proposals: Some(proposals),
        answered: Vec::new(),
    }
}

fn decide(connection: &Connection, id: &str, decision: ProposalDecision) {
    let change = DecisionChange {
        decision,
        edited: None,
        applied: None,
    };
    proposals::set_decision(connection, id, &change).unwrap();
}

fn count(connection: &Connection, table: &str) -> i64 {
    connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

/// Task 1.2: a version 6 database keeps its calls, recordings and
/// questions; its finished calls read as interrupted.
#[test]
fn migration_0007_keeps_a_version_6_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DATABASE_FILE);
    let (acme, igor, finished, live, question_ids, recording_id) = {
        let v6 = Migrations::from_slice(&MIGRATION_LIST[..6]);
        let connection = open(&path, &v6).unwrap();
        let acme = project(&connection, "Acme");
        let igor = person(&connection, &acme, "Игорь");
        let finished = call(&connection, Some(&acme), CallStatus::Finished);
        let live = call(&connection, None, CallStatus::Live);
        let question_ids = questions(&connection, &finished, &["Сколько звонков?"]);
        let recording_id = recording(&connection, &live);
        (acme, igor, finished, live, question_ids, recording_id)
    };

    let connection = open(&path, &MIGRATIONS).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION as i64);
    assert_eq!(count(&connection, "pragma_foreign_key_check"), 0);
    assert_eq!(
        calls::get(&connection, &finished).unwrap().open_questions,
        1
    );
    assert_eq!(status(&connection, &question_ids[0]), QuestionStatus::Open);
    assert_eq!(
        recordings::get(&connection, &recording_id)
            .unwrap()
            .audio_deleted_at,
        None
    );

    let old = get(&connection, &finished).unwrap().unwrap();
    assert_eq!(old.state, SummaryState::Failed);
    assert_eq!(old.error.as_deref(), Some(INTERRUPTED));
    assert_eq!(old.content, None);
    assert_eq!(get(&connection, &live).unwrap(), None);

    // The new tables work on the migrated rows.
    let summary = ready("Пилот", "Очередь");
    let (saved, _) = save_build(
        &connection,
        &finished,
        &build(
            summary.clone(),
            vec![brief("USD МІКС"), about(&igor, "tech", "4")],
        ),
    )
    .unwrap();
    assert_eq!(saved.summary.content, Some(summary.content));
    assert_eq!(saved.proposals.len(), 2);
    assert_eq!(
        proposals::pending_for_person(&connection, &igor)
            .unwrap()
            .len(),
        1
    );
    projects::delete(&connection, &acme).unwrap();
    assert_eq!(count(&connection, "call_summaries"), 0);
    assert_eq!(count(&connection, "call_proposals"), 0);
}

/// L40: a call whose audio the old «Удалить запись» only flagged in its
/// frontend JSON reads as without audio after the migration.
#[test]
fn migration_0007_moves_the_old_audio_deleted_flag() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DATABASE_FILE);
    let (flagged, kept) = {
        let v6 = Migrations::from_slice(&MIGRATION_LIST[..6]);
        let connection = open(&path, &v6).unwrap();
        let flagged_call = call(&connection, None, CallStatus::Finished);
        let kept_call = call(&connection, None, CallStatus::Finished);
        let flagged = recording(&connection, &flagged_call);
        let kept = recording(&connection, &kept_call);
        connection
            .execute(
                "UPDATE calls SET summary = '{\"audioDeleted\": true, \"tasks\": {}}', \
                 updated_at = 7000 WHERE id = ?1",
                [&flagged_call],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE calls SET summary = '{\"audioDeleted\": false}' WHERE id = ?1",
                [&kept_call],
            )
            .unwrap();
        (flagged, kept)
    };
    let connection = open(&path, &MIGRATIONS).unwrap();
    let flagged = recordings::get(&connection, &flagged).unwrap();
    assert_eq!(flagged.audio_deleted_at, Some(7000));
    assert_eq!(
        flagged.transcript_state,
        recordings::TranscriptState::Failed
    );
    assert_eq!(
        recordings::get(&connection, &kept)
            .unwrap()
            .audio_deleted_at,
        None
    );
}

#[test]
fn a_build_saves_the_summary_and_names_an_untitled_call() {
    let connection = open_in_memory().unwrap();
    let acme = project(&connection, "Acme");
    let id = call(&connection, Some(&acme), CallStatus::Finishing);
    assert_eq!(
        get(&connection, &id).unwrap(),
        None,
        "finishing, nothing yet"
    );

    let (building, events) = start_building(&connection, &id).unwrap();
    assert_eq!(building.state, SummaryState::Building);
    assert_eq!((building.content, building.built_at), (None, None));
    assert_eq!(
        events,
        vec![DataChanged::new(
            Entity::Call,
            &id,
            Some(&acme),
            Change::Updated
        )]
    );

    let summary = ready("  Очередь звонков  ", "Очередь");
    let (saved, _) = save_build(&connection, &id, &build(summary.clone(), Vec::new())).unwrap();
    let read = get(&connection, &id).unwrap().unwrap();
    assert_eq!(read, saved.summary);
    assert_eq!(read.state, SummaryState::Ready);
    assert_eq!(read.error, None);
    assert_eq!(read.title, "Очередь звонков");
    assert_eq!(read.tldr, summary.tldr);
    assert_eq!(read.transcript_pass, Some(SummaryTranscriptPass::Refined));
    assert_eq!(read.content, Some(summary.content));
    assert!(read.built_at.is_some());
    assert_eq!(
        calls::get(&connection, &id).unwrap().title,
        "Очередь звонков"
    );

    // A call with a title keeps it.
    calls::update(
        &connection,
        &id,
        CallUpdate {
            title: Some("Мой звонок".to_owned()),
            ..CallUpdate::default()
        },
    )
    .unwrap();
    save_ready(&connection, &id, &ready("Другое", "Очередь")).unwrap();
    assert_eq!(calls::get(&connection, &id).unwrap().title, "Мой звонок");
    assert_eq!(get(&connection, &id).unwrap().unwrap().title, "Другое");

    // Card ids must be unique.
    let mut twice = ready("Пилот", "Очередь");
    twice.content.cards.push(twice.content.cards[0].clone());
    let error = save_ready(&connection, &id, &twice).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    let error = start_building(&connection, "nope").unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
}

/// `call-summary`, "Ошибка сборки": a rebuild keeps the previous summary
/// until the new one is saved, and a rebuild that fails changes nothing.
#[test]
fn a_failed_rebuild_keeps_the_previous_summary() {
    let connection = open_in_memory().unwrap();
    let acme = project(&connection, "Acme");
    let igor = person(&connection, &acme, "Игорь");
    let id = call(&connection, Some(&acme), CallStatus::Finished);

    // Failed before anything was saved: no content.
    let (failed, _) = save_failed(&connection, &id, "нужен вход в Claude Code").unwrap();
    assert_eq!(failed.state, SummaryState::Failed);
    assert_eq!(failed.content, None);

    let first = ready("Пилот", "Очередь");
    save_build(
        &connection,
        &id,
        &build(first.clone(), vec![brief("USD МІКС")]),
    )
    .unwrap();
    let saved = get(&connection, &id).unwrap().unwrap();

    let (building, _) = start_building(&connection, &id).unwrap();
    assert_eq!(building.state, SummaryState::Building);
    assert_eq!(building.content, saved.content);
    let (failed, _) = save_failed(&connection, &id, "Ответ не по схеме").unwrap();
    assert_eq!(failed.state, SummaryState::Failed);
    assert_eq!(failed.error.as_deref(), Some("Ответ не по схеме"));
    assert_eq!(
        (
            &failed.title,
            &failed.tldr,
            &failed.content,
            failed.built_at
        ),
        (&saved.title, &saved.tldr, &saved.content, saved.built_at)
    );
    assert_eq!(failed.transcript_pass, saved.transcript_pass);

    // A save that breaks halfway (a person of another project) rolls back:
    // the summary, the proposals and the questions are as they were.
    let other = project(&connection, "Globex");
    let stranger = person(&connection, &other, "Марина");
    let question = questions(&connection, &id, &["Сколько звонков?"]).remove(0);
    let before = proposals::list(&connection, &id).unwrap();
    let broken = SummaryBuild {
        summary: ready("Новое", "Другая тема"),
        proposals: Some(vec![
            about(&igor, "tech", "4"),
            about(&stranger, "tech", "5"),
        ]),
        answered: vec![AnsweredQuestion {
            question_id: question.clone(),
            evidence: quote("двести в день"),
        }],
    };
    let error = save_build(&connection, &id, &broken).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(get(&connection, &id).unwrap().unwrap(), failed);
    assert_eq!(proposals::list(&connection, &id).unwrap(), before);
    assert_eq!(status(&connection, &question), QuestionStatus::Open);
    assert_eq!(calls::get(&connection, &id).unwrap().title, "Пилот");

    let error = save_failed(&connection, &id, "  ").unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
}

/// Decision 5, "Пересборка": the pending proposals are replaced, the
/// accepted and rejected ones stay.
#[test]
fn a_rebuild_replaces_only_the_pending_proposals() {
    let connection = open_in_memory().unwrap();
    let acme = project(&connection, "Acme");
    let igor = person(&connection, &acme, "Игорь");
    let id = call(&connection, Some(&acme), CallStatus::Finished);
    let (first, _) = save_build(
        &connection,
        &id,
        &build(
            ready("Пилот", "Очередь"),
            vec![
                brief("USD МІКС"),
                about(&igor, "tech", "4"),
                about(&igor, "role", "Технический директор"),
            ],
        ),
    )
    .unwrap();
    let [accepted, rejected, pending] = [0, 1, 2].map(|i| first.proposals[i].id.clone());
    decide(&connection, &accepted, ProposalDecision::Accepted);
    decide(&connection, &rejected, ProposalDecision::Rejected);

    let (second, _) = save_build(
        &connection,
        &id,
        &build(
            ready("Пилот", "Очередь"),
            vec![about(&igor, "howToAsk", "Коротко")],
        ),
    )
    .unwrap();
    let ids: Vec<&str> = second.proposals.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&accepted.as_str()) && ids.contains(&rejected.as_str()));
    assert!(!ids.contains(&pending.as_str()));
    let new = second
        .proposals
        .iter()
        .find(|p| p.decision == ProposalDecision::Pending)
        .unwrap();
    assert_eq!(
        (new.field.as_str(), new.after.as_str()),
        ("howToAsk", "Коротко")
    );
    assert_eq!(proposals::list(&connection, &id).unwrap(), second.proposals);
    assert_eq!(
        proposals::get(&connection, &accepted).unwrap().decision,
        ProposalDecision::Accepted
    );
}

/// Decision 3, «сбой B не лишает звонок итогов»: a build whose proposals'
/// call failed saves its summary and keeps the pending proposals it had.
#[test]
fn a_build_without_new_proposals_keeps_the_pending_ones() {
    let connection = open_in_memory().unwrap();
    let acme = project(&connection, "Acme");
    let id = call(&connection, Some(&acme), CallStatus::Finished);
    let (first, _) = save_build(
        &connection,
        &id,
        &build(ready("Пилот", "Очередь"), vec![brief("USD МІКС")]),
    )
    .unwrap();
    let rebuild = SummaryBuild {
        summary: ready("Пилот 2", "Очередь"),
        proposals: None,
        answered: Vec::new(),
    };
    let (second, _) = save_build(&connection, &id, &rebuild).unwrap();
    assert_eq!(second.summary.title, "Пилот 2");
    assert_eq!(second.proposals, first.proposals);
    assert_eq!(proposals::list(&connection, &id).unwrap(), first.proposals);
}

/// Decision 6: open and asked questions become answered; answered and
/// hidden ones, and questions of another call, stay as they are.
#[test]
fn reconciliation_does_not_touch_answered_or_hidden_questions() {
    let connection = open_in_memory().unwrap();
    let acme = project(&connection, "Acme");
    let id = call(&connection, Some(&acme), CallStatus::Finished);
    let other = call(&connection, Some(&acme), CallStatus::Finished);
    let ids = questions(&connection, &id, &["Открыт", "Задан", "Скрыт", "Отвечен"]);
    let [open, asked, hidden, answered] = [0, 1, 2, 3].map(|i| ids[i].clone());
    let foreign = questions(&connection, &other, &["Чужой"]).remove(0);
    call_state::act(&connection, &asked, QuestionAction::Asked).unwrap();
    call_state::act(&connection, &hidden, QuestionAction::Hide).unwrap();
    let recording_id: String = connection
        .query_row(
            "SELECT recording_id FROM questions WHERE id = ?1",
            [&answered],
            |row| row.get(0),
        )
        .unwrap();
    call_state::apply_patch(
        &connection,
        &recording_id,
        &ValidatedPatch {
            ops: vec![ValidatedOp::MarkAnswered {
                question_id: answered.clone(),
                evidence: quote("во время звонка"),
            }],
        },
    )
    .unwrap();

    let answers: Vec<AnsweredQuestion> = [&open, &asked, &hidden, &answered, &foreign]
        .into_iter()
        .map(|question_id| AnsweredQuestion {
            question_id: question_id.clone(),
            evidence: quote("после звонка"),
        })
        .collect();
    let reconciled = reconcile_questions(&connection, &id, &answers).unwrap();
    assert_eq!(reconciled.question_ids, vec![open.clone(), asked.clone()]);
    assert_eq!(reconciled.recording_ids, vec![recording_id.clone()]);

    let state = call_state::get(&connection, &recording_id).unwrap();
    let of = |question_id: &str| {
        state
            .questions
            .iter()
            .find(|question| question.id == question_id)
            .unwrap()
            .clone()
    };
    for question_id in [&open, &asked] {
        let question = of(question_id);
        assert_eq!(question.status, QuestionStatus::Answered);
        assert_eq!(question.answer_evidence, Some(quote("после звонка")));
        assert!(!question.visible);
    }
    assert_eq!(of(&hidden).status, QuestionStatus::Hidden);
    assert_eq!(of(&hidden).answer_evidence, None);
    assert_eq!(
        of(&answered).answer_evidence,
        Some(quote("во время звонка"))
    );
    assert_eq!(status(&connection, &foreign), QuestionStatus::Open);
    assert_eq!(calls::get(&connection, &id).unwrap().open_questions, 0);

    let bare = [AnsweredQuestion {
        question_id: foreign.clone(),
        evidence: Vec::new(),
    }];
    let error = reconcile_questions(&connection, &other, &bare).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(status(&connection, &foreign), QuestionStatus::Open);
}

/// `call-task-cards`, "Решение по карточке" (storage part of task 3.2).
#[test]
fn a_card_of_the_summary_changes_by_its_id() {
    let connection = open_in_memory().unwrap();
    let id = call(&connection, None, CallStatus::Finished);
    let summary = ready("Пилот", "Очередь");
    let card_id = summary.content.cards[0].id.clone();
    let missing = CardPatch::default();
    let error = update_card(&connection, &id, &card_id, &missing).unwrap_err();
    assert!(
        matches!(error, CommandError::NotFound { .. }),
        "no summary yet: {error:?}"
    );
    save_ready(&connection, &id, &summary).unwrap();

    let rename = CardPatch {
        title: Some(" Очередь звонков ".to_owned()),
        ..CardPatch::default()
    };
    let (card, events) = update_card(&connection, &id, &card_id, &rename).unwrap();
    assert_eq!(card.title, "Очередь звонков");
    assert_eq!(card.decision, TaskCardDecision::Pending);
    assert_eq!(
        events,
        vec![DataChanged::new(Entity::Call, &id, None, Change::Updated)]
    );
    let accept = CardPatch {
        decision: Some(TaskCardDecision::Accepted),
        ..CardPatch::default()
    };
    update_card(&connection, &id, &card_id, &accept).unwrap();
    let stored = get(&connection, &id).unwrap().unwrap().content.unwrap();
    assert_eq!(stored.cards[0].title, "Очередь звонков");
    assert_eq!(stored.cards[0].decision, TaskCardDecision::Accepted);
    assert_eq!(stored.topics, summary.content.topics, "the rest stays");

    // A failed rebuild keeps the cards, and they still change.
    save_failed(&connection, &id, "Ответ не по схеме").unwrap();
    update_card(&connection, &id, &card_id, &rename).unwrap();

    let blank = CardPatch {
        title: Some("  ".to_owned()),
        ..CardPatch::default()
    };
    let error = update_card(&connection, &id, &card_id, &blank).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    let error = update_card(&connection, &id, "nope", &accept).unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
}

/// Decision 5, last bullet: a call `finish_stale` closed without a summary
/// reads as interrupted; a build a crash left becomes interrupted too,
/// keeping its previous summary.
#[test]
fn a_call_closed_by_finish_stale_reads_as_interrupted() {
    let connection = open_in_memory().unwrap();
    let stale = call(&connection, None, CallStatus::Finishing);
    let rebuilt = call(&connection, None, CallStatus::Finished);
    save_ready(&connection, &rebuilt, &ready("Пилот", "Очередь")).unwrap();
    start_building(&connection, &rebuilt).unwrap();
    let saved = stored(&connection, &rebuilt).unwrap().unwrap();

    assert_eq!(
        calls::finish_stale(&connection, 99_000).unwrap(),
        vec![stale.clone()]
    );
    assert_eq!(
        interrupt_building(&connection, 99_000).unwrap(),
        vec![rebuilt.clone()]
    );

    let summary = get(&connection, &stale).unwrap().unwrap();
    assert_eq!(summary.state, SummaryState::Failed);
    assert_eq!(summary.error.as_deref(), Some(INTERRUPTED));
    assert_eq!(summary.content, None);
    let summary = get(&connection, &rebuilt).unwrap().unwrap();
    assert_eq!(summary.state, SummaryState::Failed);
    assert_eq!(summary.error.as_deref(), Some(INTERRUPTED));
    assert_eq!(summary.content, saved.content);
    assert!(interrupt_building(&connection, 99_000).unwrap().is_empty());
    let error = get(&connection, "nope").unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
}

/// Summaries and proposals go with their call, the calls of a deleted
/// project, and a proposal about a person with the person.
#[test]
fn summaries_and_proposals_follow_their_call_project_and_person() {
    let connection = open_in_memory().unwrap();
    let acme = project(&connection, "Acme");
    let globex = project(&connection, "Globex");
    let igor = person(&connection, &acme, "Игорь");
    let olga = person(&connection, &acme, "Ольга");
    let marina = person(&connection, &globex, "Марина");
    let first = call(&connection, Some(&acme), CallStatus::Finished);
    let second = call(&connection, Some(&acme), CallStatus::Finished);
    let theirs = call(&connection, Some(&globex), CallStatus::Finished);
    let loose = call(&connection, None, CallStatus::Finished);
    for (id, proposals) in [
        (&first, vec![brief("A"), about(&igor, "tech", "4")]),
        (
            &second,
            vec![
                brief("B"),
                about(&igor, "tech", "5"),
                about(&olga, "role", "CTO"),
            ],
        ),
        (&theirs, vec![about(&marina, "tech", "2")]),
        (&loose, Vec::new()),
    ] {
        save_build(
            &connection,
            id,
            &build(ready("Пилот", "Очередь"), proposals),
        )
        .unwrap();
    }
    let rows = |call_id: &str| -> (i64, i64) {
        let one = |table: &str| -> i64 {
            connection
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE call_id = ?1"),
                    [call_id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        (one("call_summaries"), one("call_proposals"))
    };

    // A person: their proposals go, the call's other proposals stay.
    people::delete(&connection, &igor).unwrap();
    assert_eq!(rows(&first), (1, 1));
    assert_eq!(rows(&second), (1, 2));
    let error = proposals::pending_for_person(&connection, &igor).unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");

    calls::delete(&connection, &first).unwrap();
    assert_eq!(rows(&first), (0, 0));
    assert_eq!(rows(&second), (1, 2));

    projects::delete(&connection, &acme).unwrap();
    assert_eq!(rows(&second), (0, 0));
    assert_eq!(rows(&theirs), (1, 1), "another project's stay");
    assert_eq!(rows(&loose), (1, 0), "a call without a project stays");
    assert_eq!(count(&connection, "pragma_foreign_key_check"), 0);
}
