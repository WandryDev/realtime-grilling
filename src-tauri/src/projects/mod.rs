//! Projects beyond their rows: documents and their text, what the brief is
//! built from, running brief builds (projects-people-brief).

pub mod brief;
pub mod brief_inputs;
pub mod builds;
pub mod sources;

use sha2::{Digest as _, Sha256};

use crate::{
    error::CommandResult,
    events::EventSink,
    storage::{Storage, projects},
};

/// Deletes the project with everything it has (`projects_delete`). After
/// the commit: the files of its recordings and documents go, and a running
/// brief build of it is cancelled, so its agent stops instead of running on
/// to a save that can't happen.
pub async fn delete(
    storage: &Storage,
    sink: &impl EventSink,
    builds: &builds::BriefBuilds,
    id: &str,
) -> CommandResult<()> {
    let project_id = id.to_owned();
    storage
        .write(sink, move |db| projects::delete(db, &project_id))
        .await?;
    // The project's calls took their recordings with them; now their files,
    // and the copies of its documents.
    storage.sweep_recordings().await;
    sources::remove_project_files(storage, id);
    builds.cancel(id);
    Ok(())
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}
