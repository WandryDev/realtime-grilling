//! Scenarios of `specs/local-storage` against an in-memory database, through
//! the same `Storage::read` / `Storage::write` the commands use.

use serde_json::json;

use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity, testing::RecordingSink},
    storage::{
        Storage,
        calls::{self, Call, CallCreate, CallStatus, CallUpdate},
        people::{self, Person, PersonCreate},
        projects::{self, Project, ProjectCreate, ProjectUpdate},
        questions::{self, QuestionCreate, QuestionStatus, QuestionUpdate},
        recordings::{self, RecordingFiles, RecordingLinks},
        settings::{self, SettingsMap},
        task_cards::{self, TaskCardCreate},
        topics::{self, TopicCreate},
        transcript::{self, SegmentInput, TranscriptChannel, TranscriptPass, TranscriptSegment},
    },
};

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

struct Fixture {
    storage: Storage,
    sink: RecordingSink,
}

impl Fixture {
    fn new() -> Self {
        Self {
            storage: Storage::in_memory(),
            sink: RecordingSink::default(),
        }
    }

    fn write<T: Send + 'static>(
        &self,
        write: impl FnOnce(&rusqlite::Transaction) -> CommandResult<(T, Vec<DataChanged>)>
        + Send
        + 'static,
    ) -> CommandResult<T> {
        block_on(self.storage.write(&self.sink, write))
    }

    fn read<T: Send + 'static>(
        &self,
        read: impl FnOnce(&rusqlite::Connection) -> CommandResult<T> + Send + 'static,
    ) -> CommandResult<T> {
        block_on(self.storage.read(read))
    }

    fn count(&self, table: &'static str) -> i64 {
        self.read(move |db| {
            Ok(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        })
        .unwrap()
    }

    fn project(&self, name: &str) -> Project {
        let input = ProjectCreate {
            name: name.to_owned(),
            description: Some(format!("{name}: описание")),
            ..ProjectCreate::default()
        };
        self.write(move |db| projects::create(db, input)).unwrap()
    }

    fn person(&self, project: &Project, name: &str) -> Person {
        let input = PersonCreate {
            project_id: project.id.clone(),
            name: name.to_owned(),
            role: Some("CEO".to_owned()),
            profile: Some(json!({ "howToAsk": "через деньги", "tech": 1, "project": 3 })),
        };
        self.write(move |db| people::create(db, input)).unwrap()
    }

    fn call(&self, project: &Project, participants: &[&Person]) -> Call {
        let input = CallCreate {
            project_id: project.id.clone(),
            title: Some("Приём звонков".to_owned()),
            participant_ids: Some(participants.iter().map(|p| p.id.clone()).collect()),
            ..CallCreate::default()
        };
        self.write(move |db| calls::create(db, input)).unwrap()
    }

    /// A recording row (no files) with `links`.
    fn recording(&self, links: RecordingLinks) -> String {
        self.write(move |db| {
            let id = recordings::create(db, &links, 1_000, |id| RecordingFiles {
                me: format!("recordings/{id}/me.opus"),
                others: format!("recordings/{id}/others.opus"),
            })?;
            Ok((id, Vec::new()))
        })
        .unwrap()
    }

    fn live(&self, recording_id: &str, segment: SegmentInput) -> TranscriptSegment {
        let id = recording_id.to_owned();
        self.write(move |db| transcript::append_live(db, &id, segment))
            .unwrap()
    }

    fn refined(&self, recording_id: &str, segments: Vec<SegmentInput>) -> Vec<TranscriptSegment> {
        let id = recording_id.to_owned();
        self.write(move |db| transcript::replace_refined(db, &id, segments))
            .unwrap()
    }

    fn transcript(&self, recording_id: &str) -> Vec<TranscriptSegment> {
        let id = recording_id.to_owned();
        self.read(move |db| transcript::for_recording(db, &id))
            .unwrap()
    }
}

fn segment(channel: TranscriptChannel, start_ms: i64, text: &str) -> SegmentInput {
    SegmentInput {
        channel,
        start_ms,
        end_ms: start_ms + 500,
        text: text.to_owned(),
    }
}

fn texts(segments: &[TranscriptSegment]) -> Vec<&str> {
    segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect()
}

fn is_uuid_v7(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.get_version_num() == 7)
}

#[test]
fn creates_a_project_with_a_uuid_v7_and_timestamps() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    assert!(is_uuid_v7(&project.id), "{}", project.id);
    assert_eq!(project.name, "Телемедиа");
    assert_eq!(project.created_at, project.updated_at);
    assert!(project.created_at > 1_700_000_000_000);
    assert_eq!(
        fx.sink.events(),
        vec![DataChanged::new(
            Entity::Project,
            &project.id,
            Some(&project.id),
            Change::Created
        )]
    );
}

#[test]
fn two_projects_with_the_same_name_get_different_ids() {
    let fx = Fixture::new();
    let first = fx.project("Телемедиа");
    let second = fx.project("Телемедиа");
    assert_ne!(first.id, second.id);
    let id = second.id.clone();
    assert_eq!(
        fx.read(move |db| projects::get(db, &id)).unwrap().id,
        second.id
    );
    assert_eq!(fx.read(projects::list).unwrap().len(), 2);
}

#[test]
fn empty_project_name_is_invalid_and_writes_nothing() {
    let fx = Fixture::new();
    let input = ProjectCreate {
        name: "   ".to_owned(),
        ..ProjectCreate::default()
    };
    let error = fx.write(move |db| projects::create(db, input)).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(fx.count("projects"), 0);
    assert!(fx.sink.events().is_empty());
}

