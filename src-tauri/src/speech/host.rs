//! Where the live pass and the second pass report and store: the app
//! (`speech::app`), or a recorder in tests.

use std::{path::PathBuf, sync::Arc};

use rusqlite::Connection;

use super::{events::TranscriptEvent, models::ModelId, status::TranscriptionStatus};
use crate::{
    error::{CommandError, CommandResult},
    events::DataChanged,
};

/// Work on the database, as the recorder runs it.
pub type DbWork<'a> = &'a mut dyn FnMut(&Connection) -> CommandResult<()>;

pub trait SpeechHost: Send + Sync + 'static {
    /// To every window.
    fn emit(&self, event: TranscriptEvent);
    /// To every window, after the write.
    fn data_changed(&self, event: DataChanged);
    /// Runs `work` on the database (blocking).
    fn database(&self, work: DbWork<'_>) -> CommandResult<()>;
    /// The `speechModel` setting and whether that model is installed.
    fn selected_model(&self) -> (ModelId, bool);
    /// whisper.cpp did not load the installed model `model`.
    fn model_failed(&self, model: ModelId, message: &str);
    /// The live pass of `recording_id` recognizes, or why not.
    fn transcription_changed(&self, recording_id: &str, status: TranscriptionStatus);
    /// The live pass of a stopped recording is over: its last phrase is
    /// answered. The second pass may start.
    fn live_finished(&self, recording_id: &str);
    /// The second pass waits between phrases while this holds (a recording
    /// or the hardware check runs).
    fn refine_paused(&self) -> bool;
    /// What the recordings' file paths are relative to.
    fn data_dir(&self) -> Option<PathBuf>;
    /// The Silero model of the second pass's segmentation.
    fn vad_model(&self) -> PathBuf;
}

/// Runs `work` on the host's database (blocking) and returns its output.
pub fn with_database<T>(
    host: &dyn SpeechHost,
    work: impl FnOnce(&Connection) -> CommandResult<T>,
) -> CommandResult<T> {
    let mut work = Some(work);
    let mut output = None;
    host.database(&mut |connection| {
        if let Some(work) = work.take() {
            output = Some(work(connection)?);
        }
        Ok(())
    })?;
    output.ok_or_else(|| CommandError::storage("База данных не ответила"))
}

/// [`with_database`] off the async workers.
pub async fn database<T: Send + 'static>(
    host: &Arc<dyn SpeechHost>,
    work: impl FnOnce(&Connection) -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    let host = Arc::clone(host);
    tauri::async_runtime::spawn_blocking(move || with_database(host.as_ref(), work))
        .await
        .map_err(|error| CommandError::storage(error.to_string()))?
}
