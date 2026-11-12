//! Scenarios of `specs/local-storage` against an in-memory database, through
//! the same `Storage::read` / `Storage::write` the commands use.

use serde_json::json;

use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity, testing::RecordingSink},
    storage::{
        Storage,
        call_state::{
            self, CardLens, Evidence, EvidenceSource, GapType, NewQuestion, QuestionStatus,
            ValidatedOp, ValidatedPatch,
        },
        calls::{self, Call, CallCreate, CallStatus, CallUpdate},
        people::{self, Person, PersonCreate},
        projects::{self, Project, ProjectCreate, ProjectUpdate},
        recordings::{self, RecordingFiles, RecordingLinks},
        settings::{self, SettingsMap},
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
            project_id: Some(project.id.clone()),
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

    /// A topic, its card field and an open question on the recording, as
    /// the fast loop applies them. Returns the question id.
    fn question(&self, recording_id: &str, text: &str) -> String {
        let id = recording_id.to_owned();
        let evidence = vec![Evidence {
            source: EvidenceSource::Project,
            id: "P1".to_owned(),
            quote: "приём звонков".to_owned(),
        }];
        let patch = ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Очередь".to_owned(),
                },
                ValidatedOp::SetCardField {
                    field: CardLens::Goal,
                    value: "Не терять звонки".to_owned(),
                    evidence: evidence.clone(),
                },
                ValidatedOp::AddQuestion(NewQuestion {
                    text: text.to_owned(),
                    description: String::new(),
                    card_field: CardLens::Goal,
                    gap_type: GapType::Empty,
                    priority: 2,
                    evidence,
                }),
            ],
        };
        let applied = self
            .write(move |db| Ok((call_state::apply_patch(db, &id, &patch)?, Vec::new())))
            .unwrap();
        applied.question_ids[0].clone()
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
        let of_call = fx.recording(RecordingLinks::call(&call.id));
        fx.live(&of_call, segment(TranscriptChannel::Others, 0, "Алло"));
        fx.question(&of_call, "Что слышит клиент, когда все заняты?");
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
        project_id: Some(telemedia.id.clone()),
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