#[test]
fn missing_records_are_not_found() {
    let fx = Fixture::new();
    let get = fx.read(|db| projects::get(db, "nope")).unwrap_err();
    assert!(matches!(get, CommandError::NotFound { .. }), "{get:?}");
    let update = fx
        .write(|db| projects::update(db, "nope", ProjectUpdate::default()))
        .unwrap_err();
    assert!(matches!(update, CommandError::NotFound { .. }));
    let delete = fx.write(|db| projects::delete(db, "nope")).unwrap_err();
    assert!(matches!(delete, CommandError::NotFound { .. }));
    let person = PersonCreate {
        project_id: "nope".to_owned(),
        name: "Ольга".to_owned(),
        ..PersonCreate::default()
    };
    let orphan = fx.write(move |db| people::create(db, person)).unwrap_err();
    assert!(matches!(orphan, CommandError::NotFound { .. }));
    assert!(fx.sink.events().is_empty());
}

#[test]
fn update_moves_updated_at_and_keeps_created_at() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let id = project.id.clone();
    let patch = ProjectUpdate {
        description: Some("Новое описание".to_owned()),
        ..ProjectUpdate::default()
    };
    let updated = fx
        .write(move |db| projects::update(db, &id, patch))
        .unwrap();
    assert_eq!(updated.description, "Новое описание");
    assert_eq!(updated.name, "Телемедиа", "absent fields stay");
    assert_eq!(updated.created_at, project.created_at);
    assert!(updated.updated_at > project.updated_at);
    assert_eq!(fx.sink.events()[1].change, Change::Updated);
}

#[test]
fn deleting_a_project_removes_everything_of_it_and_nothing_else() {
    let fx = Fixture::new();
    let fill = |name: &str| {
        let project = fx.project(name);
        let person = fx.person(&project, "Ольга");
        let call = fx.call(&project, &[&person]);
        let call_id = call.id.clone();
        let topic = fx
            .write(move |db| {
                topics::create(
                    db,
                    TopicCreate {
                        call_id,
                        title: "Очередь".to_owned(),
                        position: None,
                    },
                )
            })
            .unwrap();
        let topic_id = topic.id.clone();
        let card = fx
            .write(move |db| {
                task_cards::create(
                    db,
                    TaskCardCreate {
                        topic_id,
                        ..TaskCardCreate::default()
                    },
                )
            })
            .unwrap();
        let input = QuestionCreate {
            call_id: call.id.clone(),
            text: "Что слышит клиент, когда все заняты?".to_owned(),
            topic_id: Some(topic.id),
            card_id: Some(card.id),
            ..QuestionCreate::default()
        };
        fx.write(move |db| questions::create(db, input)).unwrap();
        let of_call = fx.recording(RecordingLinks::call(&call.id));
        fx.live(&of_call, segment(TranscriptChannel::Others, 0, "Алло"));
        // A recording of the project before its call exists.
        let of_project = fx.recording(RecordingLinks {
            project_id: Some(project.id.clone()),
            participant_ids: vec![person.id.clone()],
            ..RecordingLinks::default()
        });
        fx.live(
            &of_project,
            segment(TranscriptChannel::Me, 0, "Добрый день"),
        );
        project
    };
    let doomed = fill("Телемедиа");
    let kept = fill("Лапа");
    // A recording of nothing outlives every delete.
    let loose = fx.recording(RecordingLinks::default());
    fx.live(&loose, segment(TranscriptChannel::Me, 0, "Проверка"));
    // (table, rows before, rows after)
    let rows = [
        ("projects", 2, 1),
        ("people", 2, 1),
        ("calls", 2, 1),
        ("call_participants", 2, 1),
        ("topics", 2, 1),
        ("task_cards", 2, 1),
        ("questions", 2, 1),
        ("recordings", 5, 3),
        ("transcript_segments", 5, 3),
    ];
    for (table, before, _) in rows {
        assert_eq!(fx.count(table), before, "{table} before");
    }
    let before = fx.sink.events().len();
    let id = kept.id.clone();
    let kept = fx.read(move |db| projects::get(db, &id)).unwrap();
    assert_eq!(kept.open_questions, 1);

    let id = doomed.id.clone();
    fx.write(move |db| projects::delete(db, &id)).unwrap();

    for (table, _, after) in rows {
        assert_eq!(fx.count(table), after, "{table} after");
    }
    assert_eq!(texts(&fx.transcript(&loose)), vec!["Проверка"]);
    let id = kept.id.clone();
    assert_eq!(fx.read(move |db| projects::get(db, &id)).unwrap(), kept);
    let events = fx.sink.events();
    assert_eq!(events.len(), before + 1, "one event for the cascade");
    assert_eq!(
        events.last().unwrap(),
        &DataChanged::new(
            Entity::Project,
            &doomed.id,
            Some(&doomed.id),
            Change::Deleted
        )
    );
    let fk_violations = fx
        .read(|db| {
            Ok(
                db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(fk_violations, 0);
}

#[test]
fn a_person_takes_part_in_two_calls_and_is_stored_once() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let olga = fx.person(&project, "Ольга Демченко");
    let first = fx.call(&project, &[&olga]);
    let second = fx.call(&project, &[]);
    let (call_id, person_id) = (second.id.clone(), olga.id.clone());
    let second = fx
        .write(move |db| calls::add_participant(db, &call_id, &person_id))
        .unwrap();

    assert_eq!(first.participant_ids, vec![olga.id.clone()]);
    assert_eq!(second.participant_ids, vec![olga.id.clone()]);
    for call in [&first, &second] {
        let id = call.id.clone();
        let participants = fx.read(move |db| calls::participants(db, &id)).unwrap();
        assert_eq!(participants, vec![olga.clone()]);
    }
    assert_eq!(fx.count("people"), 1);
    assert_eq!(
        fx.sink.events().last().unwrap(),
        &DataChanged::new(Entity::Call, &second.id, Some(&project.id), Change::Updated)
    );
}

#[test]
fn a_participant_from_another_project_is_invalid() {
    let fx = Fixture::new();
    let telemedia = fx.project("Телемедиа");
    let lapa = fx.project("Лапа");
    let marina = fx.person(&lapa, "Марина Котова");
    let call = fx.call(&telemedia, &[]);
    let before = fx.sink.events().len();

    let (call_id, person_id) = (call.id.clone(), marina.id.clone());
    let error = fx
        .write(move |db| calls::add_participant(db, &call_id, &person_id))
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(fx.count("call_participants"), 0);
    assert_eq!(fx.sink.events().len(), before, "no event on failure");
}

#[test]
fn a_failed_command_rolls_back_and_sends_no_event() {
    let fx = Fixture::new();
    let telemedia = fx.project("Телемедиа");
    let lapa = fx.project("Лапа");
    let marina = fx.person(&lapa, "Марина Котова");
    let before = fx.sink.events().len();

    // The call row is inserted before the foreign participant fails it.
    let input = CallCreate {
        project_id: telemedia.id.clone(),
        participant_ids: Some(vec![marina.id.clone()]),
        ..CallCreate::default()
    };
    let error = fx.write(move |db| calls::create(db, input)).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(fx.count("calls"), 0, "the transaction rolled back");
    assert_eq!(fx.sink.events().len(), before);
}

#[test]
fn transcript_reads_in_time_order_with_channels() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);
    let recording = fx.recording(RecordingLinks::call(&call.id));
    let before = fx.sink.events().len();

    let added = fx.live(&recording, segment(TranscriptChannel::Others, 3000, "три"));
    fx.live(&recording, segment(TranscriptChannel::Me, 1000, "один"));
    fx.live(&recording, segment(TranscriptChannel::Others, 2000, "два"));

    assert!(is_uuid_v7(&added.id));
    assert_eq!(added.recording_id, recording);
    assert_eq!(added.call_id.as_deref(), Some(call.id.as_str()));
    assert_eq!(added.pass, TranscriptPass::Live);
    let segments = fx.transcript(&recording);
    assert_eq!(segments[2], added);
    let read: Vec<_> = segments
        .iter()
        .map(|segment| (segment.text.as_str(), segment.channel))
        .collect();
    assert_eq!(
        read,
        vec![
            ("один", TranscriptChannel::Me),
            ("два", TranscriptChannel::Others),
            ("три", TranscriptChannel::Others)
        ]
    );
    let events = &fx.sink.events()[before..];
    assert_eq!(events.len(), 3, "one event per phrase");
    assert_eq!(
        events[0],
        DataChanged::new(
            Entity::Transcript,
            &recording,
            Some(&project.id),
            Change::Created
        )
    );
}

