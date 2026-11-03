//! The model catalog and [`ModelManager`] (design.md, decisions 1–3): which
//! Whisper models exist, where their files are and what state each is in.
//!
//! A model is installed when its file in `<app_data>/models/` has the exact
//! size of the catalog. The SHA-256 is checked once, right after the
//! download (re-reading 550 MB at every start costs too much); a download
//! in progress or paused lives in `<file>.part`.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Instant,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;
use tokio::sync::{Notify, watch};

use super::download::{self, Control, Source};
use crate::error::{CommandError, CommandResult};

/// The Whisper models the app offers.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub enum ModelId {
    /// large-v3-turbo q5_0: the main one.
    Turbo,
    /// small: the fallback for machines turbo is too slow on.
    Small,
}

impl ModelId {
    pub const ALL: [Self; 2] = [Self::Turbo, Self::Small];

    /// The value in the `speechModel` setting.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Turbo => "turbo",
            Self::Small => "small",
        }
    }

    /// `turbo` or `small`; nothing else (legacy values are read in
    /// `settings::speech_model`).
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|id| id.as_str() == value)
    }

    pub const fn spec(self) -> &'static ModelSpec {
        match self {
            Self::Turbo => &TURBO,
            Self::Small => &SMALL,
        }
    }
}

/// A model of the catalog. The size and the sum are fixed here: windows get
/// the id, the name and the size, never pass a URL.
#[derive(Debug)]
pub struct ModelSpec {
    pub name: &'static str,
    pub file_name: &'static str,
    pub url: &'static str,
    pub size: u64,
    /// Lowercase hex.
    pub sha256: &'static str,
}

impl ModelSpec {
    pub fn source(&self) -> Source {
        Source {
            url: self.url.to_owned(),
            size: self.size,
            sha256: self.sha256.to_owned(),
        }
    }
}

const TURBO: ModelSpec = ModelSpec {
    name: "Whisper large-v3-turbo",
    file_name: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    size: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
};

const SMALL: ModelSpec = ModelSpec {
    name: "Whisper small",
    file_name: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    size: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
};

/// Why a download ended in `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorReason {
    /// The file didn't match the SHA-256 (or was longer than the model); it
    /// was deleted.
    Checksum,
    /// The disk refused to write, rename or read the file.
    Io,
    /// The server answered with an error (404, 403…) or a file of another size.
    Http,
    /// The file is installed but whisper.cpp did not load it.
    Load,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ModelState {
    NotDownloaded,
    Downloading {
        /// 0–99 while downloading.
        percent: u8,
        #[serde(rename = "bytesPerSec")]
        bytes_per_sec: u64,
    },
    /// A `.part` is on disk; "Продолжить" resumes from it.
    Paused {
        percent: u8,
    },
    /// The download is complete; the sum is being checked.
    Checking,
    Ready,
    /// The download didn't start: it needs `needBytes` free (the rest of the
    /// file plus 10 % of the model), the disk has `freeBytes`.
    NoSpace {
        #[serde(rename = "needBytes")]
        need_bytes: u64,
        #[serde(rename = "freeBytes")]
        free_bytes: u64,
    },
    /// The connection broke at `percent`; the app tries again by itself in
    /// `retryInSec` seconds (10, 20, then every 30) until paused or cancelled.
    NoNetwork {
        percent: u8,
        #[serde(rename = "retryInSec")]
        retry_in_sec: u32,
    },
    Error {
        reason: ErrorReason,
        message: String,
    },
}

impl ModelState {
    pub fn error(reason: ErrorReason, message: impl Into<String>) -> Self {
        Self::Error {
            reason,
            message: message.into(),
        }
    }

    /// The states that are only what the disk says.
    const fn is_disk_state(&self) -> bool {
        matches!(
            self,
            Self::NotDownloaded | Self::Paused { .. } | Self::Ready
        )
    }
}

/// `done` of `total` in whole percent, rounded down: 100 only when complete.
pub fn percent(done: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    let share = u128::from(done.min(total)) * 100 / u128::from(total);
    u8::try_from(share).unwrap_or(100)
}

