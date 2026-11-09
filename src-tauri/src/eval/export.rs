//! `grill-eval export`: a recording of the app's database into a corpus
//! (question-quality design.md, decision 2). The database is opened
//! read-only ([`storage::open_read_only`]): SQLite refuses any write, so the
//! export can run while the app is open.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{Value, json};

use super::corpus::{
    self, Channels, Corpus, Origin, Original, Person, Project, Recording, Segment,
};
use crate::{
    speech::context,
    storage::{
        self, DATABASE_FILE, call_state, people, projects, recordings, settings, sources,
        transcript::{self, TranscriptPass, TranscriptSegment},
    },
};

/// The app's identifier (`tauri.conf.json`): its data folder's name.
const APP_IDENTIFIER: &str = "com.dev-wandry.realtime-grilling";

/// The settings of the fast loop a corpus keeps.
const LOOP_SETTINGS: [&str; 3] = [
    settings::QUESTION_FREQUENCY,
    settings::QUESTION_COUNT,
    settings::CALL_LANGUAGE,
];

/// Where the app keeps `grill.db`: Tauri's `app_data_dir()` without Tauri.
pub fn default_database() -> Option<PathBuf> {
    let data = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })
    }?;
    Some(data.join(APP_IDENTIFIER).join(DATABASE_FILE))
}

/// Exports `recording_id` of the database at `database` to the corpus
/// `name` (the recording id when `None`) in `eval_dir`. Returns the file.
/// Nothing is written when the recording can't be exported.
pub fn run(
    database: &Path,
    recording_id: &str,
    name: Option<&str>,
    eval_dir: &Path,
) -> Result<PathBuf, String> {
    let name = name.unwrap_or(recording_id);
    corpus::check_name(name)?;
    if !database.is_file() {
        return Err(format!("Базы приложения нет: {}", database.display()));
    }
    let connection = storage::open_read_only(database)?;
    let corpus = build(&connection, recording_id, name, storage::now_ms())?;
    let path = corpus::path_of(eval_dir, name);
    corpus.save(&path)?;
    Ok(path)
}

fn segment(segment: TranscriptSegment) -> Segment {
    Segment {
        id: segment.id,
        channel: segment.channel,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        text: segment.text,
    }
}

/// The corpus of `recording_id`. A recording without a live transcript has
/// nothing to replay: an error.
pub fn build(
    connection: &Connection,
    recording_id: &str,
    name: &str,
    exported_at: i64,
) -> Result<Corpus, String> {
    let failed = |error: crate::error::CommandError| error.to_string();
    let recording = recordings::get(connection, recording_id).map_err(failed)?;
    let live: Vec<Segment> = transcript::of_pass(connection, recording_id, TranscriptPass::Live)
        .map_err(failed)?
        .into_iter()
        .map(segment)
        .collect();
    if live.is_empty() {
        return Err(format!(
            "У записи {recording_id} нет живой расшифровки: прогонять нечего"
        ));
    }
    let refined: Vec<Segment> =
        transcript::of_pass(connection, recording_id, TranscriptPass::Refined)
            .map_err(failed)?
            .into_iter()
            .map(segment)
            .collect();

    let (project, people) = match &recording.project_id {
        Some(project_id) => {
            let project = projects::get(connection, project_id).map_err(failed)?;
            let texts = sources::ready_texts(connection, project_id).map_err(failed)?;
            let people = people::list(connection, project_id).map_err(failed)?;
            let project = Project {
                name: project.name,
                description: project.description,
                notes: project.notes,
                brief: project.brief,
                sources: texts
                    .into_iter()
                    .map(|source| corpus::SourceText {
                        name: source.name,
                        text: source.text,
                    })
                    .collect(),
            };
            let people = people
                .into_iter()
                .map(|person| Person {
                    id: person.id,
                    name: person.name,
                    role: person.role,
                    profile: person.profile,
                })
                .collect();
            (Some(project), people)
        }
        None => (None, Vec::new()),
    };
    let glossary = context::load(connection, recording_id)
        .map_err(failed)?
        .glossary
        .full()
        .to_owned();
    let stored = settings::get(connection).map_err(failed)?;
    let loop_settings = LOOP_SETTINGS
        .iter()
        .filter_map(|key| Some(((*key).to_owned(), stored.get(*key)?.clone())))
        .collect();
    let last_end = live.iter().map(|segment| segment.end_ms).max().unwrap_or(0);
    let duration_ms = recording
        .ended_at
        .map_or(last_end, |ended_at| ended_at - recording.started_at)
        .max(last_end);

    Ok(Corpus {
        version: corpus::FORMAT,
        name: name.to_owned(),
        origin: Origin::Export {
            recording_id: recording_id.to_owned(),
            exported_at,
        },
        channels: Channels::Real,
        project,
        people,
        participant_ids: recording.participant_ids,
        glossary,
        settings: loop_settings,
        recording: Recording {
            started_at: recording.started_at,
            duration_ms,
        },
        live,
        refined: (!refined.is_empty()).then_some(refined),
        original: Some(original(connection, recording_id)?),
    })
}