#[test]
fn the_refined_pass_replaces_the_live_one_on_read() {
    let fx = Fixture::new();
    let recording = fx.recording(RecordingLinks::default());
    fx.live(&recording, segment(TranscriptChannel::Me, 0, "живой один"));
    fx.live(
        &recording,
        segment(TranscriptChannel::Others, 900, "живой два"),
    );
    let before = fx.sink.events().len();

    // Nothing recognized: the live pass stays visible.
    assert!(fx.refined(&recording, Vec::new()).is_empty());
    assert_eq!(
        texts(&fx.transcript(&recording)),
        vec!["живой один", "живой два"]
    );

    let refined = fx.refined(
        &recording,
        vec![
            segment(TranscriptChannel::Others, 1000, "второй"),
            segment(TranscriptChannel::Me, 0, "первый"),
        ],
    );
    assert!(
        refined
            .iter()
            .all(|segment| segment.pass == TranscriptPass::Refined && segment.call_id.is_none())
    );
    assert_eq!(texts(&fx.transcript(&recording)), vec!["первый", "второй"]);

    // A rerun replaces the previous refined segments.
    fx.refined(
        &recording,
        vec![segment(TranscriptChannel::Me, 0, "заново")],
    );
    assert_eq!(texts(&fx.transcript(&recording)), vec!["заново"]);
    assert_eq!(fx.count("transcript_segments"), 3, "the live rows stay");

    let id = recording.clone();
    let state = fx
        .read(move |db| recordings::get(db, &id))
        .unwrap()
        .transcript_state;
    assert_eq!(state, recordings::TranscriptState::Refined);
    let events = &fx.sink.events()[before..];
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[2],
        DataChanged::new(Entity::Transcript, &recording, None, Change::Updated)
    );
}

#[test]
fn a_failed_refined_pass_changes_nothing() {
    let fx = Fixture::new();
    let recording = fx.recording(RecordingLinks::default());
    fx.refined(&recording, vec![segment(TranscriptChannel::Me, 0, "было")]);
    let before = fx.sink.events().len();

    let id = recording.clone();
    let error = fx
        .write(move |db| {
            transcript::replace_refined(
                db,
                &id,
                vec![
                    segment(TranscriptChannel::Me, 0, "хорошо"),
                    SegmentInput {
                        channel: TranscriptChannel::Me,
                        start_ms: 500,
                        end_ms: 100,
                        text: "назад".to_owned(),
                    },
                ],
            )
        })
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(texts(&fx.transcript(&recording)), vec!["было"]);
    assert_eq!(fx.sink.events().len(), before);

    // Outside a transaction it is atomic too.
    let id = recording.clone();
    fx.read(move |db| {
        let error = transcript::replace_refined(db, "nope", Vec::new()).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }));
        transcript::replace_refined(db, &id, vec![segment(TranscriptChannel::Me, 0, "стало")])?;
        Ok(())
    })
    .unwrap();
    assert_eq!(texts(&fx.transcript(&recording)), vec!["стало"]);
}

