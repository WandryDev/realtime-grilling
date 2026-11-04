//! The project's documents from the manager's computer
//! (`specs/project-sources`; projects-people-brief design.md, decisions 1–3):
//! adding copies a file into the app data folder and reads its text once.

pub mod extract;
pub mod files;

use std::path::Path;

use serde::Serialize;
use specta::Type;

use self::{
    extract::{FileKind, extract_in_background},
    files::ProjectFiles,
};
use super::sha256_hex;
use crate::{
    error::{CommandError, CommandResult},
    events::EventSink,
    storage::{
        Storage, new_id, projects,
        sources::{self, NewSource, ProjectSource},
    },
};

/// Largest document the app takes.
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

const UNSUPPORTED: &str = "Поддерживаются .md, .txt, .pdf и .docx";

/// Why a file was not added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RejectReason {
    /// Not `.md`, `.txt`, `.pdf` or `.docx`.
    UnsupportedType,
    /// Larger than 20 MB.
    TooLarge,
    /// Missing, a folder, or the OS would not let the app read it.
    Unreadable,
}

/// What happened to one file of `project_sources_add`.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum SourceAddOutcome {
    Added {
        source: ProjectSource,
    },
    /// The project already has a document with the same content: that one.
    Duplicate {
        source: ProjectSource,
    },
    Rejected {
        reason: RejectReason,
        /// What to show next to the file.
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceAddResult {
    /// The path as given.
    pub path: String,
    /// Its file name.
    pub name: String,
    pub result: SourceAddOutcome,
}

fn project_files(storage: &Storage) -> CommandResult<ProjectFiles> {
    storage
        .data_dir()
        .map(ProjectFiles::new)
        .ok_or_else(|| CommandError::storage("У приложения нет папки данных"))
}

/// Adds the files at `paths` to the project, one by one, in order. A file
/// that can't be added is `rejected` and the others still go; a storage
/// failure stops the rest. Every added document sends the project's
/// `DataChanged` (its `briefState` may change).
pub async fn add(
    storage: &Storage,
    sink: &impl EventSink,
    project_id: &str,
    paths: Vec<String>,
) -> CommandResult<Vec<SourceAddResult>> {
    let files = project_files(storage)?;
    let id = project_id.to_owned();
    storage.read(move |db| projects::exists(db, &id)).await?;
    let mut results = Vec::with_capacity(paths.len());
    for path in paths {
        let name = Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let result = add_one(storage, sink, &files, project_id, &path, &name).await?;
        results.push(SourceAddResult { path, name, result });
    }
    Ok(results)
}

fn rejected(reason: RejectReason, message: impl Into<String>) -> SourceAddOutcome {
    SourceAddOutcome::Rejected {
        reason,
        message: message.into(),
    }
}

async fn add_one(
    storage: &Storage,
    sink: &impl EventSink,
    files: &ProjectFiles,
    project_id: &str,
    path: &str,
    name: &str,
) -> CommandResult<SourceAddOutcome> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    let Some(kind) = FileKind::from_extension(extension) else {
        return Ok(rejected(RejectReason::UnsupportedType, UNSUPPORTED));
    };
    if name.trim().is_empty() {
        return Ok(rejected(RejectReason::Unreadable, "Это не файл"));
    }
    let bytes = match read_file(path).await {
        Ok(bytes) => bytes,
        Err((reason, message)) => return Ok(rejected(reason, message)),
    };
    let size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    let (bytes, sha256) = tauri::async_runtime::spawn_blocking(move || {
        let sha256 = sha256_hex(&bytes);
        (bytes, sha256)
    })
    .await
    .map_err(|error| CommandError::storage(error.to_string()))?;
    if let Some(existing) = find(storage, project_id, &sha256).await? {
        return Ok(SourceAddOutcome::Duplicate { source: existing });
    }

    let source_id = new_id();
    let stored_path = files
        .stored_path(project_id, &source_id, kind.extension())
        .map_err(|error| CommandError::invalid(error.to_string()))?;
    let copy = files.clone();
    let (target, bytes) = (stored_path.clone(), bytes);
    let bytes =
        tauri::async_runtime::spawn_blocking(move || copy.write(&target, &bytes).map(|()| bytes))
            .await
            .map_err(|error| CommandError::storage(error.to_string()))?
            .map_err(|error| {
                CommandError::storage(format!("Не удалось сохранить копию документа: {error}"))
            })?;
    let extraction = extract_in_background(kind, bytes).await;

    let new = NewSource {
        id: source_id,
        project_id: project_id.to_owned(),
        name: name.to_owned(),
        extension: kind.extension().to_owned(),
        size,
        sha256: sha256.clone(),
        stored_path: stored_path.clone(),
        status: extraction.status,
        text: extraction.text,
        text_chars: extraction.text_chars,
        truncated: extraction.truncated,
        error: extraction.error,
    };
    match storage
        .write(sink, move |db| sources::insert(db, &new))
        .await
    {
        Ok(source) => Ok(SourceAddOutcome::Added { source }),
        Err(error) => {
            remove_copy(files, &stored_path);
            // The same content raced in from another add.
            if matches!(error, CommandError::Invalid { .. })
                && let Some(existing) = find(storage, project_id, &sha256).await?
            {
                return Ok(SourceAddOutcome::Duplicate { source: existing });
            }
            Err(error)
        }
    }
}

/// The file's bytes, or why it can't be added.
async fn read_file(path: &str) -> Result<Vec<u8>, (RejectReason, String)> {
    let unreadable = |error: std::io::Error| {
        (
            RejectReason::Unreadable,
            format!("Не удалось прочитать файл: {error}"),
        )
    };
    let too_large = || (RejectReason::TooLarge, "Файл больше 20 МБ".to_owned());
    let meta = tokio::fs::metadata(path).await.map_err(unreadable)?;
    if !meta.is_file() {
        return Err((RejectReason::Unreadable, "Это не файл".to_owned()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let bytes = tokio::fs::read(path).await.map_err(unreadable)?;
    // It may have grown since the check.
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

async fn find(
    storage: &Storage,
    project_id: &str,
    sha256: &str,
) -> CommandResult<Option<ProjectSource>> {
    let (project_id, sha256) = (project_id.to_owned(), sha256.to_owned());
    storage
        .read(move |db| sources::find_by_sha256(db, &project_id, &sha256))
        .await
}

fn remove_copy(files: &ProjectFiles, stored_path: &str) {
    if let Err(error) = files.remove(stored_path) {
        // The sweep at the next start removes it.
        eprintln!("grill: could not remove {stored_path}: {error}");
    }
}

/// Deletes a document and then its copy. `NotFound` for an unknown id.
pub async fn remove(storage: &Storage, sink: &impl EventSink, id: String) -> CommandResult<()> {
    let removed = storage
        .write(sink, move |db| sources::delete(db, &id))
        .await?;
    if let Ok(files) = project_files(storage) {
        remove_copy(&files, &removed.stored_path);
    }
    Ok(())
}

/// Removes a deleted project's folder (after the commit). A failure is
/// logged: the sweep at the next start removes it.
pub fn remove_project_files(storage: &Storage, project_id: &str) {
    let Ok(files) = project_files(storage) else {
        return;
    };
    if let Err(error) = files.remove_project(project_id) {
        eprintln!("grill: could not remove the files of project {project_id}: {error}");
    }
}

#[cfg(test)]
mod tests;
