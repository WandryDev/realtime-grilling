//! The mic check of onboarding (speech-recognition design.md decision 15):
//! up to 8 s from the default input, cut short when the VAD closes a phrase
//! after speech, recognized as one phrase. Nothing is stored.

use std::{
    path::Path,
    sync::{Arc, Condvar, Mutex, PoisonError},
    time::{Duration, Instant},
};

use super::{
    filters,
    glossary::Glossary,
    language::{CallLanguage, LanguageChoice},
    recognizer::{Decode, Job, Priority, Recognizer, RecognizerError},
};
use crate::{
    audio::{
        clock,
        sink::{self, SampleSink as _},
        sources::{self, ensure_access},
    },
    error::{CommandError, CommandResult},
    permissions::{self, PermissionKind},
    recording::{
        FRAME,
        timeline::{InputBlock, Timeline},
    },
    storage::transcript::TranscriptChannel,
    vad::{
        SAMPLES_PER_MS,
        worker::{Phrase, PhraseSink, VadWorker},
    },
};

/// The longest check.
pub const MAX_LISTEN: Duration = Duration::from_secs(8);
/// How often the microphone is drained.
const TICK: Duration = Duration::from_millis(10);

/// Keeps the phrases the VAD closed.
#[derive(Default)]
struct Phrases {
    closed: Mutex<Vec<Phrase>>,
    changed: Condvar,
}

impl PhraseSink for Phrases {
    fn phrase(&self, phrase: Phrase) {
        self.closed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(phrase);
        self.changed.notify_all();
    }
}

impl Phrases {
    fn any(&self) -> bool {
        !self
            .closed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }

    /// `[start, end)` in samples, from the first phrase to the last.
    fn span(&self) -> Option<(usize, usize)> {
        let closed = self.closed.lock().unwrap_or_else(PoisonError::into_inner);
        let start = closed.iter().map(|phrase| phrase.start_ms).min()?;
        let end = closed.iter().map(|phrase| phrase.end_ms).max()?;
        let at = |ms: u64| usize::try_from(ms * SAMPLES_PER_MS).unwrap_or(usize::MAX);
        Some((at(start), at(end)))
    }
}

/// Pulls 16 kHz mono audio (`pull` appends what came since the last call)
/// every `tick` until the VAD closes a phrase or `max` of audio came. The
/// speech heard, from the first phrase to the last; empty when there was
/// none. Without a VAD model the whole audio.
pub fn listen(
    mut pull: impl FnMut(&mut Vec<f32>),
    vad_model: &Path,
    max: Duration,
    tick: Duration,
) -> Vec<f32> {
    let phrases = Arc::new(Phrases::default());
    let vad = VadWorker::spawn(
        vad_model,
        "mic-check",
        TranscriptChannel::Me,
        Arc::clone(&phrases) as Arc<dyn PhraseSink>,
    );
    let max_samples = (max.as_secs_f64() * f64::from(crate::vad::SAMPLE_RATE)) as usize;
    let mut audio: Vec<f32> = Vec::with_capacity(max_samples);
    let mut fresh = Vec::new();
    let deadline = Instant::now() + max + Duration::from_secs(2);
    while audio.len() < max_samples && !phrases.any() && Instant::now() < deadline {
        fresh.clear();
        pull(&mut fresh);
        let room = max_samples - audio.len();
        fresh.truncate(room);
        vad.push(&fresh);
        audio.extend_from_slice(&fresh);
        if !tick.is_zero() {
            std::thread::sleep(tick);
        }
    }
    let segmented = vad.status() == crate::vad::worker::SegmentationStatus::Ok;
    // Scores what is queued and closes a phrase still open.
    vad.finish();
    if !segmented {
        return audio;
    }
    match phrases.span() {
        Some((start, end)) => {
            let end = end.min(audio.len());
            audio[start.min(end)..end].to_vec()
        }
        None => Vec::new(),
    }
}