#[test]
fn a_call_reads_the_transcripts_of_its_recordings() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);
    let other = fx.call(&project, &[]);
    let first = fx.recording(RecordingLinks::call(&call.id));
    let second = fx.recording(RecordingLinks::call(&call.id));
    let elsewhere = fx.recording(RecordingLinks::call(&other.id));
    fx.live(&second, segment(TranscriptChannel::Me, 0, "вторая запись"));
    fx.live(&first, segment(TranscriptChannel::Me, 5000, "первая живая"));
    fx.live(
        &elsewhere,
        segment(TranscriptChannel::Me, 0, "другой звонок"),
    );
    fx.refined(
        &first,
        vec![segment(
            TranscriptChannel::Others,
            4000,
            "первая уточнённая",
        )],
    );

    let id = call.id.clone();
    let segments = fx.read(move |db| transcript::for_call(db, &id)).unwrap();
    assert_eq!(texts(&segments), vec!["первая уточнённая", "вторая запись"]);
    assert_eq!(segments[0].recording_id, first);
    assert_eq!(segments[1].pass, TranscriptPass::Live);
}

#[test]
fn transcripts_of_unknown_records_are_not_found() {
    let fx = Fixture::new();
    for error in [
        fx.read(|db| transcript::for_recording(db, "nope"))
            .unwrap_err(),
        fx.read(|db| transcript::for_call(db, "nope")).unwrap_err(),
        fx.write(|db| transcript::append_live(db, "nope", segment(TranscriptChannel::Me, 0, "x")))
            .unwrap_err(),
    ] {
        assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    }
    // A recording without segments has an empty transcript.
    let recording = fx.recording(RecordingLinks::default());
    assert!(fx.transcript(&recording).is_empty());
    assert!(fx.sink.events().is_empty());
}

#[test]
fn deleting_a_recording_deletes_its_segments() {
    let fx = Fixture::new();
    let doomed = fx.recording(RecordingLinks::default());
    let kept = fx.recording(RecordingLinks::default());
    fx.live(&doomed, segment(TranscriptChannel::Me, 0, "уйдёт"));
    fx.refined(&doomed, vec![segment(TranscriptChannel::Me, 0, "уйдёт")]);
    fx.live(&kept, segment(TranscriptChannel::Me, 0, "останется"));

    let id = doomed.clone();
    fx.write(move |db| Ok((recordings::delete(db, &id)?, Vec::new())))
        .unwrap();

    assert_eq!(fx.count("transcript_segments"), 1);
    assert_eq!(texts(&fx.transcript(&kept)), vec!["останется"]);
}

#[test]
fn a_channel_or_pass_outside_the_list_is_rejected() {
    let parsed: Result<SegmentInput, _> = serde_json::from_value(json!({
        "channel": "both", "startMs": 0, "endMs": 1, "text": "x"
    }));
    assert!(parsed.is_err(), "the command arguments don't deserialize");

    let fx = Fixture::new();
    let recording = fx.recording(RecordingLinks::default());
    for (channel, pass) in [("both", "live"), ("me", "draft")] {
        let id = recording.clone();
        let error = fx
            .write(move |db| {
                db.execute(
                    "INSERT INTO transcript_segments
                       (id, recording_id, pass, channel, start_ms, end_ms, text, created_at, updated_at)
                     VALUES ('x', ?1, ?2, ?3, 0, 1, 'x', 0, 0)",
                    [&id, pass, channel],
                )?;
                Ok(((), Vec::new()))
            })
            .unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    }
}

#[test]
fn segment_times_are_validated() {
    let fx = Fixture::new();
    let recording = fx.recording(RecordingLinks::default());
    let error = fx
        .write(move |db| {
            transcript::append_live(
                db,
                &recording,
                SegmentInput {
                    channel: TranscriptChannel::Me,
                    start_ms: 500,
                    end_ms: 100,
                    text: "назад".to_owned(),
                },
            )
        })
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }));
    assert_eq!(fx.count("transcript_segments"), 0);
}

#[test]
fn questions_link_only_to_topics_and_cards_of_their_call() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let first = fx.call(&project, &[]);
    let second = fx.call(&project, &[]);
    let call_id = second.id.clone();
    let foreign_topic = fx
        .write(move |db| {
            topics::create(
                db,
                TopicCreate {
                    call_id,
                    title: "Чужая тема".to_owned(),
                    position: None,
                },
            )
        })
        .unwrap();
    let input = QuestionCreate {
        call_id: first.id.clone(),
        text: "Вопрос".to_owned(),
        topic_id: Some(foreign_topic.id.clone()),
        ..QuestionCreate::default()
    };
    let error = fx
        .write(move |db| questions::create(db, input))
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");

    let input = QuestionCreate {
        call_id: first.id.clone(),
        text: "  ".to_owned(),
        ..QuestionCreate::default()
    };
    let error = fx
        .write(move |db| questions::create(db, input))
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "empty text");
}

#[test]
fn open_questions_are_counted_and_answering_updates_them() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);
    let input = QuestionCreate {
        call_id: call.id.clone(),
        text: "Кто старший смены?".to_owned(),
        ..QuestionCreate::default()
    };
    let question = fx.write(move |db| questions::create(db, input)).unwrap();
    let id = project.id.clone();
    assert_eq!(
        fx.read(move |db| projects::get(db, &id))
            .unwrap()
            .open_questions,
        1
    );

    let question_id = question.id.clone();
    let patch = QuestionUpdate {
        status: Some(QuestionStatus::Answered),
        ..QuestionUpdate::default()
    };
    let answered = fx
        .write(move |db| questions::update(db, &question_id, patch))
        .unwrap();
    assert_eq!(answered.status, QuestionStatus::Answered);
    assert_eq!(answered.created_at, question.created_at);
    assert!(answered.updated_at > question.updated_at);
    let id = call.id.clone();
    assert_eq!(
        fx.read(move |db| calls::get(db, &id))
            .unwrap()
            .open_questions,
        0
    );
}

