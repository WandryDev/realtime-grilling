//! The fast loop in the app: its storage, its windows and Claude Code.

use std::{path::PathBuf, sync::Arc};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::{
    events::{AgentLoopState, AgentStatus, CallStateChanged, CallStateView},
    scheduler::{AgentProvider, DbWork, FastLoop, LoopConfig, LoopHost, ProvideFuture},
};
use crate::{
    agent::{self, AgentState, claude_cli::ClaudeCodeCli, discover::SearchEnv},
    error::{CommandError, CommandResult},
    storage::{Storage, call_state},
};

/// `app_data_dir()/agent`: the CLI's work dir and the prefix files.
pub fn work_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("grill"))
        .join("agent")
}

struct AppLoopHost<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> LoopHost for AppLoopHost<R> {
    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        let storage = self
            .app
            .try_state::<Storage>()
            .ok_or_else(|| CommandError::storage("Хранилище ещё не открыто"))?;
        storage.read_now(|connection| work(connection))
    }

    fn call_state_changed(&self, recording_id: &str) {
        call_state_changed(&self.app, recording_id);
    }

    fn agent_status(&self, status: &AgentStatus) {
        if let Err(error) = status.emit(&self.app) {
            eprintln!("grill: failed to emit agent-status: {error}");
        }
    }
}

/// Claude Code once `agent_status` would say `ready`.
struct CliProvider<R: Runtime> {
    app: AppHandle<R>,
}

/// What the windows show for a CLI that isn't ready.
fn not_ready(state: AgentState) -> AgentLoopState {
    match state {
        AgentState::NeedsLogin { .. } => AgentLoopState::NeedsLogin,
        AgentState::NotInstalled => AgentLoopState::Error {
            message: "Claude Code не установлен".to_owned(),
            retry_at: None,
        },
        AgentState::Error { message } => AgentLoopState::Error {
            message,
            retry_at: None,
        },
        AgentState::Ready { .. } => AgentLoopState::Error {
            message: "Claude Code не найден".to_owned(),
            retry_at: None,
        },
    }
}

impl<R: Runtime> AgentProvider for CliProvider<R> {
    fn provide(&self) -> ProvideFuture {
        let app = self.app.clone();
        Box::pin(async move {
            let Some(storage) = app.try_state::<Storage>() else {
                return Err(AgentLoopState::Error {
                    message: "Хранилище ещё не открыто".to_owned(),
                    retry_at: None,
                });
            };
            let cwd = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let cli = agent::ready_cli(&storage, &app, &SearchEnv::from_process(), &cwd)
                .await
                .map_err(not_ready)?;
            let agent: Arc<dyn agent::claude_cli::Agent> =
                Arc::new(ClaudeCodeCli::new(cli, work_dir(&app)));
            Ok(agent)
        })
    }
}

/// The fast loop of the app, on Tauri's runtime. The prefix files a crash
/// or a forced quit left behind are removed: no recording is live yet.
pub fn for_app<R: Runtime>(app: &AppHandle<R>) -> FastLoop {
    let fast_loop = FastLoop::new(
        Arc::new(AppLoopHost { app: app.clone() }),
        Arc::new(CliProvider { app: app.clone() }),
        tauri::async_runtime::handle().inner().clone(),
        LoopConfig::new(work_dir(app)),
    );
    let removed = fast_loop.sweep_prompts();
    if removed > 0 {
        eprintln!("grill: removed {removed} prompt files of the agent left from an earlier run");
    }
    fast_loop
}

/// `CallStateChanged` to every window.
pub fn call_state_changed<R: Runtime>(app: &AppHandle<R>, recording_id: &str) {
    let event = CallStateChanged {
        recording_id: recording_id.to_owned(),
    };
    if let Err(error) = event.emit(app) {
        eprintln!("grill: failed to emit call-state-changed: {error}");
    }
}

/// What `call_state_get` returns.
pub fn view(
    connection: &Connection,
    fast_loop: &FastLoop,
    recording_id: &str,
) -> CommandResult<CallStateView> {
    Ok(CallStateView {
        state: call_state::get(connection, recording_id)?,
        agent: fast_loop.status(recording_id),
    })
}

/// After `questionCount` changed: every list that depends on it is
/// recomputed. Returns the recordings whose windows must read again.
pub fn recompute_lists(connection: &Connection) -> CommandResult<Vec<String>> {
    let recordings = call_state::recordings_with_open_questions(connection)?;
    for recording_id in &recordings {
        call_state::recompute_visible(connection, recording_id)?;
    }
    Ok(recordings)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        agent::fast_loop::testing::{database, recording, set_setting},
        storage::{
            call_state::{
                CardLens, Evidence, EvidenceSource, GapType, NewQuestion, QuestionAction,
                ValidatedOp, ValidatedPatch,
            },
            settings,
        },
    };

    fn ask(text: &str, priority: i32) -> ValidatedOp {
        ValidatedOp::AddQuestion(NewQuestion {
            text: text.to_owned(),
            description: String::new(),
            card_field: CardLens::Goal,
            gap_type: GapType::Empty,
            priority,
            evidence: vec![Evidence {
                source: EvidenceSource::Project,
                id: "P1".to_owned(),
                quote: "система".to_owned(),
            }],
        })
    }

    fn visible(connection: &Connection, recording_id: &str) -> Vec<String> {
        let mut questions: Vec<_> = call_state::get(connection, recording_id)
            .unwrap()
            .questions
            .into_iter()
            .filter(|question| question.visible)
            .collect();
        questions.sort_by_key(|question| question.rank);
        questions
            .into_iter()
            .map(|question| question.text)
            .collect()
    }

    /// A raised `questionCount` fills the list at once; the windows of that
    /// recording read again.
    #[test]
    fn a_new_question_count_recomputes_the_lists() {
        let db = database();
        let id = recording(&db);
        set_setting(&db, settings::QUESTION_COUNT, json!("1"));
        let mut ops = vec![
            ValidatedOp::CreateTopic {
                title: "Очередь".to_owned(),
            },
            ValidatedOp::SetCardField {
                field: CardLens::Goal,
                value: "Не терять звонки".to_owned(),
                evidence: vec![Evidence {
                    source: EvidenceSource::Project,
                    id: "P1".to_owned(),
                    quote: "система".to_owned(),
                }],
            },
        ];
        ops.extend([ask("Первый", 3), ask("Второй", 2), ask("Третий", 1)]);
        call_state::apply_patch(&db, &id, &ValidatedPatch { ops }).unwrap();
        assert_eq!(visible(&db, &id), ["Первый"]);

        set_setting(&db, settings::QUESTION_COUNT, json!("5"));
        assert_eq!(recompute_lists(&db).unwrap(), std::slice::from_ref(&id));
        assert_eq!(visible(&db, &id), ["Первый", "Второй", "Третий"]);

        // A quick action frees a place the same way.
        set_setting(&db, settings::QUESTION_COUNT, json!("1"));
        recompute_lists(&db).unwrap();
        let first = call_state::get(&db, &id).unwrap().questions[0].id.clone();
        call_state::act(&db, &first, QuestionAction::Hide).unwrap();
        assert_eq!(visible(&db, &id), ["Второй"]);
    }

    #[test]
    fn a_cli_that_is_not_ready_is_shown_as_such() {
        assert_eq!(
            not_ready(AgentState::NeedsLogin {
                version: "2.1.316".to_owned()
            }),
            AgentLoopState::NeedsLogin
        );
        assert_eq!(
            not_ready(AgentState::NotInstalled),
            AgentLoopState::Error {
                message: "Claude Code не установлен".to_owned(),
                retry_at: None
            }
        );
    }
}
