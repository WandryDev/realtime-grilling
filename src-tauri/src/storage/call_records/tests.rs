use super::{testing::*, *};
use crate::storage::{
    DATABASE_FILE, MIGRATIONS,
    call_state::{self, QuestionAction, TaskCardDecision, ValidatedOp, ValidatedPatch},
    open, open_in_memory,
    transcript::TranscriptChannel::{Me, Others},
};

const CALL_AT: i64 = 1_793_880_000_000;

/// A call of two recordings ("Отменить завершение"): the first refined
/// after the call, the second only live.
struct TwoRecordings {
    connection: Connection,
    call: String,
    first: String,
    second: String,
    /// The live phrase of the client in the first recording.
    said: TranscriptSegment,
}

fn two_recordings(connection: Connection) -> TwoRecordings {
    let project = project(&connection, "Обменник");
    let call = call(&connection, Some(&project), "Касса", CALL_AT);
    let first = recording(&connection, &call, CALL_AT);
    let second = recording(&connection, &call, CALL_AT + 600_000);
    let said = live(
        &connection,
        &first,
        Others,
        4_000,
        "Наличные считаем вечером",
    );
    live(&connection, &first, Me, 1_000, "Как считаете кассу?");
    live(&connection, &second, Others, 2_000, "Ещё про бронь");
    TwoRecordings {
        connection,
        call,
        first,
        second,
        said,
    }
}

fn refine_first(fx: &TwoRecordings) -> Vec<TranscriptSegment> {
    refined(
        &fx.connection,
        &fx.first,
        vec![
            input(Me, 900, "Как вы считаете кассу?"),
            input(Others, 3_800, "Наличные мы считаем вечером"),
            input(Others, 9_000, "Потом сверяем"),
        ],
    )
}

/// `call-details`, "Звонок с двумя записями".
#[test]
fn a_call_of_two_recordings_reads_both_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let fx = two_recordings(open_in_memory().unwrap());
    let shown = refine_first(&fx);
    let files = recordings::get(&fx.connection, &fx.first).unwrap().files;
    std::fs::create_dir_all(dir.path().join(&files.me).parent().unwrap()).unwrap();
    std::fs::write(dir.path().join(&files.me), [0_u8; 120]).unwrap();
    std::fs::write(dir.path().join(&files.others), [0_u8; 80]).unwrap();
    recordings::mark_audio_deleted(&fx.connection, &fx.second, CALL_AT + 700_000).unwrap();

    let read = transcript(&fx.connection, Some(dir.path()), &fx.call).unwrap();
    let ids: Vec<&str> = read.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, [fx.first.as_str(), fx.second.as_str()]);

    let first = &read[0];
    assert_eq!(first.started_at, CALL_AT);
    assert_eq!(first.duration_ms, Some(60_000));
    assert_eq!(first.pass, TranscriptPass::Refined);
    assert_eq!(first.transcript_state, TranscriptState::Refined);
    assert_eq!(first.segments, shown, "the refined pass, in time order");
    assert_eq!((first.me_bytes, first.others_bytes), (Some(120), Some(80)));
    assert!(!first.audio_deleted);

    let second = &read[1];
    assert_eq!(second.started_at, CALL_AT + 600_000);
    assert_eq!(second.pass, TranscriptPass::Live);
    assert_eq!(second.segments.len(), 1);
    assert!(second.audio_deleted);
    assert_eq!((second.me_bytes, second.others_bytes), (None, None));

    let error = transcript(&fx.connection, None, "nope").unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
}