#[test]
fn topics_order_and_cards_follow_their_topic() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);
    let topic = |title: &str| {
        let input = TopicCreate {
            call_id: call.id.clone(),
            title: title.to_owned(),
            position: None,
        };
        fx.write(move |db| topics::create(db, input)).unwrap()
    };
    let calls_topic = topic("Приём звонков");
    let crm_topic = topic("Интеграция с CRM");
    assert_eq!((calls_topic.position, crm_topic.position), (0, 1));

    let topic_id = crm_topic.id.clone();
    let card = fx
        .write(move |db| {
            task_cards::create(
                db,
                TaskCardCreate {
                    topic_id,
                    fields: Some(json!([{ "id": "goal", "facts": [] }])),
                    ..TaskCardCreate::default()
                },
            )
        })
        .unwrap();
    assert_eq!(card.call_id, call.id, "the card takes its topic's call");

    let input = QuestionCreate {
        call_id: call.id.clone(),
        text: "Что записывать в CRM?".to_owned(),
        topic_id: Some(crm_topic.id.clone()),
        card_id: Some(card.id.clone()),
        ..QuestionCreate::default()
    };
    let question = fx.write(move |db| questions::create(db, input)).unwrap();
    let topic_id = crm_topic.id.clone();
    fx.write(move |db| topics::delete(db, &topic_id)).unwrap();
    let question_id = question.id.clone();
    let orphan = fx.read(move |db| questions::get(db, &question_id)).unwrap();
    assert_eq!((orphan.topic_id, orphan.card_id), (None, None));
    assert_eq!(fx.count("task_cards"), 0);
}

#[test]
fn call_status_and_times() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);
    assert_eq!(call.status, CallStatus::Live);
    assert!(call.started_at.is_some());
    let id = call.id.clone();
    let patch = CallUpdate {
        status: Some(CallStatus::Finished),
        ended_at: Some(call.started_at.map(|start| start + 60_000)),
        summary: Some(Some(json!({ "summary": "ready" }))),
        ..CallUpdate::default()
    };
    let finished = fx.write(move |db| calls::update(db, &id, patch)).unwrap();
    assert_eq!(finished.status, CallStatus::Finished);
    assert_eq!(finished.summary, Some(json!({ "summary": "ready" })));

    let id = call.id.clone();
    let backwards = CallUpdate {
        ended_at: Some(Some(0)),
        ..CallUpdate::default()
    };
    let error = fx
        .write(move |db| calls::update(db, &id, backwards))
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }));
}

/// Patches as the frontend sends them: `null` clears a nullable field,
/// an absent key leaves it as it is.
fn patch<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> T {
    serde_json::from_value(value).unwrap()
}

#[test]
fn null_clears_nullable_fields_and_absent_keeps_them() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);

    // "Отменить завершение": endedAt back to null.
    let id = call.id.clone();
    let ended: CallUpdate = patch(json!({
        "endedAt": call.started_at.unwrap() + 1000,
        "summary": { "summary": "ready" }
    }));
    let ended = fx.write(move |db| calls::update(db, &id, ended)).unwrap();
    assert!(ended.ended_at.is_some());
    let id = call.id.clone();
    let title_only: CallUpdate = patch(json!({ "title": "Другое" }));
    let kept = fx
        .write(move |db| calls::update(db, &id, title_only))
        .unwrap();
    assert_eq!(kept.ended_at, ended.ended_at, "absent keeps endedAt");
    assert_eq!(kept.summary, ended.summary, "absent keeps the summary");
    let id = call.id.clone();
    let reopened: CallUpdate = patch(json!({ "endedAt": null, "summary": null }));
    let reopened = fx
        .write(move |db| calls::update(db, &id, reopened))
        .unwrap();
    assert_eq!(reopened.ended_at, None);
    assert_eq!(reopened.summary, None);
    assert!(reopened.started_at.is_some());

    // The brief of a project.
    let id = project.id.clone();
    let with_brief: ProjectUpdate = patch(json!({ "brief": { "goal": "запись к врачу" } }));
    let briefed = fx
        .write(move |db| projects::update(db, &id, with_brief))
        .unwrap();
    assert!(briefed.brief.is_some());
    let id = project.id.clone();
    let renamed: ProjectUpdate = patch(json!({ "name": "Телемедиа Плюс" }));
    let renamed = fx
        .write(move |db| projects::update(db, &id, renamed))
        .unwrap();
    assert_eq!(renamed.brief, briefed.brief);
    let id = project.id.clone();
    let cleared: ProjectUpdate = patch(json!({ "brief": null }));
    let cleared = fx
        .write(move |db| projects::update(db, &id, cleared))
        .unwrap();
    assert_eq!(cleared.brief, None);

    // A question detached from its topic and card.
    let topic_input = TopicCreate {
        call_id: call.id.clone(),
        title: "Запись".to_owned(),
        ..TopicCreate::default()
    };
    let topic = fx.write(move |db| topics::create(db, topic_input)).unwrap();
    let card_input = TaskCardCreate {
        topic_id: topic.id.clone(),
        ..TaskCardCreate::default()
    };
    let card = fx
        .write(move |db| task_cards::create(db, card_input))
        .unwrap();
    let question_input = QuestionCreate {
        call_id: call.id.clone(),
        text: "Кто подтверждает запись?".to_owned(),
        topic_id: Some(topic.id.clone()),
        card_id: Some(card.id.clone()),
        ..QuestionCreate::default()
    };
    let question = fx
        .write(move |db| questions::create(db, question_input))
        .unwrap();
    let id = question.id.clone();
    let reworded: QuestionUpdate = patch(json!({ "text": "Кто подтверждает?" }));
    let reworded = fx
        .write(move |db| questions::update(db, &id, reworded))
        .unwrap();
    assert_eq!(reworded.topic_id.as_ref(), Some(&topic.id));
    assert_eq!(reworded.card_id.as_ref(), Some(&card.id));
    let id = question.id.clone();
    let detached: QuestionUpdate = patch(json!({ "topicId": null, "cardId": null }));
    let detached = fx
        .write(move |db| questions::update(db, &id, detached))
        .unwrap();
    assert_eq!((detached.topic_id, detached.card_id), (None, None));
}

