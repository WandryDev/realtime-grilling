//! Where the channel files of a recording live (audio-capture design.md,
//! decision 12). One implementation for now, [`LocalStore`]:
//! `<app data>/recordings/<id>/{me,others}.opus`. Paths never leave Rust.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use crate::storage::recordings::RecordingFiles;

/// Folder of the recordings inside the app data folder.
pub const RECORDINGS_DIR: &str = "recordings";
pub const ME_FILE: &str = "me.opus";
pub const OTHERS_FILE: &str = "others.opus";

/// A channel file being written: buffered writes, `flush` hands them to the
/// OS, `sync` makes them durable.
pub trait ChannelSink: Write + Send {
    /// Flushes and waits until the written bytes are on the disk.
    fn sync(&mut self) -> io::Result<()>;
}

impl ChannelSink for BufWriter<File> {
    fn sync(&mut self) -> io::Result<()> {
        self.flush()?;
        self.get_ref().sync_data()
    }
}

impl<S: ChannelSink + ?Sized> ChannelSink for Box<S> {
    fn sync(&mut self) -> io::Result<()> {
        (**self).sync()
    }
}

/// In memory, for tests.
impl ChannelSink for Vec<u8> {
    fn sync(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The two channel files of a new recording.
pub struct ChannelWriters {
    pub me: Box<dyn ChannelSink>,
    pub others: Box<dyn ChannelSink>,
}

/// Storage of the recordings' files, keyed by the recording id.
pub trait RecordingStore: Send + Sync {
    /// The channel files of `id`, as the database stores them.
    fn files(&self, id: &str) -> RecordingFiles;

    /// Creates the files of a new recording and returns their writers. The
    /// recording is live until [`Self::finish`] or [`Self::delete`]:
    /// [`Self::sweep`] leaves it alone even without a row.
    fn create(&self, id: &str) -> io::Result<ChannelWriters>;

    /// The writers were finalized and dropped: the recording is complete.
    fn finish(&self, id: &str) -> io::Result<()>;

    /// Removes the files of `id`; nothing to remove is fine.
    fn delete(&self, id: &str) -> io::Result<()>;

    /// Removes every recording that is neither in `known_ids` nor live, and
    /// returns their ids. A recording that fails to go is logged and kept for
    /// the next sweep.
    fn sweep(&self, known_ids: &HashSet<String>) -> io::Result<Vec<String>>;
}

/// Recordings on this computer, under the app data folder.
pub struct LocalStore {
    data_dir: PathBuf,
    live: Mutex<HashSet<String>>,
}

impl LocalStore {
    /// `data_dir` is the app data folder; the recordings go to its
    /// `recordings` subfolder, created on the first recording.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_owned(),
            live: Mutex::new(HashSet::new()),
        }
    }

    fn root(&self) -> PathBuf {
        self.data_dir.join(RECORDINGS_DIR)
    }

    /// The folder of a recording. The id must be a UUID, so a path can't
    /// escape the recordings folder.
    fn dir(&self, id: &str) -> io::Result<PathBuf> {
        uuid::Uuid::parse_str(id).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("not a recording id: {id}"),
            )
        })?;
        Ok(self.root().join(id))
    }

    fn live(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn create_file(path: &Path) -> io::Result<Box<dyn ChannelSink>> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    Ok(Box::new(BufWriter::new(file)))
}

impl RecordingStore for LocalStore {
    fn files(&self, id: &str) -> RecordingFiles {
        RecordingFiles {
            me: format!("{RECORDINGS_DIR}/{id}/{ME_FILE}"),
            others: format!("{RECORDINGS_DIR}/{id}/{OTHERS_FILE}"),
        }
    }

    fn create(&self, id: &str) -> io::Result<ChannelWriters> {
        let dir = self.dir(id)?;
        fs::create_dir_all(&dir)?;
        self.live().insert(id.to_owned());
        let writers = create_file(&dir.join(ME_FILE)).and_then(|me| {
            Ok(ChannelWriters {
                me,
                others: create_file(&dir.join(OTHERS_FILE))?,
            })
        });
        if writers.is_err() {
            self.live().remove(id);
        }
        writers
    }

    fn finish(&self, id: &str) -> io::Result<()> {
        self.live().remove(id);
        Ok(())
    }

    fn delete(&self, id: &str) -> io::Result<()> {
        let dir = self.dir(id)?;
        self.live().remove(id);
        match fs::remove_dir_all(dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    fn sweep(&self, known_ids: &HashSet<String>) -> io::Result<Vec<String>> {
        let entries = match fs::read_dir(self.root()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let live = self.live().clone();
        let mut removed = Vec::new();
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if known_ids.contains(&name) || live.contains(&name) {
                continue;
            }
            match fs::remove_dir_all(entry.path()) {
                Ok(()) => removed.push(name),
                Err(error) => eprintln!("grill: could not remove recording {name}: {error}"),
            }
        }
        removed.sort();
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: &str = "0190d1a0-0000-7000-8000-000000000001";
    const KEPT: &str = "0190d1a0-0000-7000-8000-000000000002";
    const ORPHAN: &str = "0190d1a0-0000-7000-8000-000000000003";

    fn known(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn creates_both_channel_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path());
        let mut writers = store.create(KEPT).unwrap();
        writers.me.write_all(b"me").unwrap();
        writers.others.write_all(b"others").unwrap();
        writers.me.sync().unwrap();
        writers.others.sync().unwrap();
        drop(writers);
        store.finish(KEPT).unwrap();

        let files = store.files(KEPT);
        assert_eq!(files.me, format!("recordings/{KEPT}/me.opus"));
        assert_eq!(fs::read(dir.path().join(&files.me)).unwrap(), b"me");
        assert_eq!(fs::read(dir.path().join(&files.others)).unwrap(), b"others");
        // An id is used once.
        assert!(store.create(KEPT).is_err());
    }

    #[test]
    fn refuses_ids_that_are_not_uuids() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path());
        for id in ["../escape", "", "a/b"] {
            assert!(store.create(id).is_err(), "{id}");
            assert!(store.delete(id).is_err(), "{id}");
        }
        assert!(!dir.path().join("escape").exists());
    }

    #[test]
    fn sweep_removes_orphans_and_keeps_known_and_live() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path());
        for id in [KEPT, ORPHAN] {
            drop(store.create(id).unwrap());
            store.finish(id).unwrap();
        }
        // Still being written and its row is gone (its call was deleted).
        let writers = store.create(LIVE).unwrap();
        fs::write(dir.path().join(RECORDINGS_DIR).join("notes.txt"), b"x").unwrap();

        let removed = store.sweep(&known(&[KEPT])).unwrap();

        assert_eq!(removed, vec![ORPHAN.to_owned()]);
        let root = dir.path().join(RECORDINGS_DIR);
        assert!(!root.join(ORPHAN).exists());
        assert!(root.join(KEPT).join(ME_FILE).exists());
        assert!(root.join(LIVE).join(OTHERS_FILE).exists());
        assert!(root.join("notes.txt").exists());

        // Once finished, a recording without a row goes too.
        drop(writers);
        store.finish(LIVE).unwrap();
        assert_eq!(store.sweep(&known(&[KEPT])).unwrap(), vec![LIVE.to_owned()]);
    }

    #[test]
    fn sweep_without_a_recordings_folder_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path());
        assert!(store.sweep(&known(&[])).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::new(dir.path());
        drop(store.create(KEPT).unwrap());
        store.delete(KEPT).unwrap();
        assert!(!dir.path().join(RECORDINGS_DIR).join(KEPT).exists());
        store.delete(KEPT).unwrap();
    }
}