/// A model as the windows see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModel {
    pub id: ModelId,
    pub name: String,
    /// Download size.
    pub size_bytes: u64,
    pub state: ModelState,
    /// The model of the `speechModel` setting (it may be not downloaded).
    pub selected: bool,
}

/// A model's state or selection changed. To every window; progress at most
/// 4 times a second per model, other changes at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct SpeechModelChanged(pub SpeechModel);

/// Where the changes go: every window in the app, a recorder in tests.
pub trait ModelEvents: Send + Sync + 'static {
    fn changed(&self, model: &SpeechModel);
}

impl<R: Runtime> ModelEvents for AppHandle<R> {
    fn changed(&self, model: &SpeechModel) {
        if let Err(error) = SpeechModelChanged(model.clone()).emit(self) {
            eprintln!("grill: failed to emit speech-model-changed: {error}");
        }
    }
}

/// The windows, and the recognizer through `on_selected`.
struct AppEvents<R: Runtime> {
    app: AppHandle<R>,
    dir: PathBuf,
    on_selected: Box<dyn Fn(Option<PathBuf>) + Send + Sync>,
}

impl<R: Runtime> ModelEvents for AppEvents<R> {
    fn changed(&self, model: &SpeechModel) {
        self.app.changed(model);
        if model.selected {
            let installed = model.state == ModelState::Ready;
            (self.on_selected)(installed.then(|| model_file(&self.dir, model.id)));
        }
    }
}

/// Where a model downloads from; the catalog in the app, a local server in
/// tests.
pub type Catalog = Box<dyn Fn(ModelId) -> Source + Send + Sync>;

/// The file of a model in `dir`.
pub fn model_file(dir: &Path, id: ModelId) -> PathBuf {
    dir.join(id.spec().file_name)
}

/// The state of a model from the files in `dir`: the file of the exact size
/// is `ready`, a `.part` is `paused`, anything else `notDownloaded`.
pub fn detect(dir: &Path, id: ModelId, size: u64) -> ModelState {
    let file = model_file(dir, id);
    if file_len(&file) == Some(size) {
        return ModelState::Ready;
    }
    match file_len(&download::part_path(&file)) {
        Some(done) if done <= size => ModelState::Paused {
            percent: percent(done, size),
        },
        _ => ModelState::NotDownloaded,
    }
}

fn file_len(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(std::fs::Metadata::is_file)
        .map(|metadata| metadata.len())
}