#[test]
fn summary_patches_merge_inside_the_transaction() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);

    // Two windows patch different keys from the same stale copy.
    for summary_patch in [
        json!({ "participants": "Ольга, Игорь", "summary": "processing" }),
        json!({ "summary": "processing" }),
        json!({ "proposals": { "p1": { "decision": "accepted" } } }),
        json!({ "proposals": { "p2": { "decision": "rejected", "text": "нет" } } }),
        json!({ "tasks": { "c1": { "decision": "pending", "sync": { "github": { "status": "sending" } } } } }),
        json!({ "tasks": { "c1": { "sync": { "github": { "ref": "#48", "status": "sent" } } } } }),
        json!({ "summary": "ready", "proposals": { "p2": { "text": null } } }),
    ] {
        let id = call.id.clone();
        fx.write(move |db| calls::patch_summary(db, &id, &summary_patch))
            .unwrap();
    }
    let id = call.id.clone();
    let stored = fx.read(move |db| calls::get(db, &id)).unwrap();
    assert_eq!(
        stored.summary,
        Some(json!({
            "participants": "Ольга, Игорь",
            "summary": "ready",
            "proposals": {
                "p1": { "decision": "accepted" },
                "p2": { "decision": "rejected" }
            },
            "tasks": {
                "c1": { "decision": "pending", "sync": { "github": { "ref": "#48", "status": "sent" } } }
            }
        }))
    );
    assert!(stored.updated_at > call.updated_at);
    let last = fx.sink.events().last().cloned().unwrap();
    assert_eq!(
        last,
        DataChanged::new(Entity::Call, &call.id, Some(&project.id), Change::Updated)
    );

    // A `null` patch clears it; a missing call is NotFound and sends nothing.
    let id = call.id.clone();
    let cleared = fx
        .write(move |db| calls::patch_summary(db, &id, &serde_json::Value::Null))
        .unwrap();
    assert_eq!(cleared.summary, None);
    let events = fx.sink.events().len();
    let error = fx
        .write(|db| calls::patch_summary(db, "missing", &json!({ "a": 1 })))
        .unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }));
    assert_eq!(fx.sink.events().len(), events);
}

#[test]
fn a_shortcuts_patch_changes_only_the_actions_it_names() {
    let stored = settings::defaults();
    let patch = SettingsMap::from([(
        settings::SHORTCUTS.to_owned(),
        json!({ "mark-asked": ["⌃", "M"] }),
    )]);
    let merged = settings::merge_shortcuts(&stored, patch);
    let shortcuts = settings::shortcuts(&merged);
    assert_eq!(shortcuts["mark-asked"], vec!["⌃", "M"]);
    assert_eq!(shortcuts["toggle-call"], vec!["⌥", "⌘", "G"]);
    assert_eq!(shortcuts.len(), settings::shortcuts(&stored).len());

    let other = SettingsMap::from([("theme".to_owned(), json!("dark"))]);
    assert_eq!(settings::merge_shortcuts(&stored, other.clone()), other);
}

#[test]
fn settings_merge_over_defaults_and_validate_types() {
    let fx = Fixture::new();
    let defaults = fx.read(settings::get).unwrap();
    assert_eq!(defaults[settings::ONBOARDING_COMPLETED], json!(false));
    assert_eq!(defaults[settings::HIDE_ON_SHARE], json!(true));
    assert_eq!(
        settings::shortcuts(&defaults)["toggle-call"],
        vec!["⌥", "⌘", "G"]
    );

    let patch = SettingsMap::from([
        ("theme".to_owned(), json!("dark")),
        (settings::HIDE_ON_SHARE.to_owned(), json!(false)),
    ]);
    fx.write(move |db| Ok(((), settings::put(db, &patch)?)))
        .unwrap();
    let stored = fx.read(settings::get).unwrap();
    assert_eq!(stored["theme"], json!("dark"));
    assert_eq!(stored[settings::HIDE_ON_SHARE], json!(false));
    assert_eq!(
        stored[settings::LAUNCH_AT_LOGIN],
        json!(true),
        "default kept"
    );
    assert_eq!(
        fx.sink.events(),
        vec![DataChanged::new(
            Entity::Settings,
            settings::SETTINGS_ID,
            None,
            Change::Updated
        )]
    );

    let bad = SettingsMap::from([(settings::LAUNCH_AT_LOGIN.to_owned(), json!("yes"))]);
    let error = fx
        .write(move |db| Ok(((), settings::put(db, &bad)?)))
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }));
    let bad = SettingsMap::from([(settings::SHORTCUTS.to_owned(), json!({ "x": "⌘G" }))]);
    assert!(settings::validate(&bad).is_err());
}

#[test]
fn mic_busy_behavior_is_widget_record_or_nothing() {
    let fx = Fixture::new();
    let stored = fx.read(settings::get).unwrap();
    assert_eq!(stored[settings::MIC_BUSY_BEHAVIOR], json!("widget"));
    assert_eq!(
        settings::mic_busy_behavior(&SettingsMap::new()),
        settings::MicBusyBehavior::Widget,
        "a missing key is widget"
    );

    for (value, expected) in [
        ("widget", settings::MicBusyBehavior::Widget),
        ("record", settings::MicBusyBehavior::Record),
        ("nothing", settings::MicBusyBehavior::Nothing),
    ] {
        let patch = SettingsMap::from([(settings::MIC_BUSY_BEHAVIOR.to_owned(), json!(value))]);
        fx.write(move |db| Ok(((), settings::put(db, &patch)?)))
            .unwrap();
        let stored = fx.read(settings::get).unwrap();
        assert_eq!(settings::mic_busy_behavior(&stored), expected);
    }

    for bad in [json!("popup"), json!(""), json!(true), json!(null)] {
        let patch = SettingsMap::from([(settings::MIC_BUSY_BEHAVIOR.to_owned(), bad.clone())]);
        let error = fx
            .write(move |db| Ok(((), settings::put(db, &patch)?)))
            .unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{bad}");
    }
    let stored = fx.read(settings::get).unwrap();
    assert_eq!(
        stored[settings::MIC_BUSY_BEHAVIOR],
        json!("nothing"),
        "kept"
    );
}