/// Decision 11: the live id a question keeps still finds its time, and the
/// phrase of the refined pass that replaced it.
#[test]
fn a_live_segment_finds_its_moment_after_the_second_pass() {
    let fx = two_recordings(open_in_memory().unwrap());
    let applied = topic(
        &fx.connection,
        &fx.first,
        "Касса",
        "Считать наличные",
        vec![quote(&fx.said)],
        CardLens::Goal,
        GapType::Assumption,
    );
    let question = applied.question_ids[0].clone();
    let answer = live(
        &fx.connection,
        &fx.first,
        Others,
        20_000,
        "Да, каждый вечер",
    );
    let patch = ValidatedPatch {
        ops: vec![ValidatedOp::MarkAnswered {
            question_id: question.clone(),
            evidence: vec![quote(&answer)],
        }],
    };
    call_state::apply_patch(&fx.connection, &fx.first, &patch).unwrap();

    let before = questions(&fx.connection, &fx.call).unwrap();
    assert_eq!(
        before[0].moment,
        Some(CallMoment {
            recording_id: fx.first.clone(),
            segment_id: fx.said.id.clone(),
            start_ms: 4_000,
        })
    );

    let shown = refine_first(&fx);
    let after = questions(&fx.connection, &fx.call).unwrap();
    assert_eq!(after.len(), 1);
    let read = &after[0];
    assert_eq!(read.id, question);
    assert_eq!(read.status, QuestionStatus::Answered);
    // The overlapping phrase of the client in the refined pass.
    assert_eq!(
        read.moment,
        Some(CallMoment {
            recording_id: fx.first.clone(),
            segment_id: shown[1].id.clone(),
            start_ms: 4_000,
        })
    );
    // The answer has no overlapping phrase: the nearest one of its channel.
    let answer_moment = read.answer.clone().unwrap();
    assert_eq!(answer_moment.segment_id, shown[2].id);
    assert_eq!(answer_moment.start_ms, 20_000);
    assert_eq!(moment(&fx.connection, "nope").unwrap(), None);
}

#[test]
fn questions_of_every_recording_are_read_in_order() {
    let fx = two_recordings(open_in_memory().unwrap());
    let on_project = vec![Evidence {
        source: EvidenceSource::Project,
        id: "P1".to_owned(),
        quote: "обменник валют".to_owned(),
    }];
    topic(
        &fx.connection,
        &fx.second,
        "Бронь",
        "Бронировать курс",
        on_project,
        CardLens::Goal,
        GapType::Empty,
    );
    let first = topic(
        &fx.connection,
        &fx.first,
        "Касса",
        "Считать наличные",
        vec![quote(&fx.said)],
        CardLens::Goal,
        GapType::Empty,
    );
    call_state::act(&fx.connection, &first.question_ids[0], QuestionAction::Hide).unwrap();

    let read = questions(&fx.connection, &fx.call).unwrap();
    let texts: Vec<(&str, QuestionStatus)> = read
        .iter()
        .map(|question| (question.text.as_str(), question.status))
        .collect();
    assert_eq!(
        texts,
        [
            ("Что с «Касса»?", QuestionStatus::Hidden),
            ("Что с «Бронь»?", QuestionStatus::Open),
        ]
    );
    // A question on the project only has no moment.
    assert_eq!(read[1].moment, None);
    assert_eq!(read[1].answer, None);
}

/// `call-task-cards`, "Итоги не собраны": the fast loop's cards of both
/// recordings, one value per lens, the state from the lens's questions.
#[test]
fn before_a_summary_the_cards_are_the_fast_loops() {
    let fx = two_recordings(open_in_memory().unwrap());
    topic(
        &fx.connection,
        &fx.second,
        "Бронь",
        "Бронировать курс",
        Vec::new(),
        CardLens::Goal,
        GapType::Contradiction,
    );
    topic(
        &fx.connection,
        &fx.first,
        "Касса",
        "Считать наличные",
        vec![quote(&fx.said)],
        CardLens::Goal,
        GapType::Assumption,
    );
    let shown = refine_first(&fx);

    let read = cards(&fx.connection, &fx.call).unwrap();
    assert_eq!(read.source, CallCardsSource::Live);
    assert!(read.next.is_empty());
    let titles: Vec<&str> = read.cards.iter().map(|card| card.title.as_str()).collect();
    assert_eq!(titles, ["Касса", "Бронь"], "recording after recording");

    let till = &read.cards[0];
    assert_eq!(till.decision, TaskCardDecision::Pending);
    assert_eq!(till.fields.len(), CardLens::ALL.len());
    let goal = &till.fields[0];
    assert_eq!(goal.field, CardLens::Goal);
    assert_eq!(goal.facts.len(), 1);
    let fact = &goal.facts[0];
    assert_eq!(fact.text, "Считать наличные");
    assert_eq!(fact.status, FactStatus::Assumption);
    assert_eq!(fact.source, FactSource::Client);
    assert_eq!(
        fact.evidence,
        [CallEvidence {
            recording_id: fx.first.clone(),
            segment_id: shown[1].id.clone(),
            start_ms: 4_000,
            quote: fx.said.text.clone(),
        }]
    );
    assert!(till.fields[1..].iter().all(|field| field.facts.is_empty()));

    let booking = &read.cards[1].fields[0].facts[0];
    assert_eq!(booking.status, FactStatus::Contradiction);
    assert_eq!(booking.source, FactSource::Agent);
    assert!(booking.evidence.is_empty());
}