/// The open questions of a call's recordings are counted on the call and
/// its project; answering one updates the counts.
#[test]
fn open_questions_are_counted_and_answering_updates_them() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let call = fx.call(&project, &[]);
    let recording = fx.recording(RecordingLinks::call(&call.id));
    let question_id = fx.question(&recording, "Кто старший смены?");
    // A recording without a call counts nowhere.
    let loose = fx.recording(RecordingLinks {
        project_id: Some(project.id.clone()),
        ..RecordingLinks::default()
    });
    fx.question(&loose, "Сколько операторов?");
    let id = project.id.clone();
    assert_eq!(
        fx.read(move |db| projects::get(db, &id))
            .unwrap()
            .open_questions,
        1
    );

    let id = recording.clone();
    let answered = ValidatedPatch {
        ops: vec![ValidatedOp::MarkAnswered {
            question_id: question_id.clone(),
            evidence: vec![Evidence {
                source: EvidenceSource::Project,
                id: "P1".to_owned(),
                quote: "старший".to_owned(),
            }],
        }],
    };
    fx.write(move |db| Ok((call_state::apply_patch(db, &id, &answered)?, Vec::new())))
        .unwrap();
    let id = recording.clone();
    let state = fx.read(move |db| call_state::get(db, &id)).unwrap();
    assert_eq!(state.questions[0].status, QuestionStatus::Answered);
    let id = call.id.clone();
    assert_eq!(
        fx.read(move |db| calls::get(db, &id))
            .unwrap()
            .open_questions,
        0
    );
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
            for command in [
                "projects_delete",
                "projects_update",
                "settings_update",
                "project_sources_add",
                "project_sources_list",
                "project_sources_remove",
                "brief_build",
                "brief_cancel",
                "brief_export",
            ] {
                let result = invoke(label, command);
                assert!(denied(&result), "{label} → {command}: {result:?}");
            }
        }
    }

    /// Only the main window discards a call ("Удалить все данные").
    #[test]
    fn floating_windows_cannot_discard_the_call() {
        for label in ["overlay", "widget"] {
            let result = invoke(label, "call_discard");
            assert!(denied(&result), "{label} → call_discard: {result:?}");
        }
    }

    /// The summary build closes a finishing call (`CallManager::close`):
    /// no window may, or it could close one whose build still runs.
    #[test]
    fn no_window_closes_a_finishing_call() {
        for label in ["main", "onboarding", "overlay", "widget"] {
            let result = invoke(label, "call_close");
            assert!(denied(&result), "{label} → call_close: {result:?}");
        }
    }

    /// The summary is built again and stopped from the main window; every
    /// window reads it and its progress ("Собираю итоги" in the call window).
    #[test]
    fn floating_windows_only_read_the_summary() {
        for label in ["overlay", "widget", "onboarding"] {
            assert!(!denied(&invoke(label, "summary_get")), "{label}");
            for command in ["summary_build", "summary_cancel"] {
                let result = invoke(label, command);
                assert!(denied(&result), "{label} → {command}: {result:?}");
            }
        }
    }

    /// The call starts and stops its recording (`CallManager`): no window
    /// may, or a call could go on without one.
    #[test]
    fn no_window_starts_or_stops_a_recording() {
        for label in ["main", "onboarding", "overlay", "widget"] {
            for command in ["recording_start", "recording_stop"] {
                let result = invoke(label, command);
                assert!(denied(&result), "{label} → {command}: {result:?}");
            }
        }
    }

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

    /// A finished call's records (post-call tasks 3.1–3.4) are reviewed,
    /// changed and read in the main window only (`post-call.json`), not in
    /// onboarding.
    const RECORDS_COMMANDS: [&str; 14] = [
        "summary_build",
        "summary_cancel",
        "calls_overview",
        "proposals_list",
        "proposals_for_person",
        "proposal_decide",
        "proposal_undo",
        "call_cards",
        "call_card_update",
        "call_transcript",
        "call_questions",
        "calls_search",
        "recording_peaks",
        "call_audio_delete",
    ];

    #[test]
    fn call_records_are_for_the_main_window_only() {
        for command in RECORDS_COMMANDS {
            for label in ["overlay", "widget", "onboarding"] {
                let result = invoke(label, command);
                assert!(denied(&result), "{label} → {command}: {result:?}");
            }
            let result = invoke("main", command);
            assert!(!denied(&result), "main → {command}: {result:?}");
        }
    }

    const CONNECTOR_COMMANDS: [&str; 7] = [
        "connectors_list",
        "connector_connect_api_key",
        "connector_disconnect",
        "connector_browse",
        "connector_selection_get",
        "connector_selection_set",
        "connector_sync",
    ];

    /// The connectors are set up in onboarding and the settings and picked
    /// in the main window (connectors-outline task 3.4); the floating
    /// windows never reach them (the widget's `brief_prepare` syncs inside
    /// Rust).
    #[test]
    fn connectors_are_for_main_and_onboarding_only() {
        for command in CONNECTOR_COMMANDS {
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
            // Every window shows the recording.
            ("main", "recording_status"),
            ("widget", "recording_status"),
            ("overlay", "recording_status"),
            // Every window reads, starts, finishes and resumes the call in
            // progress and stops its countdown; the main window discards it
            // before a delete.
            ("main", "call_current"),
            ("main", "call_start"),
            ("main", "call_finish"),
            ("main", "call_resume"),
            ("main", "call_keep"),
            ("main", "call_discard"),
            ("widget", "call_current"),
            ("widget", "call_start"),
            ("overlay", "call_current"),
            ("overlay", "call_finish"),
            ("overlay", "call_resume"),
            ("overlay", "call_keep"),
            ("main", "summary_get"),
            ("main", "summary_build"),
            ("main", "summary_cancel"),
            ("overlay", "summary_get"),
            ("widget", "summary_get"),
            // Every window shows the call's questions, acts on them and
            // retries the agent.
            ("main", "call_state_get"),
            ("main", "questions_act"),
            ("main", "agent_retry"),
            ("widget", "call_state_get"),
            ("overlay", "call_state_get"),
            ("overlay", "questions_act"),
            ("overlay", "agent_retry"),
            // Every window that shows the call hides a finding of the
            // column «Контекст» (agent-slow-loop task 1.3).
            ("main", "context_finding_hide"),
            ("onboarding", "context_finding_hide"),
            ("widget", "context_finding_hide"),
            ("overlay", "context_finding_hide"),
            // The home screen and the start widget read the overview; only
            // the main window manages documents.
            ("main", "projects_overview"),
            ("widget", "projects_overview"),
            ("overlay", "projects_overview"),
            ("main", "project_sources_add"),
            ("main", "project_sources_list"),
            ("main", "project_sources_remove"),
            // The brief is built, stopped and exported from the main window;
            // the start widget refreshes it before a call.
            ("main", "brief_build"),
            ("main", "brief_cancel"),
            ("main", "brief_prepare"),
            ("main", "brief_export"),
            ("widget", "brief_prepare"),
        ] {
            let result = invoke(label, command);
            assert!(!denied(&result), "{label} → {command}: {result:?}");
        }
    }
}

