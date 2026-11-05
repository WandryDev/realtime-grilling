//! Playing a recording (post-call design.md, decisions 9–10): its channel
//! files decoded to WAV in a temporary cache, the waveform's peaks, and
//! deleting the audio of a call.
//!
//! WebKit takes the duration of an Ogg Opus file from its size, so the
//! player gets WAV (`docs/spikes/audio-playback.md`): 16 kHz, 16 bit,
//! mono, ~115 MB per hour and channel. A channel is decoded once, on its
//! first request; the cache goes when the app exits and when the audio is
//! deleted. Paths never leave Rust.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use serde::Serialize;
use specta::Type;

use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity, EventSink},
    recording::{SAMPLE_RATE, ogg_opus, store::RecordingStore},
    speech::refiner::Refiner,
    storage::{
        Storage,
        calls::{self, CallStatus},
        now_ms,
        recordings::{self, Recording, RecordingState},
        transcript::TranscriptChannel,
    },
};

/// The cache folder in the system's temporary folder.
pub const CACHE_DIR: &str = "grill-audio";
/// The most bars of a waveform.
pub const MAX_BARS: u32 = 2_000;
/// A WAV header of PCM data.
const WAV_HEADER: usize = 44;

/// The channel files of a stopped recording that has its audio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Playable {
    pub me: PathBuf,
    pub others: PathBuf,
}

impl Playable {
    pub fn file(&self, channel: TranscriptChannel) -> &Path {
        match channel {
            TranscriptChannel::Me => &self.me,
            TranscriptChannel::Others => &self.others,
        }
    }
}

/// What may be played of a recording: `None` for an unknown one, one being
/// written, or one whose audio was deleted.
pub fn playable(recording: &Recording, data_dir: &Path) -> Option<Playable> {
    (recording.status != RecordingState::Recording && recording.audio_deleted_at.is_none()).then(
        || Playable {
            me: data_dir.join(&recording.files.me),
            others: data_dir.join(&recording.files.others),
        },
    )
}

/// [`playable`] of the recording `id` in the app's storage.
pub fn playable_in(storage: &Storage, id: &str) -> Option<Playable> {
    let dir = storage.data_dir()?;
    let recording = storage
        .read_now(|connection| recordings::get(connection, id))
        .ok()?;
    playable(&recording, dir)
}

/// The waveform of a recording: the loudest sample of each bar, 0–1, per
/// channel. Both channels have `bars` bars over the longer one's length,
/// so the bars line up in time.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPeaks {
    /// Of the longer channel.
    pub duration_ms: i64,
    pub me: Vec<f32>,
    pub others: Vec<f32>,
}

struct Inner {
    dir: PathBuf,
    /// One lock per WAV file: a channel decodes once, and forgetting it
    /// waits for a decode that runs.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    peaks: Mutex<HashMap<(String, u32), RecordingPeaks>>,
}

/// The WAV files and peaks of the recordings played since the start.
/// Tauri state; cheap to clone.
#[derive(Clone)]
pub struct AudioCache(Arc<Inner>);

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn channel_name(channel: TranscriptChannel) -> &'static str {
    match channel {
        TranscriptChannel::Me => "me",
        TranscriptChannel::Others => "others",
    }
}

impl AudioCache {
    /// A cache in `dir`; what a previous run left there goes.
    pub fn new(dir: PathBuf) -> Self {
        if let Err(error) = fs::remove_dir_all(&dir)
            && error.kind() != io::ErrorKind::NotFound
        {
            eprintln!("grill: audio cache not cleared: {error}");
        }
        Self(Arc::new(Inner {
            dir,
            locks: Mutex::new(HashMap::new()),
            peaks: Mutex::new(HashMap::new()),
        }))
    }

    /// The app's cache, in the system's temporary folder.
    pub fn for_app() -> Self {
        Self::new(std::env::temp_dir().join(CACHE_DIR))
    }

    fn lock(&self, key: &str) -> Arc<Mutex<()>> {
        Arc::clone(guard(&self.0.locks).entry(key.to_owned()).or_default())
    }

    fn path(&self, key: &str) -> PathBuf {
        self.0.dir.join(format!("{key}.wav"))
    }