#[test]
fn speech_model_is_turbo_or_small_and_legacy_values_read_as_turbo() {
    use crate::speech::models::ModelId;

    let fx = Fixture::new();
    let stored = fx.read(settings::get).unwrap();
    assert_eq!(stored[settings::SPEECH_MODEL], json!("turbo"), "default");
    assert_eq!(settings::speech_model(&SettingsMap::new()), ModelId::Turbo);

    let patch = SettingsMap::from([(settings::SPEECH_MODEL.to_owned(), json!("small"))]);
    fx.write(move |db| Ok(((), settings::put(db, &patch)?)))
        .unwrap();
    let stored = fx.read(settings::get).unwrap();
    assert_eq!(stored[settings::SPEECH_MODEL], json!("small"));
    assert_eq!(settings::speech_model(&stored), ModelId::Small);

    for bad in [
        json!("whisper"),
        json!("gigaam"),
        json!(""),
        json!(1),
        json!(null),
    ] {
        let patch = SettingsMap::from([(settings::SPEECH_MODEL.to_owned(), bad.clone())]);
        assert!(
            matches!(
                settings::validate(&patch),
                Err(CommandError::Invalid { .. })
            ),
            "{bad}"
        );
    }

    // Values of earlier builds, written before the key was validated.
    for legacy in ["whisper", "gigaam"] {
        fx.read(move |db| {
            db.execute(
                "INSERT INTO settings (key, value) VALUES ('speechModel', ?1)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [json!(legacy).to_string()],
            )?;
            Ok(())
        })
        .unwrap();
        let stored = fx.read(settings::get).unwrap();
        assert_eq!(stored[settings::SPEECH_MODEL], json!("turbo"), "{legacy}");
        assert_eq!(settings::speech_model(&stored), ModelId::Turbo);
    }
}

#[test]
fn speech_benchmark_is_stored_as_given() {
    let fx = Fixture::new();
    let benchmark = json!({
        "turbo": { "passed": true, "p95Ms": 1300, "rtf": 0.2, "wer": 0.04 }
    });
    let patch = SettingsMap::from([(settings::SPEECH_BENCHMARK.to_owned(), benchmark.clone())]);
    fx.write(move |db| Ok(((), settings::put(db, &patch)?)))
        .unwrap();
    let stored = fx.read(settings::get).unwrap();
    assert_eq!(stored[settings::SPEECH_BENCHMARK], benchmark);
}

#[test]
fn agent_path_is_only_a_path_to_the_cli() {
    let good = if cfg!(windows) {
        [
            json!(null),
            json!(r"C:\Users\me\.local\bin\claude.exe"),
            json!(r"C:\Users\me\AppData\Roaming\npm\claude.cmd"),
        ]
    } else {
        [
            json!(null),
            json!("/Users/me/.local/bin/claude"),
            json!("/Users/me/.nvm/versions/node/v20.11.1/bin/claude"),
        ]
    };
    for good in good {
        let patch = SettingsMap::from([(settings::AGENT_PATH.to_owned(), good.clone())]);
        assert!(settings::validate(&patch).is_ok(), "{good}");
    }
    for bad in [
        json!(""),
        json!("/bin/sh"),
        json!("/tmp/claude-evil"),
        json!(42),
    ] {
        let patch = SettingsMap::from([(settings::AGENT_PATH.to_owned(), bad.clone())]);
        assert!(
            matches!(
                settings::validate(&patch),
                Err(CommandError::Invalid { .. })
            ),
            "{bad}"
        );
    }
}

#[test]
fn storage_failure_answers_storage_errors() {
    let storage = Storage::unavailable("База от более новой версии");
    let sink = RecordingSink::default();
    let error = block_on(storage.read(projects::list)).unwrap_err();
    assert_eq!(error, CommandError::storage("База от более новой версии"));
    let error = block_on(storage.write(&sink, |db| {
        projects::create(
            db,
            ProjectCreate {
                name: "x".to_owned(),
                ..ProjectCreate::default()
            },
        )
    }))
    .unwrap_err();
    assert!(matches!(error, CommandError::Storage { .. }));
    assert!(sink.events().is_empty());
}

#[test]
fn command_errors_serialize_with_a_kind() {
    assert_eq!(
        serde_json::to_value(CommandError::not_found("Проект не найден")).unwrap(),
        json!({ "kind": "NotFound", "message": "Проект не найден" })
    );
    assert_eq!(
        serde_json::to_value(CommandError::invalid("x")).unwrap(),
        json!({ "kind": "Invalid", "message": "x" })
    );
    assert_eq!(
        serde_json::to_value(CommandError::storage("x")).unwrap(),
        json!({ "kind": "Storage", "message": "x" })
    );
    assert_eq!(
        serde_json::to_value(CommandError::external("x")).unwrap(),
        json!({ "kind": "External", "message": "x" })
    );
    assert_eq!(
        serde_json::to_value(CommandError::capture(
            crate::error::CaptureFailure::NoDevice,
            "Нет микрофона"
        ))
        .unwrap(),
        json!({ "kind": "External", "message": "Нет микрофона", "reason": "noDevice" })
    );
}

#[test]
fn data_changed_serializes_in_camel_case() {
    let event = DataChanged::new(Entity::TaskCard, "card", Some("project"), Change::Deleted);
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({ "entity": "taskCard", "id": "card", "projectId": "project", "change": "deleted" })
    );
}

/// Capabilities (design.md, decision 7) as Tauri enforces them: the real
/// config and `capabilities/*.json` on the mock runtime.
mod acl {
    use tauri::{
        WebviewUrl, WebviewWindowBuilder,
        ipc::{CallbackFn, InvokeBody},
        test::{INVOKE_KEY, get_ipc_response, mock_builder},
        webview::InvokeRequest,
    };

