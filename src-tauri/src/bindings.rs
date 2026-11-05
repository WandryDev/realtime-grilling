//! The Rust ↔ TypeScript contract (design.md, decision 12): commands and
//! events registered with tauri-specta, exported to `src/bindings.ts`.

#[cfg(any(debug_assertions, test))]
use std::path::{Path, PathBuf};

#[cfg(any(debug_assertions, test))]
use specta_typescript::Typescript;
use tauri_specta::{Builder, collect_commands, collect_events};

use crate::{
    agent::{
        fast_loop::events::{AgentStatus, CallStateChanged},
        install::AgentInstallProgress,
    },
    audio::{AudioLevel, AudioLevelStopped, mic_watch::MicActivityChanged},
    commands,
    events::{CallSessionChanged, DataChanged, Navigate, ShortcutPressed},
    projects::brief::{Brief, BriefProgress},
    recording::status::{RecordingChanged, RecordingLevels},
    records,
    speech::{
        events::{
            TranscriptDropped, TranscriptLag, TranscriptPending, TranscriptPhrase,
            TranscriptRefine, TranscriptSkipped,
        },
        models::SpeechModelChanged,
    },
};

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        // IPC is JSON, so every number crosses as an f64 anyway. The i64s here
        // are millisecond timestamps and counts, far below 2^53, and
        // `serde_json::Value` (JSON columns) carries i64/u64 numbers.
        .dangerously_cast_bigints_to_number()
        // One TS type per Rust type: results are Serialize-only, inputs are
        // Deserialize-only with `#[specta(optional)]` fields.
        .disable_serde_phases()
        .commands(collect_commands![
            commands::projects_list,
            commands::projects_get,
            commands::projects_create,
            commands::projects_update,
            commands::projects_delete,
            commands::projects_overview,
            commands::project_sources_add,
            commands::project_sources_list,
            commands::project_sources_remove,
            commands::brief_build,
            commands::brief_cancel,
            commands::brief_prepare,
            commands::brief_export,
            commands::people_list,
            commands::people_get,
            commands::people_create,
            commands::people_update,
            commands::people_delete,
            commands::calls_list,
            commands::calls_get,
            commands::calls_create,
            commands::calls_update,
            commands::calls_patch_summary,
            commands::calls_delete,
            commands::call_participants_list,
            commands::call_participants_add,
            commands::call_participants_remove,
            commands::transcript_list,
            commands::transcript_for_recording,
            commands::transcript_state,
            commands::call_state_get,
            commands::questions_act,
            commands::agent_retry,
            commands::settings_get,
            commands::settings_update,
            commands::onboarding_complete,
            commands::windows_show,
            commands::storage_reopen,
            commands::permissions_get,
            commands::permission_request,
            commands::permission_open_settings,
            commands::agent_status,
            commands::agent_install,
            commands::agent_install_cancel,
            commands::agent_login_start,
            commands::agent_login_submit,
            commands::agent_login_cancel,
            commands::audio_level_start,
            commands::audio_level_stop,
            commands::app_restart,
            commands::mic_activity_get,
            commands::call_current,
            commands::call_start,
            commands::call_finish,
            commands::call_resume,
            commands::call_close,
            commands::call_keep,
            commands::call_discard,
            commands::recording_start,
            commands::recording_stop,
            commands::recording_status,
            commands::speech_models_list,
            commands::speech_model_download,
            commands::speech_model_pause,
            commands::speech_model_cancel,
            commands::speech_model_remove,
            commands::speech_model_select,
            commands::speech_benchmark,
            commands::speech_benchmark_cancel,
            commands::speech_mic_check,
            // A finished call's records (post-call tasks 3.1–3.4).
            records::commands::proposals_list,
            records::commands::proposals_for_person,
            records::commands::proposal_decide,
            records::commands::proposal_undo,
            records::commands::call_cards,
            records::commands::call_card_update,
            records::commands::call_transcript,
            records::commands::call_questions,
            records::commands::calls_search,
        ])
        .events(collect_events![
            AgentInstallProgress,
            AgentStatus,
            AudioLevel,
            AudioLevelStopped,
            BriefProgress,
            CallSessionChanged,
            CallStateChanged,
            DataChanged,
            MicActivityChanged,
            Navigate,
            RecordingChanged,
            RecordingLevels,
            ShortcutPressed,
            SpeechModelChanged,
            TranscriptDropped,
            TranscriptLag,
            TranscriptPending,
            TranscriptPhrase,
            TranscriptRefine,
            TranscriptSkipped
        ])
        // The shape of `Project.brief` (a JSON column, `JsonValue` there).
        .typ::<Brief>()
}

/// `src/bindings.ts` of the repository.
#[cfg(any(debug_assertions, test))]
pub fn bindings_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("bindings.ts")
}

#[cfg(any(debug_assertions, test))]
pub fn export(builder: &Builder<tauri::Wry>) -> Result<(), String> {
    let typescript = Typescript::default().header(
        "// Generated by tauri-specta from src-tauri. Do not edit: run `cargo test` \
         (or start a debug build) to regenerate.\n",
    );
    builder
        .export(typescript, bindings_path())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::{
        io,
        path::Path,
        sync::{Arc, Mutex},
    };

    use tauri_specta::{BuilderConfiguration, LanguageExt};

    use super::*;

    mod manifest {
        include!("../command_names.rs");
    }

    /// Exports nothing; records the registered command names.
    #[derive(Clone, Default)]
    struct CommandNames(Arc<Mutex<Vec<String>>>);

    impl LanguageExt for CommandNames {
        type Error = io::Error;

        fn export(self, cfg: &BuilderConfiguration, _path: &Path) -> Result<(), io::Error> {
            let mut names = self.0.lock().unwrap();
            names.extend(
                cfg.commands
                    .iter()
                    .map(|command| command.name().to_string()),
            );
            Ok(())
        }
    }

    #[test]
    fn export_bindings() {
        export(&builder()).unwrap();
        let bindings = std::fs::read_to_string(bindings_path()).unwrap();
        assert!(bindings.contains("projectsList"));
        assert!(bindings.contains("dataChanged"));
    }

    /// Every command registered with the builder has a permission in the
    /// app manifest (`command_names.rs`), and nothing more.
    #[test]
    fn manifest_lists_every_command() {
        let names = CommandNames::default();
        builder().export(names.clone(), Path::new("")).unwrap();
        let mut registered = names.0.lock().unwrap().clone();
        let mut manifest: Vec<String> = manifest::APP_COMMANDS
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        registered.sort();
        manifest.sort();
        assert_eq!(registered, manifest);
    }
}