    /// The WAV of a channel of `recording_id` decoded from `source`, decoded
    /// now if it is not cached yet. `InvalidInput` for an id that is not a
    /// UUID; the source's error when it can't be read.
    pub fn wav(
        &self,
        recording_id: &str,
        channel: TranscriptChannel,
        source: &Path,
    ) -> io::Result<PathBuf> {
        uuid::Uuid::parse_str(recording_id)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "not a recording id"))?;
        let key = format!("{recording_id}-{}", channel_name(channel));
        let path = self.path(&key);
        let lock = self.lock(&key);
        let _decoding = guard(&lock);
        if path.exists() {
            return Ok(path);
        }
        let samples = ogg_opus::read_file(source)?;
        fs::create_dir_all(&self.0.dir)?;
        let part = path.with_extension("wav.part");
        write_wav(&part, &samples)?;
        fs::rename(&part, &path)?;
        Ok(path)
    }

    /// The peaks of a recording, from its WAV files (decoded if needed),
    /// cached. `bars` must be 1–[`MAX_BARS`].
    pub fn peaks(
        &self,
        recording_id: &str,
        playable: &Playable,
        bars: u32,
    ) -> io::Result<RecordingPeaks> {
        let key = (recording_id.to_owned(), bars);
        if let Some(peaks) = guard(&self.0.peaks).get(&key) {
            return Ok(peaks.clone());
        }
        let me = self.wav(recording_id, TranscriptChannel::Me, &playable.me)?;
        let others = self.wav(recording_id, TranscriptChannel::Others, &playable.others)?;
        let lengths = [wav_samples(&me)?, wav_samples(&others)?];
        let longest = lengths[0].max(lengths[1]);
        let per_bar = longest.div_ceil(u64::from(bars)).max(1);
        let peaks = RecordingPeaks {
            duration_ms: i64::try_from(longest * 1_000 / u64::from(SAMPLE_RATE))
                .unwrap_or(i64::MAX),
            me: wav_peaks(&me, bars, per_bar)?,
            others: wav_peaks(&others, bars, per_bar)?,
        };
        guard(&self.0.peaks).insert(key, peaks.clone());
        Ok(peaks)
    }

    /// Drops the WAV files and the peaks of a recording (its audio was
    /// deleted). Waits for a decode of it that runs.
    pub fn forget(&self, recording_id: &str) {
        for channel in [TranscriptChannel::Me, TranscriptChannel::Others] {
            let key = format!("{recording_id}-{}", channel_name(channel));
            let lock = self.lock(&key);
            let _decoding = guard(&lock);
            match fs::remove_file(self.path(&key)) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    eprintln!("grill: cached audio of {recording_id} not removed: {error}");
                }
                _ => {}
            }
        }
        guard(&self.0.peaks).retain(|(id, _), _| id != recording_id);
    }

    /// The app exits: the whole cache goes.
    pub fn clear(&self) {
        guard(&self.0.peaks).clear();
        if let Err(error) = fs::remove_dir_all(&self.0.dir)
            && error.kind() != io::ErrorKind::NotFound
        {
            eprintln!("grill: audio cache not cleared: {error}");
        }
    }
}

/// A 16 kHz 16-bit mono WAV of `samples`.
fn write_wav(path: &Path, samples: &[f32]) -> io::Result<()> {
    let data = u32::try_from(samples.len() * 2)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "too long for a WAV"))?;
    let mut out = BufWriter::new(File::create(path)?);
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16_u32.to_le_bytes())?;
    out.write_all(&1_u16.to_le_bytes())?; // PCM
    out.write_all(&1_u16.to_le_bytes())?; // mono
    out.write_all(&SAMPLE_RATE.to_le_bytes())?;
    out.write_all(&(SAMPLE_RATE * 2).to_le_bytes())?; // bytes per second
    out.write_all(&2_u16.to_le_bytes())?; // block align
    out.write_all(&16_u16.to_le_bytes())?; // bits per sample
    out.write_all(b"data")?;
    out.write_all(&data.to_le_bytes())?;
    for sample in samples {
        // Clamped to −1…1 first: within i16.
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        out.write_all(&value.to_le_bytes())?;
    }
    out.flush()?;
    out.into_inner()
        .map_err(io::IntoInnerError::into_error)?
        .sync_all()
}

