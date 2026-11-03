use std::sync::atomic::Ordering;

use super::*;
use crate::{
    events::{Change, Entity},
    speech::testing::{FakeHost, Script, broken_recognizer, eventually, segment},
    storage::{
        recordings::{self, RecordingFiles, RecordingLinks},
        transcript::for_recording,
    },
};

const MS: usize = SAMPLE_RATE as usize / 1_000;

/// A phrase of `len_ms` whose samples all hold `marker`: the fake engine
/// reads it back.
fn phrase(id: &str, channel: TranscriptChannel, start_ms: u64, len_ms: u64, marker: f32) -> Phrase {
    Phrase {
        recording_id: id.to_owned(),
        channel,
        start_ms,
        end_ms: start_ms + len_ms,
        samples: vec![marker; len_ms as usize * MS],
    }
}

/// "фраза N" for a marker of N / 1000; a negative marker is a phantom.
fn scripted() -> Arc<Script> {
    Script::new(|samples, _| {
        let marker = samples.first().copied().unwrap_or(0.0);
        let text = if marker < 0.0 {
            "Продолжение следует...".to_owned()
        } else {
            format!("фраза {}", (marker * 1_000.0).round())
        };
        Ok(vec![segment(&text)])
    })
}

fn sink(host: &Arc<FakeHost>, script: &Arc<Script>, config: LiveConfig) -> TranscriptSink {
    TranscriptSink::new(host.as_host(), script.recognizer(), config)
}

fn phrases(host: &FakeHost) -> Vec<TranscriptPhrase> {
    host.events()
        .into_iter()
        .filter_map(|event| match event {
            TranscriptEvent::Phrase(phrase) => Some(phrase),
            _ => None,
        })
        .collect()
}

fn position(events: &[TranscriptEvent], wanted: impl Fn(&TranscriptEvent) -> bool) -> usize {
    events.iter().position(wanted).expect("the event was sent")
}

#[test]
fn a_phrase_is_pending_then_recognized_and_stored() {
    let host = FakeHost::new(None);
    let script = scripted();
    let sink = sink(&host, &script, LiveConfig::default());
    let id = host.recording();

    let status = sink.recording_started(&id);
    assert_eq!(
        status,
        TranscriptionStatus::new(TranscriptionState::Ok, Some(ModelId::Turbo))
    );
    sink.phrase(phrase(&id, TranscriptChannel::Me, 0, 500, 0.001));
    sink.phrase(phrase(&id, TranscriptChannel::Others, 1_000, 700, 0.002));
    eventually("both phrases", || phrases(&host).len() == 2);

    let events = host.events();
    for (channel, start_ms, text) in [
        (TranscriptChannel::Me, 0, "фраза 1"),
        (TranscriptChannel::Others, 1_000, "фраза 2"),
    ] {
        let pending = position(
            &events,
            |event| matches!(event, TranscriptEvent::Pending(p) if p.channel == channel && p.start_ms == start_ms),
        );
        let done = position(
            &events,
            |event| matches!(event, TranscriptEvent::Phrase(p) if p.channel == channel && p.start_ms == start_ms && p.text == text),
        );
        assert!(pending < done, "{events:?}");
    }

    let stored = host.db(|connection| for_recording(connection, &id).unwrap());
    let sent = phrases(&host);
    assert_eq!(stored.len(), 2);
    for (segment, event) in stored.iter().zip(&sent) {
        assert_eq!(segment.id, event.id);
        assert_eq!(segment.pass, TranscriptPass::Live);
        assert_eq!(segment.text, event.text);
        assert_eq!(segment.end_ms, i64::try_from(event.end_ms).unwrap());
        assert_eq!(event.pass, TranscriptPass::Live);
    }
    assert_eq!(sent[1].end_ms, 1_700);
    let data = host.data.lock().unwrap().clone();
    assert_eq!(data.len(), 2);
    assert!(
        data.iter()
            .all(|event| event.entity == Entity::Transcript && event.change == Change::Created)
    );

    sink.recording_finished(&id);
    eventually("the live pass to end", || {
        host.finished.lock().unwrap().contains(&id)
    });
    assert!(host.statuses().is_empty(), "the status never changed");
}