/// The topics, questions and agent calls of the live run.
fn original(connection: &Connection, recording_id: &str) -> Result<Original, String> {
    let state = call_state::get(connection, recording_id).map_err(|e| e.to_string())?;
    let calls = call_state::agent_calls(connection, recording_id).map_err(|e| e.to_string())?;
    let value = |item: Result<Value, serde_json::Error>| item.map_err(|e| e.to_string());
    Ok(Original {
        topics: state
            .topics
            .iter()
            .map(|topic| value(serde_json::to_value(topic)))
            .collect::<Result<_, _>>()?,
        questions: state
            .questions
            .iter()
            .map(|question| value(serde_json::to_value(question)))
            .collect::<Result<_, _>>()?,
        calls: calls
            .into_iter()
            .map(|call| {
                json!({
                    "id": call.id,
                    "startedAt": call.started_at,
                    "durationMs": call.duration_ms,
                    "outcome": call.outcome,
                    "inputTokens": call.input_tokens,
                    "outputTokens": call.output_tokens,
                    "cacheRead": call.cache_read,
                    "cacheWrite": call.cache_write,
                    "costUsd": call.cost_usd,
                    "rejected": call.rejected,
                    "error": call.error,
                    "createdAt": call.created_at,
                })
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        agent::fast_loop::testing::{recording, say, set_setting},
        storage::{
            call_state::{
                CardLens, Evidence, EvidenceSource, GapType, NewQuestion, ValidatedOp,
                ValidatedPatch,
            },
            transcript::{SegmentInput, TranscriptChannel},
        },
    };

    /// The data folder name is the app's identifier.
    #[test]
    fn the_identifier_is_the_apps() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }

    /// A recording of «Телемедиа» with two live phrases, a refined pass, a
    /// question of the live run and its agent call, in a database file.
    fn exported_recording(dir: &Path) -> (PathBuf, String) {
        let path = dir.join(DATABASE_FILE);
        let db = storage::open(&path, &storage::MIGRATIONS).unwrap();
        set_setting(&db, settings::QUESTION_FREQUENCY, json!("often"));
        let id = recording(&db);
        let first = say(
            &db,
            &id,
            TranscriptChannel::Me,
            0,
            "Как сейчас принимаете звонки?",
        );
        say(
            &db,
            &id,
            TranscriptChannel::Others,
            3_000,
            "Звонки идут на личные телефоны",
        );
        transcript::replace_refined(
            &db,
            &id,
            vec![SegmentInput {
                channel: TranscriptChannel::Me,
                start_ms: 0,
                end_ms: 2_000,
                text: "Как сейчас вы принимаете звонки?".to_owned(),
            }],
        )
        .unwrap();
        let evidence = vec![Evidence {
            source: EvidenceSource::Segment,
            id: first.id,
            quote: "принимаете звонки".to_owned(),
        }];
        call_state::apply_patch(
            &db,
            &id,
            &ValidatedPatch {
                ops: vec![
                    ValidatedOp::CreateTopic {
                        title: "Приём звонков".to_owned(),
                    },
                    ValidatedOp::AddQuestion(NewQuestion {
                        text: "Кто отвечает на звонки ночью?".to_owned(),
                        description: String::new(),
                        card_field: CardLens::Users,
                        gap_type: GapType::Empty,
                        priority: 2,
                        evidence,
                    }),
                ],
            },
        )
        .unwrap();
        call_state::insert_agent_call(
            &db,
            &call_state::AgentCallInput {
                recording_id: id.clone(),
                started_at: 5_000,
                duration_ms: 3_400,
                outcome: Some(call_state::AgentCallOutcome::Ok),
                cost_usd: Some(0.04),
                ..Default::default()
            },
        )
        .unwrap();
        (path, id)
    }

    #[test]
    fn an_export_reads_back_the_same_call() {
        let dir = tempfile::tempdir().unwrap();
        let (database, id) = exported_recording(dir.path());
        let eval_dir = dir.path().join(".grill-eval");

        let path = run(&database, &id, Some("telemedia"), &eval_dir).unwrap();
        assert_eq!(path, eval_dir.join("corpus/telemedia.json"));
        let corpus = Corpus::load(&path).unwrap();

        let db = storage::open_read_only(&database).unwrap();
        let live = transcript::of_pass(&db, &id, TranscriptPass::Live).unwrap();
        assert_eq!(
            corpus.live,
            live.into_iter().map(segment).collect::<Vec<_>>()
        );
        assert_eq!(corpus.live[1].text, "Звонки идут на личные телефоны");
        assert_eq!(corpus.live[1].channel, TranscriptChannel::Others);
        assert_eq!(corpus.refined.as_ref().unwrap().len(), 1);

        let project = corpus.project.as_ref().unwrap();
        assert_eq!(project.name, "Телемедиа");
        assert_eq!(
            project.description,
            "Единая система приёма звонков для сети клиник"
        );
        assert_eq!(project.brief.as_ref().unwrap()["stack"][1], "Mango Office");
        let mut names: Vec<&str> = corpus.people.iter().map(|p| p.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["Игорь Савчук", "Ольга Демченко"]);
        let olga = corpus
            .people
            .iter()
            .find(|person| person.name == "Ольга Демченко")
            .unwrap();
        assert_eq!(olga.profile["tech"], 1);
        assert_eq!(corpus.participant_ids, std::slice::from_ref(&olga.id));
        assert!(corpus.glossary.contains("Первичка"), "{}", corpus.glossary);
        assert_eq!(corpus.settings[settings::QUESTION_FREQUENCY], "often");
        assert_eq!(corpus.recording.started_at, 1_000);
        assert_eq!(corpus.recording.duration_ms, 5_000);

        let original = corpus.original.as_ref().unwrap();
        assert_eq!(original.topics[0]["title"], "Приём звонков");
        assert_eq!(
            original.questions[0]["text"],
            "Кто отвечает на звонки ночью?"
        );
        assert_eq!(original.calls[0]["outcome"], "ok");
        assert_eq!(original.calls[0]["costUsd"], 0.04);
        assert!(
            matches!(&corpus.origin, Origin::Export { recording_id, .. } if *recording_id == id)
        );
    }

    /// «Запись без расшифровки»: an error with its reason, no file.
    #[test]
    fn a_recording_without_a_transcript_is_not_exported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let id = {
            let db = storage::open(&path, &storage::MIGRATIONS).unwrap();
            recording(&db)
        };
        let eval_dir = dir.path().join(".grill-eval");

        let error = run(&path, &id, None, &eval_dir).unwrap_err();
        assert!(error.contains("нет живой расшифровки"), "{error}");
        assert!(!eval_dir.exists());
    }

    #[test]
    fn an_unknown_recording_is_not_exported() {
        let dir = tempfile::tempdir().unwrap();
        let (database, _) = exported_recording(dir.path());
        let error = run(&database, "nope", None, &dir.path().join("e")).unwrap_err();
        assert!(error.contains("не найдена"), "{error}");
    }

    /// The export never writes to the app's database: the file is not
    /// touched, and a write through its connection is refused.
    #[test]
    fn the_apps_database_stays_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let (database, id) = exported_recording(dir.path());
        let before = std::fs::read(&database).unwrap();
        run(&database, &id, None, &dir.path().join("e")).unwrap();
        assert_eq!(std::fs::read(&database).unwrap(), before);

        let db = storage::open_read_only(&database).unwrap();
        assert!(db.execute("DELETE FROM recordings", []).is_err());
    }

    #[test]
    fn a_database_of_another_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        Connection::open(&path)
            .unwrap()
            .execute_batch("PRAGMA user_version = 2;")
            .unwrap();
        let error = storage::open_read_only(&path).unwrap_err();
        assert!(error.contains("схеме v2"), "{error}");
    }
}
