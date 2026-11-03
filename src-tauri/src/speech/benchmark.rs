//! The hardware check (speech-recognition design.md decision 14): the
//! bundled phrases go through the recognizer's queue at the pace of a live
//! call, and the latency, speed and accuracy decide whether this machine
//! keeps up with the model.
//!
//! One warm-up phrase loads the model; then every phrase is submitted when
//! its own audio would have ended, as the VAD hands a phrase over at its
//! end during a call. A phrase's latency is from its submission to its
//! text, queueing included.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::{sync::watch, task::JoinSet};

use super::{
    check::{CheckPhrase, CheckSet},
    filters,
    glossary::Glossary,
    language::LanguageChoice,
    recognizer::{Decode, Job, Priority, Recognizer, RecognizerError},
};

/// Why a check did not pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BenchmarkFailure {
    /// p95 latency over 3 s or Σ RTF over 0.5: the live pass would lag.
    Slow,
    /// WER of 15 % or more: the accelerator gives garbage.
    Inaccurate,
    /// The model is not installed.
    NoModel,
    /// The model is installed but whisper.cpp did not load it.
    ModelFailed,
}

/// What the check measured.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub passed: bool,
    /// 95th percentile of the phrases' latency (nearest rank).
    pub p95_ms: u32,
    /// Σ latency / Σ audio duration.
    // Always finite, so a plain `number` rather than specta's `number | null`.
    #[specta(type = u32)]
    pub rtf: f64,
    /// Word error rate over all phrases, 0–1 (and more).
    #[specta(type = u32)]
    pub wer: f64,
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<BenchmarkFailure>,
}

impl BenchmarkResult {
    /// Whether the phrases were recognized (passed or failed on the
    /// measures): not [`Self::not_run`].
    pub fn ran(&self) -> bool {
        !matches!(
            self.reason,
            Some(BenchmarkFailure::NoModel | BenchmarkFailure::ModelFailed)
        )
    }

    /// Nothing measured: the model is missing or broken.
    pub fn not_run(reason: BenchmarkFailure) -> Self {
        Self {
            passed: false,
            p95_ms: 0,
            rtf: 0.0,
            wer: 0.0,
            reason: Some(reason),
        }
    }
}

/// The pass marks.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    pub max_p95: Duration,
    pub max_rtf: f64,
    /// The WER must stay below it.
    pub max_wer: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            max_p95: Duration::from_secs(3),
            max_rtf: 0.5,
            max_wer: 0.15,
        }
    }
}

/// One phrase of the check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Measured {
    pub latency: Duration,
    pub audio: Duration,
    /// Word edits against the reference, and the reference's words.
    pub edits: usize,
    pub words: usize,
}

/// The check was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// Words after the check's normalization: lowercase, `ё` → `е`, no
/// punctuation.
fn words(text: &str) -> Vec<String> {
    filters::normalize(text)
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// Word edits (substitutions, insertions, deletions) from `reference` to
/// `hypothesis`, and the reference's word count.
pub fn word_errors(reference: &str, hypothesis: &str) -> (usize, usize) {
    let (reference, hypothesis) = (words(reference), words(hypothesis));
    let mut row: Vec<usize> = (0..=hypothesis.len()).collect();
    for (i, r) in reference.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, h) in hypothesis.iter().enumerate() {
            let substitution = diagonal + usize::from(r != h);
            diagonal = row[j + 1];
            row[j + 1] = substitution.min(row[j] + 1).min(row[j + 1] + 1);
        }
    }
    (row[hypothesis.len()], reference.len())
}

/// The nearest-rank 95th percentile.
pub fn p95(latencies: &[Duration]) -> Duration {
    let mut sorted = latencies.to_vec();
    sorted.sort();
    let rank = (sorted.len() * 95).div_ceil(100).max(1);
    sorted.get(rank - 1).copied().unwrap_or_default()
}