#[test]
fn a_filtered_phrase_is_dropped_and_not_stored() {
    let host = FakeHost::new(None);
    let script = scripted();
    let sink = sink(&host, &script, LiveConfig::default());
    let id = host.recording();
    sink.recording_started(&id);

    sink.phrase(phrase(&id, TranscriptChannel::Others, 2_000, 400, -1.0));
    eventually("the drop", || {
        host.events()
            .iter()
            .any(|event| matches!(event, TranscriptEvent::Dropped(_)))
    });
    assert_eq!(
        host.events(),
        vec![
            TranscriptEvent::Pending(TranscriptPending {
                recording_id: id.clone(),
                channel: TranscriptChannel::Others,
                start_ms: 2_000,
            }),
            TranscriptEvent::Dropped(TranscriptDropped {
                recording_id: id.clone(),
                channel: TranscriptChannel::Others,
                start_ms: 2_000,
            }),
        ]
    );
    assert!(host.db(|connection| for_recording(connection, &id).unwrap().is_empty()));
    assert!(host.data.lock().unwrap().is_empty());
}

#[test]
fn the_glossary_echo_filter_looks_at_the_last_two_phrases_of_the_channel() {
    let host = FakeHost::new(None);
    let script = Script::new(|samples, _| {
        let text = if samples[0] > 0.0 {
            "Техноком, Марина Швец, Олег Ковальчук"
        } else {
            "Это Техноком, Марина Швец и Олег Ковальчук"
        };
        Ok(vec![segment(text)])
    });
    let sink = sink(&host, &script, LiveConfig::default());
    let id = host.db(|connection| {
        let project = crate::storage::projects::create(
            connection,
            crate::storage::projects::ProjectCreate {
                name: "Техноком".into(),
                ..Default::default()
            },
        )
        .unwrap()
        .0
        .id;
        for name in ["Марина Швец", "Олег Ковальчук"] {
            crate::storage::people::create(
                connection,
                crate::storage::people::PersonCreate {
                    project_id: project.clone(),
                    name: name.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        recordings::create(
            connection,
            &RecordingLinks {
                project_id: Some(project),
                ..RecordingLinks::default()
            },
            0,
            |id| RecordingFiles {
                me: format!("recordings/{id}/me.opus"),
                others: format!("recordings/{id}/others.opus"),
            },
        )
        .unwrap()
    });
    sink.recording_started(&id);

    // An echo with nothing around it is dropped.
    sink.phrase(phrase(&id, TranscriptChannel::Others, 0, 300, 1.0));
    // The terms said in a sentence, then the bare list: kept, the terms
    // are in a neighbour.
    sink.phrase(phrase(&id, TranscriptChannel::Others, 1_000, 300, -1.0));
    sink.phrase(phrase(&id, TranscriptChannel::Others, 2_000, 300, 1.0));
    eventually("three answers", || {
        host.events()
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    TranscriptEvent::Phrase(_) | TranscriptEvent::Dropped(_)
                )
            })
            .count()
            == 3
    });
    let kept: Vec<u64> = phrases(&host).iter().map(|p| p.start_ms).collect();
    assert_eq!(kept, [1_000, 2_000]);
    let prompts = script.prompts.lock().unwrap().clone();
    assert!(
        prompts
            .iter()
            .all(|prompt| prompt == "Техноком, Марина Швец, Олег Ковальчук"),
        "{prompts:?}"
    );
}