fn remove_file(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Whether a state change goes to the windows now: every change of kind at
/// once, the progress of a download at most once per `interval`.
pub fn should_emit(
    before: &ModelState,
    after: &ModelState,
    emitted_at: Option<Instant>,
    now: Instant,
    interval: std::time::Duration,
) -> bool {
    if before == after {
        return false;
    }
    let progress = matches!(
        (before, after),
        (
            ModelState::Downloading { .. },
            ModelState::Downloading { .. }
        )
    );
    !progress || emitted_at.is_none_or(|at| now.duration_since(at) >= interval)
}

struct Task {
    id: u64,
    control: watch::Sender<Control>,
    /// Ends the wait for the next try after a broken connection.
    retry: Arc<Notify>,
    /// `true` once the task is over.
    done: watch::Receiver<bool>,
}

struct Slot {
    state: ModelState,
    task: Option<Task>,
    emitted_at: Option<Instant>,
}

struct Shared {
    selected: ModelId,
    slots: HashMap<ModelId, Slot>,
    next_task: u64,
}

struct Inner {
    dir: PathBuf,
    catalog: Catalog,
    config: download::Config,
    events: Box<dyn ModelEvents>,
    shared: Mutex<Shared>,
}

/// The models and their downloads, in the Tauri state. Cheap to clone.
#[derive(Clone)]
pub struct ModelManager(Arc<Inner>);

impl ModelManager {
    /// Models in `dir`, their states read from the files there. `selected`
    /// is the `speechModel` setting.
    pub fn new(
        dir: PathBuf,
        catalog: Catalog,
        config: download::Config,
        events: impl ModelEvents,
        selected: ModelId,
    ) -> Self {
        let slots = ModelId::ALL
            .into_iter()
            .map(|id| {
                let state = detect(&dir, id, catalog(id).size);
                let slot = Slot {
                    state,
                    task: None,
                    emitted_at: None,
                };
                (id, slot)
            })
            .collect();
        Self(Arc::new(Inner {
            dir,
            catalog,
            config,
            events: Box::new(events),
            shared: Mutex::new(Shared {
                selected,
                slots,
                next_task: 1,
            }),
        }))
    }

    /// The catalog of the app in `<app_data>/models/`, changes to every
    /// window. `on_selected` hears the selected model's file whenever that
    /// model changes: `Some` when it is installed, `None` when not.
    pub fn for_app<R: Runtime>(
        app: &AppHandle<R>,
        selected: ModelId,
        on_selected: impl Fn(Option<PathBuf>) + Send + Sync + 'static,
    ) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("models");
        Self::new(
            dir.clone(),
            Box::new(|id| id.spec().source()),
            download::Config::official(),
            AppEvents {
                app: app.clone(),
                dir,
                on_selected: Box::new(on_selected),
            },
            selected,
        )
    }

    /// Both models, in catalog order. Idle models are read from the disk
    /// again first: a file deleted by hand is `notDownloaded`.
    pub fn list(&self) -> Vec<SpeechModel> {
        let mut shared = self.0.lock();
        ModelId::ALL
            .into_iter()
            .map(|id| {
                self.0.refresh(&mut shared, id);
                self.0.model(&shared, id)
            })
            .collect()
    }

    pub fn get(&self, id: ModelId) -> SpeechModel {
        let mut shared = self.0.lock();
        self.0.refresh(&mut shared, id);
        self.0.model(&shared, id)
    }

    /// The `speechModel` setting as the manager knows it.
    pub fn selected(&self) -> ModelId {
        self.0.lock().selected
    }

    /// The file to load, when the model is installed (file of the exact
    /// size, no download running). A file gone since is noticed here.
    pub fn model_path(&self, id: ModelId) -> Option<PathBuf> {
        let mut shared = self.0.lock();
        self.0.refresh(&mut shared, id);
        (shared.slots[&id].state == ModelState::Ready).then(|| model_file(&self.0.dir, id))
    }

    /// [`Self::model_path`] of the selected model.
    pub fn selected_path(&self) -> Option<PathBuf> {
        self.model_path(self.selected())
    }

    /// Starts (or resumes) the download in the background. A model that is
    /// ready or already downloading stays as it is; one waiting to retry
    /// after a broken connection (`noNetwork`) retries at once.
    pub fn download(&self, id: ModelId) -> SpeechModel {
        let mut shared = self.0.lock();
        self.0.refresh(&mut shared, id);
        let slot = &shared.slots[&id];
        if let (Some(task), ModelState::NoNetwork { percent, .. }) = (&slot.task, &slot.state) {
            task.retry.notify_one();
            let percent = *percent;
            self.0.set_state(
                &mut shared,
                id,
                ModelState::Downloading {
                    percent,
                    bytes_per_sec: 0,
                },
            );
            return self.0.model(&shared, id);
        }
        if slot.task.is_some() || slot.state == ModelState::Ready {
            return self.0.model(&shared, id);
        }
        let task_id = shared.next_task;
        shared.next_task += 1;
        let (control, control_rx) = watch::channel(Control::Run);
        let retry = Arc::new(Notify::new());
        let (done_tx, done) = watch::channel(false);
        let source = (self.0.catalog)(id);
        let file = model_file(&self.0.dir, id);
        let start = match detect(&self.0.dir, id, source.size) {
            ModelState::Paused { percent } => percent,
            _ => 0,
        };
        if let Some(slot) = shared.slots.get_mut(&id) {
            slot.task = Some(Task {
                id: task_id,
                control,
                retry: Arc::clone(&retry),
                done,
            });
        }
        self.0.set_state(
            &mut shared,
            id,
            ModelState::Downloading {
                percent: start,
                bytes_per_sec: 0,
            },
        );
        let model = self.0.model(&shared, id);
        drop(shared);

        let inner = Arc::clone(&self.0);
        tauri::async_runtime::spawn(async move {
            let guard = TaskGuard {
                inner: Arc::clone(&inner),
                model: id,
                task: task_id,
                done: done_tx,
            };
            if let Err(error) = std::fs::create_dir_all(&inner.dir) {
                inner.finish(
                    id,
                    task_id,
                    ModelState::error(
                        ErrorReason::Io,
                        format!("Не удалось создать папку моделей: {error}"),
                    ),
                );
                return;
            }
            let end = download::run(&source, &file, &inner.config, control_rx, &retry, |state| {
                inner.report(id, task_id, state);
            })
            .await;
            inner.finish(id, task_id, end);
            drop(guard);
        });
        model
    }

    /// "Пауза": stops the download and keeps the `.part`. Returns once the
    /// download stopped. A download that is already being checked finishes.
    pub async fn pause(&self, id: ModelId) -> SpeechModel {
        self.stop(id, Control::Pause).await;
        self.get(id)
    }

    /// "Отменить": stops the download (or drops a paused one) and deletes
    /// the `.part`. A ready model stays.
    pub async fn cancel(&self, id: ModelId) -> CommandResult<SpeechModel> {
        let file = model_file(&self.0.dir, id);
        self.stop_and(id, |inner, shared| {
            remove_file(&download::part_path(&file)).map_err(|error| {
                CommandError::storage(format!("Не удалось удалить недокачанный файл: {error}"))
            })?;
            let state = detect(&inner.dir, id, (inner.catalog)(id).size);
            inner.set_state(shared, id, state);
            Ok(())
        })
        .await?;
        Ok(self.get(id))
    }

    /// Stops the download of `id` (a cancel: the task deletes its `.part`),
    /// then runs `idle` with no download running. Under the lock, so a
    /// download started meanwhile is stopped first and none starts during
    /// `idle`: deleting files never races a running download.
    async fn stop_and(
        &self,
        id: ModelId,
        idle: impl FnOnce(&Inner, &mut Shared) -> CommandResult<()>,
    ) -> CommandResult<()> {
        loop {
            self.stop(id, Control::Cancel).await;
            let mut shared = self.0.lock();
            if shared.slots[&id].task.is_none() {
                return idle(&self.0, &mut shared);
            }
        }
    }

    /// "Удалить": stops a download and deletes the model's files. The
    /// selected model can't be removed while recording (`Invalid`).
    pub async fn remove(&self, id: ModelId, recording: bool) -> CommandResult<SpeechModel> {
        if recording && self.selected() == id {
            return Err(CommandError::invalid(
                "Нельзя удалить выбранную модель во время записи",
            ));
        }
        let file = model_file(&self.0.dir, id);
        self.stop_and(id, |inner, shared| {
            for path in [download::part_path(&file), file] {
                remove_file(&path).map_err(|error| {
                    CommandError::storage(format!("Не удалось удалить модель: {error}"))
                })?;
            }
            inner.set_state(shared, id, ModelState::NotDownloaded);
            Ok(())
        })
        .await?;
        Ok(self.get(id))
    }

    /// Whether `id` may become the selected model: it must be ready, and
    /// another model can't be chosen while recording (`Invalid`).
    /// Choosing the selected one again is always fine.
    pub fn check_select(&self, id: ModelId, recording: bool) -> CommandResult<()> {
        let mut shared = self.0.lock();
        if shared.selected == id {
            return Ok(());
        }
        if recording {
            return Err(CommandError::invalid(
                "Нельзя сменить модель во время записи",
            ));
        }
        self.0.refresh(&mut shared, id);
        if shared.slots[&id].state != ModelState::Ready {
            return Err(CommandError::invalid("Модель ещё не скачана"));
        }
        Ok(())
    }

    /// Remembers the selected model (after `speechModel` is stored) and tells
    /// the windows about both models whose `selected` changed.
    pub fn set_selected(&self, id: ModelId) {
        let mut shared = self.0.lock();
        let before = shared.selected;
        if before == id {
            return;
        }
        shared.selected = id;
        for changed in [before, id] {
            self.0.events.changed(&self.0.model(&shared, changed));
        }
    }

    /// The model is installed but doesn't work (whisper.cpp refused to load
    /// it): `error` until it is downloaded again or removed.
    pub fn set_error(&self, id: ModelId, reason: ErrorReason, message: impl Into<String>) {
        let mut shared = self.0.lock();
        if shared.slots[&id].task.is_none() {
            self.0
                .set_state(&mut shared, id, ModelState::error(reason, message));
        }
    }

    /// Sends `control` to a running download and waits until it ended.
    /// `false` when none was running.
    async fn stop(&self, id: ModelId, control: Control) -> bool {
        let done = {
            let shared = self.0.lock();
            let Some(task) = &shared.slots[&id].task else {
                return false;
            };
            // Ignored when the task already returned.
            let _ = task.control.send(control);
            task.done.clone()
        };
        let mut done = done;
        let _ = done.wait_for(|done| *done).await;
        true
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn model(&self, shared: &Shared, id: ModelId) -> SpeechModel {
        let spec = id.spec();
        SpeechModel {
            id,
            name: spec.name.to_owned(),
            size_bytes: (self.catalog)(id).size,
            state: shared.slots[&id].state.clone(),
            selected: shared.selected == id,
        }
    }

    /// Reads an idle model from the disk again; errors and `noSpace` stay
    /// until the user acts.
    fn refresh(&self, shared: &mut Shared, id: ModelId) {
        let slot = &shared.slots[&id];
        if slot.task.is_some() || !slot.state.is_disk_state() {
            return;
        }
        let state = detect(&self.dir, id, (self.catalog)(id).size);
        self.set_state(shared, id, state);
    }

    fn set_state(&self, shared: &mut Shared, id: ModelId, state: ModelState) {
        let now = Instant::now();
        let interval = self.config.progress_interval;
        let Some(slot) = shared.slots.get_mut(&id) else {
            return;
        };
        let emit = should_emit(&slot.state, &state, slot.emitted_at, now, interval);
        slot.state = state;
        if emit {
            slot.emitted_at = Some(now);
            // Under the lock, so the windows get the changes in order.
            self.events.changed(&self.model(shared, id));
        }
    }

    /// A state from the download task `task`; a stale task is ignored.
    fn report(&self, id: ModelId, task: u64, state: ModelState) {
        let mut shared = self.lock();
        if shared.slots[&id]
            .task
            .as_ref()
            .is_some_and(|t| t.id == task)
        {
            self.set_state(&mut shared, id, state);
        }
    }

    /// The end of the download task `task`: its last state, and the model is
    /// idle again.
    fn finish(&self, id: ModelId, task: u64, state: ModelState) {
        let mut shared = self.lock();
        let Some(slot) = shared.slots.get_mut(&id) else {
            return;
        };
        if slot.task.as_ref().is_some_and(|t| t.id == task) {
            slot.task = None;
            self.set_state(&mut shared, id, state);
        }
    }
}

/// Marks the task over even if it panicked: the model is idle again, read
/// from the disk, and `pause` / `cancel` stop waiting.
struct TaskGuard {
    inner: Arc<Inner>,
    model: ModelId,
    task: u64,
    done: watch::Sender<bool>,
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        let size = (self.inner.catalog)(self.model).size;
        let state = detect(&self.inner.dir, self.model, size);
        self.inner.finish(self.model, self.task, state);
        let _ = self.done.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_both_models() {
        assert_eq!(ModelId::Turbo.spec().size, 574_041_195);
        assert_eq!(ModelId::Small.spec().size, 487_601_967);
        for id in ModelId::ALL {
            let spec = id.spec();
            assert!(
                spec.url
                    .starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/")
            );
            assert!(spec.url.ends_with(spec.file_name));
            assert_eq!(spec.sha256.len(), 64);
            assert!(
                spec.sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            );
            assert_eq!(ModelId::parse(id.as_str()), Some(id));
        }
        assert_eq!(ModelId::parse("whisper"), None);
        assert_eq!(
            serde_json::to_value(ModelId::Turbo).unwrap(),
            serde_json::json!("turbo")
        );
    }

    #[test]
    fn state_is_read_from_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let id = ModelId::Small;
        let size = 1000;
        let file = model_file(dir.path(), id);
        let part = download::part_path(&file);
        assert_eq!(detect(dir.path(), id, size), ModelState::NotDownloaded);

        std::fs::write(&part, vec![0; 400]).unwrap();
        assert_eq!(
            detect(dir.path(), id, size),
            ModelState::Paused { percent: 40 }
        );
        std::fs::write(&part, vec![0; 1500]).unwrap();
        assert_eq!(
            detect(dir.path(), id, size),
            ModelState::NotDownloaded,
            "a .part longer than the model is no progress"
        );
        std::fs::remove_file(&part).unwrap();

        std::fs::write(&file, vec![0; 999]).unwrap();
        assert_eq!(
            detect(dir.path(), id, size),
            ModelState::NotDownloaded,
            "wrong size"
        );
        std::fs::write(&file, vec![0; 1000]).unwrap();
        assert_eq!(detect(dir.path(), id, size), ModelState::Ready);
        assert_eq!(
            detect(dir.path(), ModelId::Turbo, size),
            ModelState::NotDownloaded,
            "another model's file"
        );
    }

    #[test]
    fn percent_is_whole_and_reaches_100_only_at_the_end() {
        assert_eq!(percent(0, 0), 0);
        assert_eq!(percent(0, 574_041_195), 0);
        assert_eq!(percent(574_041_194, 574_041_195), 99);
        assert_eq!(percent(574_041_195, 574_041_195), 100);
        assert_eq!(percent(2_000, 1_000), 100);
        assert_eq!(percent(400, 1_000), 40);
    }

    #[test]
    fn progress_is_throttled_but_transitions_are_not() {
        let interval = std::time::Duration::from_millis(250);
        let start = Instant::now();
        let later = start + std::time::Duration::from_millis(100);
        let much_later = start + interval;
        let downloading = |percent| ModelState::Downloading {
            percent,
            bytes_per_sec: 1,
        };
        assert!(should_emit(
            &ModelState::NotDownloaded,
            &downloading(0),
            None,
            start,
            interval
        ));
        assert!(!should_emit(
            &downloading(0),
            &downloading(1),
            Some(start),
            later,
            interval
        ));
        assert!(should_emit(
            &downloading(0),
            &downloading(1),
            Some(start),
            much_later,
            interval
        ));
        assert!(should_emit(
            &downloading(5),
            &ModelState::Paused { percent: 5 },
            Some(start),
            later,
            interval
        ));
        assert!(should_emit(
            &downloading(99),
            &ModelState::Checking,
            Some(start),
            later,
            interval
        ));
        assert!(!should_emit(
            &ModelState::Ready,
            &ModelState::Ready,
            None,
            later,
            interval
        ));
    }

    #[test]
    fn states_serialize_as_a_tagged_union() {
        let json = |state: ModelState| serde_json::to_value(state).unwrap();
        assert_eq!(
            json(ModelState::NotDownloaded),
            serde_json::json!({ "status": "notDownloaded" })
        );
        assert_eq!(
            json(ModelState::Downloading {
                percent: 40,
                bytes_per_sec: 5_000_000
            }),
            serde_json::json!({ "status": "downloading", "percent": 40, "bytesPerSec": 5_000_000 })
        );
        assert_eq!(
            json(ModelState::NoSpace {
                need_bytes: 2,
                free_bytes: 1
            }),
            serde_json::json!({ "status": "noSpace", "needBytes": 2, "freeBytes": 1 })
        );
        assert_eq!(
            json(ModelState::NoNetwork {
                percent: 60,
                retry_in_sec: 10
            }),
            serde_json::json!({ "status": "noNetwork", "percent": 60, "retryInSec": 10 })
        );
        assert_eq!(
            json(ModelState::error(ErrorReason::Checksum, "x")),
            serde_json::json!({ "status": "error", "reason": "checksum", "message": "x" })
        );
        let model = SpeechModel {
            id: ModelId::Small,
            name: "Whisper small".to_owned(),
            size_bytes: 1,
            state: ModelState::Ready,
            selected: true,
        };
        assert_eq!(
            serde_json::to_value(SpeechModelChanged(model)).unwrap(),
            serde_json::json!({
                "id": "small",
                "name": "Whisper small",
                "sizeBytes": 1,
                "state": { "status": "ready" },
                "selected": true,
            })
        );
    }
}