/// Samples in a WAV file of [`write_wav`].
fn wav_samples(path: &Path) -> io::Result<u64> {
    let len = path.metadata()?.len();
    Ok(len.saturating_sub(WAV_HEADER as u64) / 2)
}

/// The loudest sample of each bar of `per_bar` samples.
fn wav_peaks(path: &Path, bars: u32, per_bar: u64) -> io::Result<Vec<f32>> {
    let mut peaks = vec![0.0_f32; bars as usize];
    let mut reader = BufReader::new(File::open(path)?);
    let mut header = [0; WAV_HEADER];
    reader.read_exact(&mut header)?;
    let mut buffer = vec![0; 64 * 1024];
    let mut index: u64 = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for pair in buffer[..read & !1].as_chunks::<2>().0 {
            let value = f32::from(i16::from_le_bytes(*pair)).abs() / 32_768.0;
            let bar = usize::try_from(index / per_bar)
                .unwrap_or(usize::MAX)
                .min(peaks.len() - 1);
            peaks[bar] = peaks[bar].max(value);
            index += 1;
        }
    }
    Ok(peaks)
}

/* Deleting the audio (decision 10) */

/// «Удалить запись»: for every recording of a finished call that still has
/// its audio, stops its second pass, deletes both files, records
/// `audio_deleted_at` and drops its cached WAV and peaks; then one
/// `DataChanged` of the call. The transcript, summary, cards, questions and
/// proposals stay. `NotFound` for an unknown call; `Invalid` for a call
/// that isn't finished or a recording still being written; `External` when
/// a file can't be removed (the recordings before it stay deleted).
pub async fn delete_call_audio(
    storage: &Storage,
    sink: &impl EventSink,
    store: Arc<dyn RecordingStore>,
    refiner: Option<Refiner>,
    cache: AudioCache,
    call_id: &str,
) -> CommandResult<()> {
    let id = call_id.to_owned();
    let (call, recordings) = storage
        .read(move |db| Ok((calls::get(db, &id)?, recordings::for_call(db, &id)?)))
        .await?;
    if call.status != CallStatus::Finished {
        return Err(CommandError::invalid(
            "Звонок ещё не завершён: аудио удаляют после него",
        ));
    }
    if recordings
        .iter()
        .any(|recording| recording.status == RecordingState::Recording)
    {
        return Err(CommandError::invalid(
            "Запись звонка ещё идёт: аудио удаляют после неё",
        ));
    }
    let mut deleted = 0;
    let mut result = Ok(());
    for recording in recordings
        .iter()
        .filter(|recording| recording.audio_deleted_at.is_none())
    {
        if let Some(refiner) = &refiner {
            refiner.stop(&recording.id);
        }
        let (store, recording_id) = (Arc::clone(&store), recording.id.clone());
        let removed = tauri::async_runtime::spawn_blocking(move || store.delete(&recording_id))
            .await
            .map_err(|error| CommandError::storage(error.to_string()))
            .and_then(|done| {
                done.map_err(|error| {
                    CommandError::external(format!("Не удалось удалить файлы записи: {error}"))
                })
            });
        if let Err(error) = removed {
            result = Err(error);
            break;
        }
        let recording_id = recording.id.clone();
        let marked = storage
            .write(sink, move |db| {
                recordings::mark_audio_deleted(db, &recording_id, now_ms())?;
                Ok(((), Vec::new()))
            })
            .await;
        if let Err(error) = marked {
            result = Err(error);
            break;
        }
        deleted += 1;
        let (cache, recording_id) = (cache.clone(), recording.id.clone());
        let _ = tauri::async_runtime::spawn_blocking(move || cache.forget(&recording_id)).await;
    }
    if deleted > 0 {
        sink.data_changed(DataChanged::new(
            Entity::Call,
            call_id,
            call.project_id.as_deref(),
            Change::Updated,
        ));
    }
    result
}

#[cfg(test)]
mod tests;