#[test]
fn a_slow_recognizer_lags_then_skips_without_slowing_the_recording() {
    let host = FakeHost::new(None);
    let script = scripted();
    script.hold.store(true, Ordering::SeqCst);
    let config = LiveConfig {
        lag_after: Duration::from_secs(1),
        skip_after: Duration::from_secs(3),
        lag_every: Duration::from_millis(20),
    };
    let sink = sink(&host, &script, config);
    let id = host.recording();
    sink.recording_started(&id);

    // Ten phrases of 0.5 s, as fast as the VAD could send them.
    let mut slowest = Duration::ZERO;
    for index in 0..10_u64 {
        let started = Instant::now();
        sink.phrase(phrase(
            &id,
            TranscriptChannel::Others,
            index * 1_000,
            500,
            (index + 1) as f32 / 1_000.0,
        ));
        slowest = slowest.max(started.elapsed());
    }
    assert!(slowest < Duration::from_millis(20), "{slowest:?}");

    let skipped = || -> Vec<u64> {
        host.events()
            .iter()
            .filter_map(|event| match event {
                TranscriptEvent::Skipped(skipped) => Some(skipped.start_ms),
                _ => None,
            })
            .collect()
    };
    // 5 s queued, at most 3 s kept; the first phrase is running.
    eventually("the skips", || skipped().len() == 4);
    assert_eq!(skipped(), [1_000, 2_000, 3_000, 4_000]);
    let lags = || -> Vec<u32> {
        host.events()
            .iter()
            .filter_map(|event| match event {
                TranscriptEvent::Lag(lag) => Some(lag.seconds),
                _ => None,
            })
            .collect()
    };
    eventually("a repeated lag", || lags().len() >= 3);
    let events = host.events();
    let first_lag = position(&events, |event| matches!(event, TranscriptEvent::Lag(_)));
    let first_skip = position(&events, |event| {
        matches!(event, TranscriptEvent::Skipped(_))
    });
    assert!(first_lag < first_skip);
    assert!(lags().iter().all(|seconds| *seconds > 1), "{:?}", lags());

    script.hold.store(false, Ordering::SeqCst);
    eventually("the rest recognized", || phrases(&host).len() == 6);
    eventually("the lag gone", || lags().last() == Some(&0));
    let recognized: Vec<u64> = phrases(&host).iter().map(|p| p.start_ms).collect();
    assert_eq!(recognized, [0, 5_000, 6_000, 7_000, 8_000, 9_000]);
    assert_eq!(script.calls(), 6, "skipped phrases never ran");
}

#[test]
fn without_a_model_the_recording_goes_on_and_says_no_model() {
    let host = FakeHost::new(None);
    *host.model.lock().unwrap() = (ModelId::Small, false);
    let script = scripted();
    let sink = sink(&host, &script, LiveConfig::default());
    let id = host.recording();

    assert_eq!(
        sink.recording_started(&id),
        TranscriptionStatus::new(TranscriptionState::NoModel, Some(ModelId::Small))
    );
    let started = Instant::now();
    for index in 0..5 {
        sink.phrase(phrase(
            &id,
            TranscriptChannel::Me,
            index * 1_000,
            500,
            0.001,
        ));
    }
    assert!(started.elapsed() < Duration::from_millis(20));
    sink.recording_finished(&id);
    eventually("the live pass to end", || {
        host.finished.lock().unwrap().contains(&id)
    });
    assert!(host.events().is_empty(), "{:?}", host.events());
    assert_eq!(script.calls(), 0);

    // Installed meanwhile: the next recording recognizes.
    *host.model.lock().unwrap() = (ModelId::Small, true);
    let next = host.recording();
    let lazily = TranscriptSink::new(host.as_host(), script.recognizer(), LiveConfig::default());
    lazily.phrase(phrase(&next, TranscriptChannel::Me, 0, 500, 0.003));
    eventually("the phrase", || phrases(&host).len() == 1);
    assert_eq!(
        host.statuses(),
        [TranscriptionStatus::new(
            TranscriptionState::Ok,
            Some(ModelId::Small)
        )]
    );
}

#[test]
fn a_model_that_does_not_load_is_model_failed() {
    let host = FakeHost::new(None);
    let sink = TranscriptSink::new(host.as_host(), broken_recognizer(), LiveConfig::default());
    let id = host.recording();
    sink.recording_started(&id);

    sink.phrase(phrase(&id, TranscriptChannel::Me, 0, 500, 0.001));
    eventually("the drop", || {
        host.events()
            .iter()
            .any(|event| matches!(event, TranscriptEvent::Dropped(_)))
    });
    assert_eq!(
        host.statuses(),
        [TranscriptionStatus::new(
            TranscriptionState::ModelFailed,
            Some(ModelId::Turbo)
        )]
    );
    assert_eq!(*host.failed_models.lock().unwrap(), [ModelId::Turbo]);

    // The model is marked broken: later phrases are left out, still
    // `modelFailed`.
    sink.phrase(phrase(&id, TranscriptChannel::Me, 1_000, 500, 0.001));
    sink.recording_finished(&id);
    eventually("the live pass to end", || {
        host.finished.lock().unwrap().contains(&id)
    });
    assert_eq!(host.statuses().len(), 1);
}