/// Every permission in the capability files is a real command, the main
/// window gets every command but the recorder's start and stop (the call
/// runs them), the floating windows only what a call needs.
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
    // The call starts and stops its recording, and its summary build closes
    // it: no window may.
    let no_window = ["recording_start", "recording_stop", "call_close"];
    let main_and_onboarding = read("main");
    let post_call = read("post-call");
    for command in &post_call {
        assert!(
            !main_and_onboarding.contains(command),
            "{command} is the main window's only, not onboarding's"
        );
    }
    let mut main: Vec<String> = main_and_onboarding.into_iter().chain(post_call).collect();
    main.sort();
    let mut expected: Vec<String> = all
        .iter()
        .filter(|command| !no_window.contains(&command.as_str()))
        .cloned()
        .collect();
    expected.sort();
    assert_eq!(
        main, expected,
        "the main window gets every command a window may call"
    );

    let floating = read("floating");
    for command in &floating {
        assert!(all.contains(command), "unknown command {command}");
    }
    for needed in [
        "call_current",
        "call_start",
        "call_finish",
        "call_resume",
        "call_keep",
        "call_state_get",
        "questions_act",
        "context_finding_hide",
        "agent_retry",
        "transcript_for_recording",
        "mic_activity_get",
        "recording_status",
        "projects_get",
        "projects_overview",
        "brief_prepare",
        "summary_get",
    ] {
        assert!(
            floating.iter().any(|command| command == needed),
            "floating windows need {needed}"
        );
    }
    for forbidden in [
        "call_close",
        "call_discard",
        "summary_build",
        "summary_cancel",
        "recording_start",
        "recording_stop",
        "brief_build",
        "brief_cancel",
        "brief_export",
        "project_sources_add",
        "project_sources_list",
        "project_sources_remove",
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
        "proposals_list",
        "proposals_for_person",
        "proposal_decide",
        "proposal_undo",
        "call_cards",
        "call_card_update",
        "call_transcript",
        "call_questions",
        "calls_search",
        "recording_peaks",
        "call_audio_delete",
    ] {
        assert!(
            !floating.iter().any(|command| command == forbidden),
            "floating windows must not get {forbidden}"
        );
    }
}

/* projects-people-brief task 1.4: notes, brief state, overview */

mod brief_state {
    use super::*;
    use crate::{
        projects::{brief_inputs, builds::BriefBuilds},
        storage::{
            people::PersonUpdate,
            projects::{BriefState, ProjectOverview},
        },
    };

    fn state(fx: &Fixture, project: &Project) -> BriefState {
        get(fx, project).brief_state
    }

    fn get(fx: &Fixture, project: &Project) -> Project {
        let id = project.id.clone();
        fx.read(move |db| projects::get(db, &id)).unwrap()
    }

