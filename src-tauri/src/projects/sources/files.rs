//! Where the copies of the project's documents live
//! (projects-people-brief design.md, decision 1):
//! `<app data>/projects/<projectId>/sources/<sourceId>.<ext>`. The database
//! stores the path relative to the app data folder.

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

use rusqlite::Connection;

use crate::{error::CommandResult, storage::sources};

/// Folder of the projects' files inside the app data folder.
pub const PROJECTS_DIR: &str = "projects";
/// Folder of a project's documents inside its folder.
pub const SOURCES_DIR: &str = "sources";

/// The documents' copies under one app data folder.
#[derive(Debug, Clone)]
pub struct ProjectFiles {
    data_dir: PathBuf,
}

fn uuid(id: &str) -> io::Result<()> {
    uuid::Uuid::parse_str(id).map(|_| ()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a project or document id: {id}"),
        )
    })
}

fn ignore_missing(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

impl ProjectFiles {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_owned(),
        }
    }

    fn root(&self) -> PathBuf {
        self.data_dir.join(PROJECTS_DIR)
    }

    /// The stored (relative) path of a new document. The ids must be UUIDs
    /// and the extension one of ours, so the path stays in its folder.
    pub fn stored_path(
        &self,
        project_id: &str,
        source_id: &str,
        extension: &str,
    ) -> io::Result<String> {
        uuid(project_id)?;
        uuid(source_id)?;
        if !extension.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("not an extension: {extension}"),
            ));
        }
        Ok(format!(
            "{PROJECTS_DIR}/{project_id}/{SOURCES_DIR}/{source_id}.{extension}"
        ))
    }

    /// The absolute path of a stored path; only paths under `projects/`
    /// without `..` resolve.
    pub fn resolve(&self, stored_path: &str) -> io::Result<PathBuf> {
        let mut parts = stored_path.split('/');
        let inside = parts.next() == Some(PROJECTS_DIR)
            && parts.clone().count() == 3
            && parts.all(|part| !part.is_empty() && part != "." && part != "..");
        if !inside {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("not a document path: {stored_path}"),
            ));
        }
        Ok(stored_path
            .split('/')
            .fold(self.data_dir.clone(), |path, part| path.join(part)))
    }

    /// Writes the copy of a new document.
    pub fn write(&self, stored_path: &str, bytes: &[u8]) -> io::Result<()> {
        let path = self.resolve(stored_path)?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, bytes)
    }

    /// Removes a document's copy; nothing to remove is fine.
    pub fn remove(&self, stored_path: &str) -> io::Result<()> {
        ignore_missing(fs::remove_file(self.resolve(stored_path)?))
    }

    /// Removes the project's folder; nothing to remove is fine.
    pub fn remove_project(&self, project_id: &str) -> io::Result<()> {
        uuid(project_id)?;
        ignore_missing(fs::remove_dir_all(self.root().join(project_id)))
    }

    /// Removes the folders of projects not in `projects` and the documents
    /// not in `paths` (stored paths). Returns what it removed, as stored
    /// paths or `projects/<id>`. Anything not named like ours stays.
    pub fn sweep(
        &self,
        paths: &HashSet<String>,
        projects: &HashSet<String>,
    ) -> io::Result<Vec<String>> {
        let entries = match fs::read_dir(self.root()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut removed = Vec::new();
        for entry in entries {
            let entry = entry?;
            let Some(project_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !entry.file_type()?.is_dir() || uuid(&project_id).is_err() {
                continue;
            }
            if !projects.contains(&project_id) {
                match fs::remove_dir_all(entry.path()) {
                    Ok(()) => removed.push(format!("{PROJECTS_DIR}/{project_id}")),
                    Err(error) => {
                        eprintln!(
                            "grill: could not remove the files of project {project_id}: {error}"
                        );
                    }
                }
                continue;
            }
            let documents = match fs::read_dir(entry.path().join(SOURCES_DIR)) {
                Ok(documents) => documents,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            for document in documents {
                let document = document?;
                let Some(name) = document.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if !document.file_type()?.is_file() {
                    continue;
                }
                let stored = format!("{PROJECTS_DIR}/{project_id}/{SOURCES_DIR}/{name}");
                if paths.contains(&stored) {
                    continue;
                }
                match fs::remove_file(document.path()) {
                    Ok(()) => removed.push(stored),
                    Err(error) => eprintln!("grill: could not remove {stored}: {error}"),
                }
            }
        }
        removed.sort();
        Ok(removed)
    }
}

/// Removes the copies without a row and the folders of deleted projects
/// (at every open, like the recordings' sweep). Runs under the caller's
/// connection.
pub fn sweep(connection: &Connection, data_dir: &Path) -> CommandResult<Vec<String>> {
    let (paths, projects) = sources::known_files(connection)?;
    ProjectFiles::new(data_dir)
        .sweep(&paths, &projects)
        .map_err(|error| {
            crate::error::CommandError::storage(format!(
                "Не удалось убрать файлы документов: {error}"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "0190d1a0-0000-7000-8000-000000000001";
    const GONE: &str = "0190d1a0-0000-7000-8000-000000000002";
    const KEPT: &str = "0190d1a0-0000-7000-8000-00000000000a";
    const ORPHAN: &str = "0190d1a0-0000-7000-8000-00000000000b";

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn stored_paths_stay_in_the_projects_folder() {
        let dir = tempfile::tempdir().unwrap();
        let files = ProjectFiles::new(dir.path());
        assert_eq!(
            files.stored_path(PROJECT, KEPT, "pdf").unwrap(),
            format!("projects/{PROJECT}/sources/{KEPT}.pdf")
        );
        assert!(files.stored_path("../x", KEPT, "pdf").is_err());
        assert!(files.stored_path(PROJECT, KEPT, "p/df").is_err());
        for path in [
            "recordings/x/me.opus",
            "projects/../grill.db",
            "projects/a/sources/../../x",
            "projects/a/b",
            "/etc/passwd",
        ] {
            assert!(files.resolve(path).is_err(), "{path}");
            assert!(files.remove(path).is_err(), "{path}");
        }
        assert!(files.remove_project("..").is_err());
    }

    #[test]
    fn sweep_removes_orphans_and_folders_of_deleted_projects() {
        let dir = tempfile::tempdir().unwrap();
        let files = ProjectFiles::new(dir.path());
        let kept = files.stored_path(PROJECT, KEPT, "md").unwrap();
        let orphan = files.stored_path(PROJECT, ORPHAN, "pdf").unwrap();
        let of_gone = files.stored_path(GONE, KEPT, "md").unwrap();
        for path in [&kept, &orphan, &of_gone] {
            files.write(path, b"x").unwrap();
        }
        fs::write(dir.path().join(PROJECTS_DIR).join("notes.txt"), b"x").unwrap();
        fs::create_dir_all(dir.path().join(PROJECTS_DIR).join("not-a-uuid")).unwrap();

        let removed = files.sweep(&set(&[&kept]), &set(&[PROJECT])).unwrap();

        let mut expected = vec![format!("projects/{GONE}"), orphan.clone()];
        expected.sort();
        assert_eq!(removed, expected);
        assert!(files.resolve(&kept).unwrap().exists());
        assert!(!files.resolve(&orphan).unwrap().exists());
        assert!(!dir.path().join(PROJECTS_DIR).join(GONE).exists());
        assert!(dir.path().join(PROJECTS_DIR).join("notes.txt").exists());
        assert!(dir.path().join(PROJECTS_DIR).join("not-a-uuid").exists());
    }

    #[test]
    fn sweep_without_a_projects_folder_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let files = ProjectFiles::new(dir.path());
        assert!(files.sweep(&set(&[]), &set(&[])).unwrap().is_empty());
    }

    #[test]
    fn removing_twice_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let files = ProjectFiles::new(dir.path());
        let path = files.stored_path(PROJECT, KEPT, "txt").unwrap();
        files.write(&path, b"x").unwrap();
        files.remove(&path).unwrap();
        files.remove(&path).unwrap();
        files.remove_project(PROJECT).unwrap();
        files.remove_project(PROJECT).unwrap();
        assert!(!dir.path().join(PROJECTS_DIR).join(PROJECT).exists());
    }
}