#[test]
fn a_saved_summary_gives_its_cards() {
    let fx = two_recordings(open_in_memory().unwrap());
    topic(
        &fx.connection,
        &fx.first,
        "Касса",
        "Считать наличные",
        vec![quote(&fx.said)],
        CardLens::Goal,
        GapType::Empty,
    );
    let card = summary(
        &fx.connection,
        &fx.call,
        "Кассу считают вечером.",
        "Касса вечером",
        "Сверять наличные",
        &fx.said,
    );
    let read = cards(&fx.connection, &fx.call).unwrap();
    assert_eq!(read.source, CallCardsSource::Summary);
    assert_eq!(read.cards.len(), 1);
    assert_eq!(read.cards[0].id, card);
    assert_eq!(read.next.len(), 1);

    // A failed rebuild keeps showing that summary.
    summaries::save_failed(&fx.connection, &fx.call, "agent").unwrap();
    assert_eq!(
        cards(&fx.connection, &fx.call).unwrap().source,
        CallCardsSource::Summary
    );
}

/// `call-task-cards`, "Переименовать": a summary card and a fast loop card
/// keep their new title and decision after a restart.
#[test]
fn a_renamed_card_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DATABASE_FILE);
    let fx = two_recordings(open(&path, &MIGRATIONS).unwrap());
    topic(
        &fx.connection,
        &fx.second,
        "Бронь",
        "Бронировать курс",
        Vec::new(),
        CardLens::Goal,
        GapType::Empty,
    );
    let live_id = call_state::get(&fx.connection, &fx.second).unwrap().cards[0]
        .id
        .clone();
    let rename = CardPatch {
        title: Some("  Бронь курса  ".to_owned()),
        decision: Some(TaskCardDecision::Accepted),
    };
    let (updated, events) = update_card(&fx.connection, &fx.call, &live_id, &rename).unwrap();
    assert_eq!(updated.card.title, "Бронь курса");
    assert_eq!(updated.card.decision, TaskCardDecision::Accepted);
    assert_eq!(updated.recording_id.as_deref(), Some(fx.second.as_str()));
    assert_eq!(
        (events[0].entity, events[0].id.as_str()),
        (Entity::Call, fx.call.as_str())
    );
    // Only the decision: the title stays.
    let discard = CardPatch {
        title: None,
        decision: Some(TaskCardDecision::Discarded),
    };
    update_card(&fx.connection, &fx.call, &live_id, &discard).unwrap();

    let card = summary(&fx.connection, &fx.call, "Итог", "Пункт", "Факт", &fx.said);
    let rename = CardPatch {
        title: Some("Касса по вечерам".to_owned()),
        decision: None,
    };
    let (updated, _) = update_card(&fx.connection, &fx.call, &card, &rename).unwrap();
    assert_eq!(updated.recording_id, None);
    let call = fx.call.clone();
    drop(fx);

    let connection = open(&path, &MIGRATIONS).unwrap();
    let read = cards(&connection, &call).unwrap();
    assert_eq!(read.cards[0].title, "Касса по вечерам");
    let state = call_state::get(
        &connection,
        &recordings::for_call(&connection, &call).unwrap()[1].id,
    )
    .unwrap();
    assert_eq!(state.cards[0].title, "Бронь курса");
    assert_eq!(state.cards[0].decision, TaskCardDecision::Discarded);

    // A blank title, a card of another call, an unknown call.
    let blank = CardPatch {
        title: Some(" ".to_owned()),
        decision: None,
    };
    let error = update_card(&connection, &call, &live_id, &blank).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    let other = super::testing::call(&connection, None, "Другой", CALL_AT);
    let error = update_card(&connection, &other, &live_id, &discard).unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    let error = update_card(&connection, "nope", &live_id, &discard).unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
}