    fn invoke(label: &str, command: &str) -> Result<(), String> {
        let app = mock_builder()
            .build(tauri::generate_context!(test = true))
            .expect("failed to build the mock app");
        // Config windows are created once the event loop runs; the mock app
        // never runs it, so the window is built here with the same label.
        let webview = WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
            .build()
            .unwrap();
        let request = InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(serde_json::json!({ "id": "x" })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(&webview, request)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn denied(result: &Result<(), String>) -> bool {
        result
            .as_ref()
            .is_err_and(|error| error.contains("not allowed"))
    }

    #[test]
    fn floating_windows_cannot_delete_projects_or_change_settings() {
        for label in ["overlay", "widget"] {
            for command in ["projects_delete", "projects_update", "settings_update"] {
                let result = invoke(label, command);
                assert!(denied(&result), "{label} → {command}: {result:?}");
            }
        }
    }

    /// OS permissions, the agent CLI and the meters are for the main and
    /// onboarding windows only.
    #[test]
    fn floating_windows_cannot_touch_permissions_agent_or_audio() {
        for label in ["overlay", "widget"] {
            for command in [
                "permissions_get",
                "permission_request",
                "agent_install",
                "agent_login_submit",
                "audio_level_start",
            ] {
                let result = invoke(label, command);
                assert!(denied(&result), "{label} → {command}: {result:?}");
            }
        }
    }

    const SPEECH_MODEL_COMMANDS: [&str; 9] = [
        "speech_models_list",
        "speech_model_download",
        "speech_model_pause",
        "speech_model_cancel",
        "speech_model_remove",
        "speech_model_select",
        "speech_benchmark",
        "speech_benchmark_cancel",
        "speech_mic_check",
    ];

    /// The speech models, the hardware check and the mic check are for the
    /// main and onboarding windows only.
    #[test]
    fn speech_models_are_for_main_and_onboarding_only() {
        for command in SPEECH_MODEL_COMMANDS {
            for label in ["overlay", "widget"] {
                let result = invoke(label, command);
                assert!(denied(&result), "{label} → {command}: {result:?}");
            }
            for label in ["main", "onboarding"] {
                let result = invoke(label, command);
                assert!(!denied(&result), "{label} → {command}: {result:?}");
            }
        }
    }

    #[test]
    fn allowed_commands_pass_the_acl() {
        // The mock app has no command handlers: an allowed command gets past
        // the ACL and then fails as unknown, not as "not allowed".
        for (label, command) in [
            ("main", "projects_delete"),
            ("onboarding", "settings_update"),
            ("overlay", "projects_list"),
            ("widget", "calls_create"),
            ("onboarding", "permissions_get"),
            ("onboarding", "agent_login_start"),
            ("onboarding", "audio_level_start"),
            ("main", "agent_status"),
            ("main", "mic_activity_get"),
            ("widget", "mic_activity_get"),
            ("overlay", "mic_activity_get"),
            // Every window can show the transcript of a recording.
            ("main", "transcript_for_recording"),
            ("widget", "transcript_for_recording"),
            ("overlay", "transcript_for_recording"),
            ("main", "transcript_state"),
            // The widget starts a recording, the overlay stops it, every
            // window shows it.
            ("main", "recording_start"),
            ("main", "recording_stop"),
            ("main", "recording_status"),
            ("widget", "recording_start"),
            ("widget", "recording_stop"),
            ("widget", "recording_status"),
            ("overlay", "recording_start"),
            ("overlay", "recording_stop"),
            ("overlay", "recording_status"),
        ] {
            let result = invoke(label, command);
            assert!(!denied(&result), "{label} → {command}: {result:?}");
        }
    }
}

/// Every permission in the capability files is a real command, the main
/// window gets every command, the floating windows only what a call needs.
#[test]
fn capabilities_match_the_command_list() {
    mod manifest {
        include!("../command_names.rs");
    }
    let read = |name: &str| -> Vec<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("capabilities")
            .join(format!("{name}.json"));
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|permission| permission.as_str())
            .filter_map(|permission| permission.strip_prefix("allow-"))
            .map(|command| command.replace('-', "_"))
            .collect()
    };
    let all: Vec<String> = manifest::APP_COMMANDS
        .iter()
        .map(|command| (*command).to_owned())
        .collect();
    let mut main = read("main");
    main.sort();
    let mut expected = all.clone();
    expected.sort();
    assert_eq!(main, expected, "main and onboarding get every command");

    let floating = read("floating");
    for command in &floating {
        assert!(all.contains(command), "unknown command {command}");
    }
    for needed in [
        "transcript_for_recording",
        "mic_activity_get",
        "recording_start",
        "recording_stop",
        "recording_status",
    ] {
        assert!(
            floating.iter().any(|command| command == needed),
            "floating windows need {needed}"
        );
    }
    for forbidden in [
        "projects_create",
        "projects_update",
        "projects_delete",
        "people_create",
        "people_update",
        "people_delete",
        "calls_delete",
        "settings_update",
        "onboarding_complete",
        "permissions_get",
        "permission_request",
        "permission_open_settings",
        "agent_status",
        "agent_install",
        "agent_install_cancel",
        "agent_login_start",
        "agent_login_submit",
        "agent_login_cancel",
        "audio_level_start",
        "audio_level_stop",
        "app_restart",
        "speech_models_list",
        "speech_model_download",
        "speech_model_pause",
        "speech_model_cancel",
        "speech_model_remove",
        "speech_model_select",
        "speech_benchmark",
        "speech_benchmark_cancel",
        "speech_mic_check",
    ] {
        assert!(
            !floating.iter().any(|command| command == forbidden),
            "floating windows must not get {forbidden}"
        );
    }
}