    fn update(fx: &Fixture, project: &Project, patch: ProjectUpdate) -> Project {
        let id = project.id.clone();
        fx.write(move |db| projects::update(db, &id, patch))
            .unwrap()
    }

    /// Saves a brief as the build will: the fingerprint read before it.
    fn build(fx: &Fixture, project: &Project, truncated: bool) -> Project {
        let id = project.id.clone();
        fx.write(move |db| {
            let inputs = brief_inputs::read(db, &id)?;
            projects::save_brief(
                db,
                &id,
                &json!({ "product": "Колл-центр", "glossary": [], "stack": [] }),
                &inputs.fingerprint,
                truncated,
            )
        })
        .unwrap()
    }

    #[test]
    fn notes_are_created_updated_and_trimmed() {
        let fx = Fixture::new();
        let input = ProjectCreate {
            name: "Телемедиа".to_owned(),
            notes: Some("  Клиент торопится  ".to_owned()),
            ..ProjectCreate::default()
        };
        let project = fx.write(move |db| projects::create(db, input)).unwrap();
        assert_eq!(project.notes, "Клиент торопится");
        assert_eq!(project.brief_state, BriefState::None);
        assert_eq!(project.brief_built_at, None);

        let renamed = update(
            &fx,
            &project,
            ProjectUpdate {
                name: Some("Телемедиа 2".to_owned()),
                ..ProjectUpdate::default()
            },
        );
        assert_eq!(renamed.notes, "Клиент торопится", "absent keeps the notes");
        let cleared = update(
            &fx,
            &project,
            ProjectUpdate {
                notes: Some(String::new()),
                ..ProjectUpdate::default()
            },
        );
        assert_eq!(cleared.notes, "");
        let json = serde_json::to_value(&cleared).unwrap();
        assert_eq!(json["notes"], "");
        assert_eq!(json["briefState"], "none");
        assert_eq!(json["briefBuiltAt"], serde_json::Value::Null);
        assert_eq!(json["briefTruncated"], false);
    }

    /// They go whole into every brief build: past the limit nothing is
    /// written and the screen gets why.
    #[test]
    fn notes_and_description_have_a_limit() {
        use crate::storage::projects::{MAX_DESCRIPTION_CHARS, MAX_NOTES_CHARS};

        let fx = Fixture::new();
        let too_long = |create: ProjectCreate| {
            fx.write(move |db| projects::create(db, create))
                .unwrap_err()
        };
        let error = too_long(ProjectCreate {
            name: "Телемедиа".to_owned(),
            notes: Some("я".repeat(MAX_NOTES_CHARS + 1)),
            ..ProjectCreate::default()
        });
        assert_eq!(
            error,
            CommandError::invalid("Заметки длиннее 50 000 символов")
        );
        let error = too_long(ProjectCreate {
            name: "Телемедиа".to_owned(),
            description: Some("я".repeat(MAX_DESCRIPTION_CHARS + 1)),
            ..ProjectCreate::default()
        });
        assert_eq!(
            error,
            CommandError::invalid("Описание длиннее 5 000 символов")
        );

        // At the limit, spaces around not counted.
        let project = fx.project("Телемедиа");
        let full = update(
            &fx,
            &project,
            ProjectUpdate {
                notes: Some(format!("  {}  ", "я".repeat(MAX_NOTES_CHARS))),
                description: Some("д".repeat(MAX_DESCRIPTION_CHARS)),
                ..ProjectUpdate::default()
            },
        );
        assert_eq!(full.notes.chars().count(), MAX_NOTES_CHARS);
        let id = project.id.clone();
        let error = fx
            .write(move |db| {
                projects::update(
                    db,
                    &id,
                    ProjectUpdate {
                        name: Some("Другое".to_owned()),
                        notes: Some("я".repeat(MAX_NOTES_CHARS + 1)),
                        ..ProjectUpdate::default()
                    },
                )
            })
            .unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
        let kept = get(&fx, &project);
        assert_eq!(kept.name, "Телемедиа", "nothing of the patch is written");
        assert_eq!(kept.notes.chars().count(), MAX_NOTES_CHARS);
    }

