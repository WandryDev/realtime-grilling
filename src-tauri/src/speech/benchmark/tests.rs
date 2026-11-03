use std::{path::PathBuf, sync::Arc};

use super::*;
use crate::speech::{
    check::{self, CheckPhrase},
    language::Language,
    recognizer::IDLE_UNLOAD,
    testing::{Script, broken_recognizer, segment},
};

fn ms(value: u64) -> Duration {
    Duration::from_millis(value)
}

fn measured(latency_ms: u64, audio_ms: u64, edits: usize, words: usize) -> Measured {
    Measured {
        latency: ms(latency_ms),
        audio: ms(audio_ms),
        edits,
        words,
    }
}

#[test]
fn word_errors_after_normalization() {
    assert_eq!(
        word_errors("Нет, это не критично.", "нет это не критично"),
        (0, 4)
    );
    assert_eq!(
        word_errors("Отчёты в Google Таблицы", "отчеты в google таблицы"),
        (0, 4)
    );
    assert_eq!(
        word_errors("раз два три четыре", "раз три четыре пять"),
        (2, 4)
    );
    assert_eq!(word_errors("раз два", ""), (2, 2));
    assert_eq!(word_errors("", "лишнее"), (1, 0));
}

#[test]
fn p95_is_the_nearest_rank() {
    let six: Vec<Duration> = [900, 100, 300, 200, 500, 400].map(ms).to_vec();
    assert_eq!(p95(&six), ms(900));
    let twenty: Vec<Duration> = (1..=20).map(|n| ms(n * 100)).collect();
    assert_eq!(p95(&twenty), ms(1_900));
    assert_eq!(p95(&[]), Duration::ZERO);
}

#[test]
fn the_verdict_follows_the_thresholds() {
    let thresholds = Thresholds::default();
    // The spike's turbo on an M3: fast and accurate.
    let good = [
        measured(1_200, 4_000, 0, 10),
        measured(1_300, 6_000, 1, 12),
        measured(1_700, 12_000, 1, 25),
    ];
    let result = judge(&good, &thresholds);
    assert!(result.passed, "{result:?}");
    assert_eq!(result.p95_ms, 1_700);
    assert!((result.rtf - 4.2 / 22.0).abs() < 1e-9);
    assert!((result.wer - 2.0 / 47.0).abs() < 1e-9);
    assert_eq!(result.reason, None);

    // One phrase over 3 s is the p95 of three.
    let late = [measured(3_001, 12_000, 0, 10), measured(100, 12_000, 0, 10)];
    assert_eq!(
        judge(&late, &thresholds).reason,
        Some(BenchmarkFailure::Slow)
    );
    let at_mark = [measured(3_000, 12_000, 0, 10)];
    assert!(judge(&at_mark, &thresholds).passed);

    // Σ RTF over 0.5, every phrase on time.
    let busy = [measured(2_600, 5_000, 0, 10), measured(2_600, 5_000, 0, 10)];
    let result = judge(&busy, &thresholds);
    assert!((result.rtf - 0.52).abs() < 1e-9);
    assert_eq!(result.reason, Some(BenchmarkFailure::Slow));

    // 15 % WER fails, just under passes.
    let wrong = [measured(500, 5_000, 3, 20)];
    assert_eq!(
        judge(&wrong, &thresholds).reason,
        Some(BenchmarkFailure::Inaccurate)
    );
    let close = [measured(500, 5_000, 2, 14)];
    assert!(judge(&close, &thresholds).passed);

    // Slow and wrong: slow.
    let both = [measured(4_000, 5_000, 10, 10)];
    assert_eq!(
        judge(&both, &thresholds).reason,
        Some(BenchmarkFailure::Slow)
    );
}

/// Six 0.2-s phrases ("один два три" / "раз два три").
fn short_set() -> CheckSet {
    let phrases = (0..6)
        .map(|n| CheckPhrase {
            id: format!("p{n}"),
            language: if n < 3 { Language::Ru } else { Language::Uk },
            reference: if n < 3 {
                "один два три"
            } else {
                "раз два три"
            }
            .to_owned(),
            samples: vec![if n < 3 { 0.1 } else { 0.2 }; 3_200],
        })
        .collect();
    CheckSet::new(phrases, "Техноком", "АгроСвіт")
}

fn echo() -> Arc<Script> {
    Script::new(|samples, params| {
        assert_eq!(params.decode, Decode::Greedy);
        let ru = samples[0] < 0.15;
        assert_eq!(
            params.language,
            if ru { Language::Ru } else { Language::Uk }
        );
        assert_eq!(
            params.prompt,
            if ru {
                "Техноком"
            } else {
                "АгроСвіт"
            }
        );
        Ok(vec![segment(if ru {
            "Один, два, три."
        } else {
            "раз два три"
        })])
    })
}

/// 40 ms per 0.2-s phrase is RTF 0.2: thresholds scaled to the short set.
fn short_thresholds() -> Thresholds {
    Thresholds {
        max_p95: ms(150),
        max_rtf: 0.5,
        max_wer: 0.15,
    }
}