/// The verdict over the measured phrases. Too slow wins over inaccurate:
/// the remedy (the smaller model) is the same and speed is what it fixes.
pub fn judge(measured: &[Measured], thresholds: &Thresholds) -> BenchmarkResult {
    let latencies: Vec<Duration> = measured.iter().map(|m| m.latency).collect();
    let p95 = p95(&latencies);
    let audio: f64 = measured.iter().map(|m| m.audio.as_secs_f64()).sum();
    let spent: f64 = latencies.iter().map(Duration::as_secs_f64).sum();
    let rtf = if audio > 0.0 { spent / audio } else { 0.0 };
    let edits: usize = measured.iter().map(|m| m.edits).sum();
    let words: usize = measured.iter().map(|m| m.words).sum();
    let wer = edits as f64 / words.max(1) as f64;

    let slow = p95 > thresholds.max_p95 || rtf > thresholds.max_rtf;
    let inaccurate = wer >= thresholds.max_wer;
    let reason = if slow {
        Some(BenchmarkFailure::Slow)
    } else if inaccurate {
        Some(BenchmarkFailure::Inaccurate)
    } else {
        None
    };
    BenchmarkResult {
        passed: reason.is_none(),
        p95_ms: u32::try_from(p95.as_millis()).unwrap_or(u32::MAX),
        rtf,
        wer,
        reason,
    }
}

fn job(phrase: &CheckPhrase, set: &CheckSet) -> Job {
    Job {
        samples: phrase.samples.clone(),
        language: LanguageChoice::Fixed(phrase.language),
        prompt: set.glossary(phrase.language).to_owned(),
        decode: Decode::Greedy,
        priority: Priority::Check,
    }
}

/// The text the live pass would show.
fn text(
    result: Result<super::recognizer::Transcript, RecognizerError>,
) -> Result<String, RecognizerError> {
    let transcript = result?;
    Ok(filters::filter(&transcript.segments, &Glossary::empty(), &[]).unwrap_or_default())
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    // A dropped sender never cancels.
    if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Runs the check on whatever model the recognizer has. `pace` scales the
/// real-time schedule (1.0 in the app, smaller in tests). A missing or
/// broken model ends it at the warm-up.
pub async fn run(
    recognizer: &Recognizer,
    set: &CheckSet,
    thresholds: &Thresholds,
    pace: f64,
    mut cancel: watch::Receiver<bool>,
) -> Result<BenchmarkResult, Cancelled> {
    let Some(first) = set.phrases.first() else {
        return Ok(judge(&[], thresholds));
    };
    let warm_up = recognizer.submit(job(first, set));
    let warmed = tokio::select! {
        () = cancelled(&mut cancel) => return Err(Cancelled),
        reply = warm_up => reply.unwrap_or(Err(RecognizerError::Stopped)),
    };
    match warmed {
        Err(RecognizerError::NoModel) => {
            return Ok(BenchmarkResult::not_run(BenchmarkFailure::NoModel));
        }
        Err(RecognizerError::ModelFailed(_)) => {
            return Ok(BenchmarkResult::not_run(BenchmarkFailure::ModelFailed));
        }
        // An inference error shows in the phrases below.
        _ => {}
    }

    let start = tokio::time::Instant::now();
    let mut offset = Duration::ZERO;
    let mut tasks = JoinSet::new();
    for (index, phrase) in set.phrases.iter().enumerate() {
        offset += phrase.duration();
        let at = start + offset.mul_f64(pace);
        let job = job(phrase, set);
        let recognizer = recognizer.clone();
        tasks.spawn(async move {
            tokio::time::sleep_until(at).await;
            let submitted = Instant::now();
            let reply = recognizer.submit(job).await;
            let latency = submitted.elapsed();
            (
                index,
                latency,
                text(reply.unwrap_or(Err(RecognizerError::Stopped))),
            )
        });
    }

    let mut measured = vec![None; set.phrases.len()];
    loop {
        // Dropping the set on cancel aborts the tasks, and their dropped
        // replies take the queued jobs off the recognizer.
        let next = tokio::select! {
            () = cancelled(&mut cancel) => return Err(Cancelled),
            next = tasks.join_next() => next,
        };
        let Some(joined) = next else {
            break;
        };
        let Ok((index, latency, result)) = joined else {
            continue;
        };
        let phrase = &set.phrases[index];
        let hypothesis = match result {
            Ok(text) => text,
            Err(error) => {
                eprintln!("grill: check phrase {} failed: {error}", phrase.id);
                String::new()
            }
        };
        let (edits, words) = word_errors(&phrase.reference, &hypothesis);
        if cfg!(debug_assertions) {
            eprintln!(
                "grill: check {} in {latency:?} for {:?}: {hypothesis}",
                phrase.id,
                phrase.duration()
            );
        }
        measured[index] = Some(Measured {
            latency,
            audio: phrase.duration(),
            edits,
            words,
        });
    }
    let measured: Vec<Measured> = measured.into_iter().flatten().collect();
    Ok(judge(&measured, thresholds))
}

#[cfg(test)]
mod tests;