    #[test]
    fn a_built_brief_is_fresh_and_survives_a_reread() {
        let fx = Fixture::new();
        let project = fx.project("Телемедиа");
        let built = build(&fx, &project, true);
        assert_eq!(built.brief_state, BriefState::Fresh);
        assert!(built.brief_truncated);
        assert!(built.brief_built_at.unwrap() >= project.created_at);
        assert_eq!(built.brief.as_ref().unwrap()["product"], "Колл-центр");
        assert_eq!(get(&fx, &project), built);
        assert_eq!(
            fx.sink.events().last(),
            Some(&DataChanged::new(
                Entity::Project,
                &project.id,
                Some(&project.id),
                Change::Updated
            ))
        );
    }

    /// «Добавили человека»: the brief may be outdated, and the project's
    /// stores hear about it.
    #[test]
    fn adding_a_person_makes_the_brief_outdated() {
        let fx = Fixture::new();
        let project = fx.project("Телемедиа");
        build(&fx, &project, false);
        let before = fx.sink.events().len();

        let person = fx.person(&project, "Ольга");

        assert_eq!(state(&fx, &project), BriefState::Outdated);
        assert_eq!(
            fx.sink.events()[before..],
            [
                DataChanged::new(
                    Entity::Person,
                    &person.id,
                    Some(&project.id),
                    Change::Created
                ),
                DataChanged::new(
                    Entity::Project,
                    &project.id,
                    Some(&project.id),
                    Change::Updated
                ),
            ]
        );
    }

    #[test]
    fn renaming_the_project_keeps_the_brief_fresh() {
        let fx = Fixture::new();
        let project = fx.project("Телемедиа");
        fx.person(&project, "Ольга");
        build(&fx, &project, false);

        let renamed = update(
            &fx,
            &project,
            ProjectUpdate {
                name: Some("Телемедиа (сеть клиник)".to_owned()),
                ..ProjectUpdate::default()
            },
        );

        assert_eq!(renamed.brief_state, BriefState::Fresh);
    }

    /// Editing there and back gives the same fingerprint: fresh again.
    #[test]
    fn editing_there_and_back_is_fresh_again() {
        let fx = Fixture::new();
        let project = fx.project("Телемедиа");
        let person = fx.person(&project, "Ольга");
        build(&fx, &project, false);

        let notes = |text: &str| ProjectUpdate {
            notes: Some(text.to_owned()),
            ..ProjectUpdate::default()
        };
        assert_eq!(
            update(&fx, &project, notes("Не говорить о сроках")).brief_state,
            BriefState::Outdated
        );
        assert_eq!(
            update(&fx, &project, notes("")).brief_state,
            BriefState::Fresh
        );

        let edit = |profile: serde_json::Value| {
            let id = person.id.clone();
            let patch = PersonUpdate {
                profile: Some(profile),
                ..PersonUpdate::default()
            };
            fx.write(move |db| people::update(db, &id, patch)).unwrap();
        };
        edit(json!({ "howToAsk": "через деньги", "tech": 4, "project": 3 }));
        assert_eq!(state(&fx, &project), BriefState::Outdated);
        // The same profile, keys in another order.
        edit(json!({ "project": 3, "tech": 1, "howToAsk": "через деньги" }));
        assert_eq!(state(&fx, &project), BriefState::Fresh);

        let description = |text: &str| ProjectUpdate {
            description: Some(text.to_owned()),
            ..ProjectUpdate::default()
        };
        update(&fx, &project, description("Другое"));
        assert_eq!(state(&fx, &project), BriefState::Outdated);
        update(&fx, &project, description(&project.description));
        assert_eq!(state(&fx, &project), BriefState::Fresh);

        // Removing a person: outdated, and the project hears about it.
        let id = person.id.clone();
        fx.write(move |db| people::delete(db, &id)).unwrap();
        assert_eq!(state(&fx, &project), BriefState::Outdated);
        assert_eq!(
            fx.sink.events().last(),
            Some(&DataChanged::new(
                Entity::Project,
                &project.id,
                Some(&project.id),
                Change::Updated
            ))
        );
    }