/// Up to [`MAX_LISTEN`] from the default input, with the access checked as
/// for a recording. Blocks: call it off the async workers.
pub fn listen_to_microphone(vad_model: &Path) -> CommandResult<Vec<f32>> {
    ensure_access(
        &permissions::status(PermissionKind::Microphone),
        "микрофону",
    )?;
    let (ring_sink, mut source) = sink::ring(sink::RING_SAMPLES, sink::RING_BLOCKS);
    let breakdown = ring_sink.breakdown();
    let opened = sources::open_microphone(ring_sink)?;
    let mut timeline = Timeline::new(clock::now_ns());
    let mut block = Vec::new();
    let mut frame = [0.0; FRAME];
    let audio = listen(
        |out| {
            while let Some(header) = source.pop(&mut block) {
                timeline.push(InputBlock {
                    samples: &block,
                    channels: header.format.channels,
                    sample_rate: header.format.sample_rate,
                    host_time_ns: header.host_time_ns,
                });
            }
            while timeline.pop_frame(&mut frame) {
                out.extend_from_slice(&frame);
            }
        },
        vad_model,
        MAX_LISTEN,
        TICK,
    );
    drop(opened);
    if let Some(failure) = breakdown.take() {
        return Err(CommandError::capture(failure.reason, failure.message));
    }
    Ok(audio)
}

/// The text of `audio` in the call language, as the live pass would show
/// it; empty for silence.
pub async fn recognize(
    recognizer: &Recognizer,
    audio: Vec<f32>,
    language: CallLanguage,
) -> CommandResult<String> {
    if audio.is_empty() {
        return Ok(String::new());
    }
    let language = language
        .fixed()
        .map_or(LanguageChoice::Detect, LanguageChoice::Fixed);
    let reply = recognizer.submit(Job {
        samples: audio,
        language,
        prompt: String::new(),
        decode: Decode::Greedy,
        priority: Priority::Check,
    });
    match reply.await.unwrap_or(Err(RecognizerError::Stopped)) {
        Ok(transcript) => {
            Ok(filters::filter(&transcript.segments, &Glossary::empty(), &[]).unwrap_or_default())
        }
        Err(RecognizerError::NoModel) => {
            Err(CommandError::invalid("Модель распознавания не скачана"))
        }
        Err(error) => Err(CommandError::external(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vad::{
        SAMPLE_RATE,
        detector::test_audio::{fixture, read_wav},
        dev_model_path,
    };

    /// Hands out `samples` 100 ms at a time.
    fn chunks(samples: Vec<f32>) -> impl FnMut(&mut Vec<f32>) {
        let mut offset = 0;
        move |out: &mut Vec<f32>| {
            let end = (offset + SAMPLE_RATE as usize / 10).min(samples.len());
            out.extend_from_slice(&samples[offset..end]);
            offset = end;
        }
    }

    #[test]
    fn listening_stops_after_a_phrase_and_keeps_its_speech() {
        let mut speech = read_wav(&fixture("two-phrases.wav"));
        speech.resize(12 * SAMPLE_RATE as usize, 0.0);
        let audio = listen(chunks(speech), &dev_model_path(), MAX_LISTEN, TICK);
        let seconds = audio.len() as f64 / f64::from(SAMPLE_RATE);
        // Phrase 1 is 4.06 s, from 0.8 s; the padding and a little of what
        // came while the VAD caught up may be in.
        assert!((4.0..=7.5).contains(&seconds), "{seconds} s");
    }

    #[test]
    fn silence_is_nothing() {
        let audio = listen(
            chunks(vec![0.0; 10 * SAMPLE_RATE as usize]),
            &dev_model_path(),
            Duration::from_secs(2),
            Duration::ZERO,
        );
        assert!(audio.is_empty());
    }

    #[test]
    fn without_a_vad_the_whole_audio_is_kept() {
        let audio = listen(
            chunks(vec![0.1; 10 * SAMPLE_RATE as usize]),
            Path::new("missing-vad.bin"),
            Duration::from_secs(1),
            Duration::ZERO,
        );
        assert_eq!(audio.len(), SAMPLE_RATE as usize);
    }

    #[test]
    fn the_text_is_recognized_in_the_call_language() {
        let script = crate::speech::testing::Script::new(|_, params| {
            assert_eq!(params.language, crate::speech::language::Language::Uk);
            assert_eq!(params.prompt, "");
            Ok(vec![crate::speech::testing::segment("Привіт")])
        });
        let recognizer = script.recognizer();
        let text = tauri::async_runtime::block_on(recognize(
            &recognizer,
            vec![0.1; 1_600],
            CallLanguage::Uk,
        ))
        .unwrap();
        assert_eq!(text, "Привіт");
        let silent =
            tauri::async_runtime::block_on(recognize(&recognizer, Vec::new(), CallLanguage::Uk));
        assert_eq!(silent.unwrap(), "");
        assert_eq!(script.calls(), 1);
    }
}