fn never() -> watch::Receiver<bool> {
    watch::channel(false).1
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

#[test]
fn a_fast_accurate_model_passes() {
    let script = echo();
    *script.delay.lock().unwrap() = ms(40);
    let recognizer = script.recognizer();
    let result = block_on(run(
        &recognizer,
        &short_set(),
        &short_thresholds(),
        1.0,
        never(),
    ))
    .unwrap();
    assert!(result.passed, "{result:?}");
    assert!(result.wer.abs() < 1e-9);
    assert!(result.rtf > 0.15 && result.rtf < 0.5, "{result:?}");
    // Warm-up and six phrases.
    assert_eq!(script.calls(), 7);
}

#[test]
fn the_phrases_come_at_the_pace_of_speech() {
    let script = echo();
    let recognizer = script.recognizer();
    let started = Instant::now();
    block_on(run(
        &recognizer,
        &short_set(),
        &short_thresholds(),
        1.0,
        never(),
    ))
    .unwrap();
    // The last phrase starts after the five before it were "spoken".
    assert!(started.elapsed() >= ms(1_000), "{:?}", started.elapsed());
}

#[test]
fn a_slow_model_fails() {
    let script = echo();
    *script.delay.lock().unwrap() = ms(160);
    let recognizer = script.recognizer();
    let result = block_on(run(
        &recognizer,
        &short_set(),
        &short_thresholds(),
        1.0,
        never(),
    ))
    .unwrap();
    assert!(!result.passed);
    assert_eq!(result.reason, Some(BenchmarkFailure::Slow));
    assert!(result.p95_ms >= 160, "{result:?}");
    assert!(result.rtf > 0.5, "{result:?}");
}

#[test]
fn a_model_that_answers_garbage_fails_on_wer() {
    let script = Script::saying("Бла-бла, что-то совсем другое.");
    let recognizer = script.recognizer();
    let result = block_on(run(
        &recognizer,
        &short_set(),
        &short_thresholds(),
        1.0,
        never(),
    ))
    .unwrap();
    assert!(!result.passed);
    assert_eq!(result.reason, Some(BenchmarkFailure::Inaccurate));
    assert!(result.wer >= 1.0, "{result:?}");
}

#[test]
fn a_missing_or_broken_model_is_reported() {
    let loader: crate::speech::recognizer::Loader = Box::new(|_| unreachable!("nothing to load"));
    let none = Recognizer::new(loader, None, IDLE_UNLOAD);
    let result = block_on(run(&none, &short_set(), &short_thresholds(), 1.0, never())).unwrap();
    assert_eq!(result, BenchmarkResult::not_run(BenchmarkFailure::NoModel));
    let result = block_on(run(
        &broken_recognizer(),
        &short_set(),
        &short_thresholds(),
        1.0,
        never(),
    ))
    .unwrap();
    assert_eq!(result.reason, Some(BenchmarkFailure::ModelFailed));
}

#[test]
fn cancelling_stops_the_check_and_its_jobs() {
    let script = echo();
    *script.delay.lock().unwrap() = ms(30);
    let recognizer = script.recognizer();
    let (cancel, cancelled) = watch::channel(false);
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(ms(250));
        cancel.send(true).unwrap();
        cancel
    });
    let started = Instant::now();
    let result = block_on(run(
        &recognizer,
        &short_set(),
        &short_thresholds(),
        1.0,
        cancelled,
    ));
    assert_eq!(result, Err(Cancelled));
    assert!(started.elapsed() < ms(900), "{:?}", started.elapsed());
    drop(canceller.join().unwrap());
    std::thread::sleep(ms(300));
    assert!(script.calls() < 7, "{}", script.calls());
}

#[test]
fn the_bundled_phrases_measure_the_word_errors_against_what_is_spoken() {
    // The ordinals as spoken, not as digits the model never writes.
    let set = check::load(&check::dev_dir()).unwrap();
    let ru18 = set.phrases.iter().find(|p| p.id == "ru18").unwrap();
    assert!(ru18.reference.contains("в первой фазе"));
    assert!(ru18.reference.contains("на вторую фазу"));
}

/// `GRILL_WHISPER_MODEL`, else the app's turbo download.
fn real_model() -> Option<PathBuf> {
    let path = std::env::var_os("GRILL_WHISPER_MODEL")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                PathBuf::from(home).join(
                    "Library/Application Support/com.dev-wandry.realtime-grilling/models/ggml-large-v3-turbo-q5_0.bin",
                )
            })
        })?;
    path.is_file().then_some(path)
}

/// The check as the app runs it, on this machine (task 5.3).
#[test]
#[ignore = "needs a Whisper model: GRILL_WHISPER_MODEL or the app's turbo download"]
fn the_real_model_passes_the_check_on_this_machine() {
    let Some(path) = real_model() else {
        eprintln!("no model: set GRILL_WHISPER_MODEL");
        return;
    };
    let recognizer = Recognizer::whisper(Some(path.clone()));
    let set = check::load(&check::dev_dir()).unwrap();
    let started = Instant::now();
    let result = block_on(run(&recognizer, &set, &Thresholds::default(), 1.0, never())).unwrap();
    eprintln!(
        "{}: p95 {} ms, Σ RTF {:.3}, WER {:.1} % in {:?}: {result:?}",
        path.display(),
        result.p95_ms,
        result.rtf,
        result.wer * 100.0,
        started.elapsed()
    );
    assert!(result.passed, "{result:?}");
}