    /// A brief written through `projects_update` was not built from known
    /// inputs; `null` removes it with its build time.
    #[test]
    fn a_brief_given_by_hand_is_outdated_and_null_removes_it() {
        let fx = Fixture::new();
        let project = fx.project("Телемедиа");
        build(&fx, &project, true);
        let given = update(
            &fx,
            &project,
            ProjectUpdate {
                brief: Some(Some(json!({ "product": "Руками" }))),
                ..ProjectUpdate::default()
            },
        );
        assert_eq!(given.brief_state, BriefState::Outdated);
        assert!(!given.brief_truncated);
        assert!(given.brief_built_at.is_some());

        let removed = update(
            &fx,
            &project,
            ProjectUpdate {
                brief: Some(None),
                ..ProjectUpdate::default()
            },
        );
        assert_eq!(removed.brief, None);
        assert_eq!(removed.brief_built_at, None);
        assert_eq!(removed.brief_state, BriefState::None);
    }

    #[test]
    fn a_running_build_reads_as_building() {
        let fx = Fixture::new();
        let project = fx.project("Телемедиа");
        let other = fx.project("Лапа");
        build(&fx, &project, false);
        let builds = BriefBuilds::default();

        let slot = builds.start(&project.id).unwrap();
        assert!(builds.start(&project.id).is_none(), "one build per project");
        let listed = builds.mark_all(fx.read(projects::list).unwrap());
        let states: Vec<BriefState> = listed.iter().map(|p| p.brief_state).collect();
        assert_eq!(states, [BriefState::Building, BriefState::None]);
        assert_eq!(builds.mark(get(&fx, &other)).brief_state, BriefState::None);

        drop(slot);
        assert_eq!(
            builds.mark(get(&fx, &project)).brief_state,
            BriefState::Fresh
        );
    }

    /// The home screen: open questions of the project's recordings (with a
    /// call or not) and when the last one started.
    #[test]
    fn overview_counts_open_questions_and_the_last_recording() {
        let fx = Fixture::new();
        let project = fx.project("Телемедиа");
        let lapa = fx.project("Лапа");
        let empty = fx.project("Пустой");
        let call = fx.call(&project, &[]);
        let first = fx.recording(RecordingLinks::call(&call.id));
        fx.question(&first, "Кто старший смены?");
        let loose = fx.recording(RecordingLinks {
            project_id: Some(project.id.clone()),
            ..RecordingLinks::default()
        });
        let answered = fx.question(&loose, "Сколько операторов?");
        fx.question(&loose, "Где очередь?");
        let id = loose.clone();
        fx.write(move |db| {
            db.execute(
                "UPDATE recordings SET started_at = 5000 WHERE id = ?1",
                [&id],
            )?;
            db.execute(
                "UPDATE questions SET status = 'answered' WHERE id = ?1",
                [&answered],
            )?;
            Ok(((), Vec::new()))
        })
        .unwrap();
        // Another project's recording counts there only.
        fx.recording(RecordingLinks {
            project_id: Some(lapa.id.clone()),
            ..RecordingLinks::default()
        });

        let overview = fx.read(projects::overview).unwrap();

        assert_eq!(
            overview,
            [
                ProjectOverview {
                    project_id: project.id.clone(),
                    open_questions: 2,
                    last_recording_at: Some(5000),
                },
                ProjectOverview {
                    project_id: lapa.id.clone(),
                    open_questions: 0,
                    last_recording_at: Some(1000),
                },
                ProjectOverview {
                    project_id: empty.id.clone(),
                    open_questions: 0,
                    last_recording_at: None,
                },
            ]
        );
        assert_eq!(
            serde_json::to_value(&overview[0]).unwrap(),
            json!({ "projectId": project.id, "openQuestions": 2, "lastRecordingAt": 5000 })
        );
    }
}
