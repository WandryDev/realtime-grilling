//! Phrase state machine over per-window speech probabilities
//! (specs/speech-segmentation, design.md decision 17).
//!
//! Pure: no model, no audio, no clock. It gets one probability per 32-ms
//! window, in order, and answers with the phrase spans it has closed. All
//! positions are 16 kHz sample offsets from the start of the recording, so a
//! span cuts the channel's audio exactly; `Span::start_ms` / `end_ms` give the
//! timestamps.

use std::collections::VecDeque;

use super::{SAMPLES_PER_MS, WINDOW_SAMPLES};

/// The thresholds and durations of decision 17.
#[derive(Debug, Clone, Copy)]
pub struct SegmenterParams {
    /// A window at or above this starts speech.
    pub enter: f32,
    /// Inside speech, a window at or above this still counts as speech.
    pub exit: f32,
    /// Speech shorter than this is dropped (a click, a cough).
    pub min_speech_ms: u64,
    /// A pause this long ends the phrase.
    pub end_pause_ms: u64,
    /// Audio kept on each side of the speech.
    pub pad_ms: u64,
    /// No phrase is longer than this, padding included.
    pub max_phrase_ms: u64,
    /// A phrase at the cap is cut at the quietest window of this last stretch.
    pub split_lookback_ms: u64,
}

impl Default for SegmenterParams {
    fn default() -> Self {
        Self {
            enter: 0.5,
            exit: 0.35,
            min_speech_ms: 250,
            end_pause_ms: 600,
            pad_ms: 100,
            max_phrase_ms: 15_000,
            split_lookback_ms: 3_000,
        }
    }
}

/// A closed phrase: samples `[start, end)` of the channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: u64,
    pub end: u64,
}

impl Span {
    pub fn start_ms(self) -> u64 {
        self.start / SAMPLES_PER_MS
    }

    pub fn end_ms(self) -> u64 {
        self.end / SAMPLES_PER_MS
    }

    #[cfg_attr(not(test), allow(dead_code, reason = "used by the tests"))]
    pub fn len_ms(self) -> u64 {
        (self.end - self.start) / SAMPLES_PER_MS
    }
}

#[derive(Debug, Clone, Copy)]
enum State {
    Idle,
    Speech {
        /// Where the piece being built starts (padding included).
        piece_start: u64,
        /// Where the speech of this phrase started (without padding).
        speech_start: u64,
        /// End of the last window that counted as speech.
        last_speech_end: u64,
        /// The piece continues a phrase split at the cap: it is kept
        /// whatever its length, so a long monologue loses nothing.
        continued: bool,
    },
}

/// Turns window probabilities into phrase spans.
#[derive(Debug)]
pub struct Segmenter {
    enter: f32,
    exit: f32,
    min_speech: u64,
    end_pause: u64,
    pad: u64,
    max_phrase: u64,
    split_lookback: u64,
    /// Start of the next window.
    cursor: u64,
    /// End of the last emitted span (the origin at first): padding never
    /// reaches before it.
    last_end: u64,
    state: State,
    /// `(window start, probability)` for the split lookback.
    history: VecDeque<(u64, f32)>,
}

impl Segmenter {
    /// A segmenter whose first window starts at sample `origin`.
    pub fn new(params: SegmenterParams, origin: u64) -> Self {
        let samples = |ms: u64| ms * SAMPLES_PER_MS;
        Self {
            enter: params.enter,
            exit: params.exit,
            min_speech: samples(params.min_speech_ms),
            end_pause: samples(params.end_pause_ms),
            pad: samples(params.pad_ms),
            max_phrase: samples(params.max_phrase_ms),
            split_lookback: samples(params.split_lookback_ms),
            cursor: origin,
            last_end: origin,
            state: State::Idle,
            history: VecDeque::new(),
        }
    }

    /// Feeds the probability of the next window; returns a span when one
    /// closes at this window.
    pub fn push(&mut self, probability: f32) -> Option<Span> {
        let window_start = self.cursor;
        let window_end = window_start + WINDOW_SAMPLES as u64;
        self.cursor = window_end;
        self.remember(window_start, probability);

        match self.state {
            State::Idle => {
                if probability >= self.enter {
                    self.state = State::Speech {
                        piece_start: window_start.saturating_sub(self.pad).max(self.last_end),
                        speech_start: window_start,
                        last_speech_end: window_end,
                        continued: false,
                    };
                }
                None
            }
            State::Speech {
                piece_start,
                speech_start,
                mut last_speech_end,
                continued,
            } => {
                if probability >= self.exit {
                    last_speech_end = window_end;
                }
                self.state = State::Speech {
                    piece_start,
                    speech_start,
                    last_speech_end,
                    continued,
                };
                if window_end - last_speech_end >= self.end_pause {
                    return self.close(last_speech_end + self.pad);
                }
                if window_end - piece_start >= self.max_phrase {
                    return self.cap(window_end);
                }
                None
            }
        }
    }

    /// Ends the stream at sample `audio_end` (the recording stops, or the
    /// worker skips audio): closes the open phrase, if any.
    pub fn finish(&mut self, audio_end: u64) -> Option<Span> {
        let State::Speech {
            last_speech_end, ..
        } = self.state
        else {
            return None;
        };
        self.close((last_speech_end + self.pad).min(audio_end))
    }

    /// Closes the open phrase at `end`; drops it when it is too short.
    fn close(&mut self, end: u64) -> Option<Span> {
        let State::Speech {
            piece_start,
            speech_start,
            last_speech_end,
            continued,
        } = self.state
        else {
            return None;
        };
        self.state = State::Idle;
        let long_enough = continued || last_speech_end - speech_start >= self.min_speech;
        if !long_enough || end <= piece_start {
            return None;
        }
        self.last_end = end;
        Some(Span {
            start: piece_start,
            end,
        })
    }

    /// The open piece reached the cap at `window_end`.
    fn cap(&mut self, window_end: u64) -> Option<Span> {
        let State::Speech {
            piece_start,
            speech_start,
            last_speech_end,
            ..
        } = self.state
        else {
            return None;
        };
        let limit = piece_start + self.max_phrase;

        // Already in a pause with room for the padding: just end the phrase.
        if window_end - last_speech_end >= self.pad {
            return self.close((last_speech_end + self.pad).min(limit));
        }

        // Cut in the middle of the quietest window of the lookback.
        let from = window_end.saturating_sub(self.split_lookback);
        let quietest = self
            .history
            .iter()
            .filter(|(start, _)| *start >= from && *start > piece_start)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map_or(window_end, |(start, _)| start + WINDOW_SAMPLES as u64 / 2);
        let cut = quietest.min(limit);

        self.state = State::Speech {
            piece_start: cut,
            speech_start,
            last_speech_end,
            continued: true,
        };
        self.last_end = cut;
        Some(Span {
            start: piece_start,
            end: cut,
        })
    }

    fn remember(&mut self, window_start: u64, probability: f32) {
        self.history.push_back((window_start, probability));
        let keep_from = (window_start + WINDOW_SAMPLES as u64).saturating_sub(self.split_lookback);
        while self
            .history
            .front()
            .is_some_and(|(start, _)| *start < keep_from)
        {
            self.history.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW_MS: f64 = 32.0;

    /// One probability per window for `ms` of audio.
    fn run(probabilities: &mut Vec<f32>, ms: u64, probability: f32) {
        let windows = (ms as f64 / WINDOW_MS).round() as usize;
        probabilities.extend(std::iter::repeat_n(probability, windows));
    }

    fn segment(probabilities: &[f32]) -> Vec<Span> {
        let mut segmenter = Segmenter::new(SegmenterParams::default(), 0);
        let mut spans: Vec<Span> = probabilities
            .iter()
            .filter_map(|p| segmenter.push(*p))
            .collect();
        let end = probabilities.len() as u64 * WINDOW_SAMPLES as u64;
        spans.extend(segmenter.finish(end));
        spans
    }

    #[test]
    fn short_yes_is_kept_with_padding() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 1_024, 0.02);
        run(&mut probabilities, 288, 0.9); // "да": 9 windows
        run(&mut probabilities, 1_504, 0.02);

        let spans = segment(&probabilities);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_ms(), 1_024 - 100);
        assert_eq!(spans[0].end_ms(), 1_024 + 288 + 100);
    }

    #[test]
    fn exactly_minimum_speech_is_kept() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 512, 0.0);
        run(&mut probabilities, 256, 0.8); // 8 windows ≥ 250 ms
        run(&mut probabilities, 1_024, 0.0);

        assert_eq!(segment(&probabilities).len(), 1);
    }

    #[test]
    fn blip_of_100_ms_is_dropped() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 2_048, 0.01);
        run(&mut probabilities, 96, 0.95);
        run(&mut probabilities, 2_048, 0.01);

        assert!(segment(&probabilities).is_empty());
    }

    #[test]
    fn padding_is_clamped_at_the_recording_start() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 32, 0.0);
        run(&mut probabilities, 640, 0.9);
        run(&mut probabilities, 1_024, 0.0);

        let spans = segment(&probabilities);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[0].end_ms(), 32 + 640 + 100);
    }

    #[test]
    fn hysteresis_keeps_speech_between_the_thresholds() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 320, 0.0);
        run(&mut probabilities, 320, 0.9);
        run(&mut probabilities, 1_600, 0.4); // under enter, over exit
        run(&mut probabilities, 1_024, 0.1);

        let spans = segment(&probabilities);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].end_ms(), 320 + 320 + 1_600 + 100);
    }

    #[test]
    fn a_short_pause_does_not_split_the_phrase() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 320, 0.0);
        run(&mut probabilities, 1_280, 0.9);
        run(&mut probabilities, 512, 0.05); // under 600 ms
        run(&mut probabilities, 1_280, 0.9);
        run(&mut probabilities, 1_024, 0.05);

        assert_eq!(segment(&probabilities).len(), 1);
    }

    #[test]
    fn two_phrases_after_a_long_pause() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 320, 0.0);
        run(&mut probabilities, 1_280, 0.9);
        run(&mut probabilities, 640, 0.05); // over 600 ms
        run(&mut probabilities, 1_280, 0.9);
        run(&mut probabilities, 1_024, 0.05);

        let spans = segment(&probabilities);

        assert_eq!(spans.len(), 2);
        assert!(spans[0].end <= spans[1].start);
    }

    #[test]
    fn a_phrase_closes_once_the_pause_is_long_enough() {
        let mut segmenter = Segmenter::new(SegmenterParams::default(), 0);
        for _ in 0..20 {
            assert_eq!(segmenter.push(0.9), None);
        }
        // 18 quiet windows = 576 ms: still open; the 19th (608 ms) closes it.
        for _ in 0..18 {
            assert_eq!(segmenter.push(0.0), None);
        }
        let span = segmenter.push(0.0).expect("closed after 600 ms");
        assert_eq!(span.end_ms(), 20 * 32 + 100);
    }

    #[test]
    fn forty_seconds_of_speech_split_into_pieces_without_loss() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 1_024, 0.0);
        let speech_start = probabilities.len();
        // Speech with a breath (a dip) every ~2 s.
        for i in 0..(40_000 / 32) {
            probabilities.push(if i % 64 == 40 { 0.4 } else { 0.95 });
        }
        let speech_end_ms = probabilities.len() as u64 * 32;
        run(&mut probabilities, 1_024, 0.0);

        let spans = segment(&probabilities);

        assert!(spans.len() >= 3, "{spans:?}");
        for span in &spans {
            assert!(span.len_ms() <= 15_000, "{span:?}");
        }
        for pair in spans.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "gap or overlap: {pair:?}");
        }
        assert_eq!(spans[0].start_ms(), speech_start as u64 * 32 - 100);
        assert_eq!(spans.last().unwrap().end_ms(), speech_end_ms + 100);
    }

    #[test]
    fn the_cap_cuts_at_the_quietest_point_of_the_last_three_seconds() {
        let mut probabilities = Vec::new();
        // Speech from 0; a dip at 13 s (window 406).
        for i in 0..(20_000 / 32) {
            probabilities.push(if i == 406 { 0.36 } else { 0.9 });
        }
        run(&mut probabilities, 1_024, 0.0);

        let spans = segment(&probabilities);

        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[0].end, 406 * 512 + 256);
        assert_eq!(spans[1].start, spans[0].end);
    }

    #[test]
    fn a_cap_reached_in_the_pause_ends_the_phrase() {
        let mut probabilities = Vec::new();
        run(&mut probabilities, 14_720, 0.9);
        run(&mut probabilities, 3_200, 0.0);

        let spans = segment(&probabilities);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].end_ms(), 14_720 + 100);
    }

    #[test]
    fn finish_closes_the_open_phrase_at_the_audio_end() {
        let mut segmenter = Segmenter::new(SegmenterParams::default(), 0);
        for _ in 0..20 {
            segmenter.push(0.9);
        }
        let span = segmenter.finish(20 * 512 + 100).expect("open phrase");
        assert_eq!(span.end, 20 * 512 + 100);
        assert_eq!(segmenter.finish(99_999), None);
    }

    #[test]
    fn an_origin_offsets_every_span() {
        let mut segmenter = Segmenter::new(SegmenterParams::default(), 16_000);
        for _ in 0..20 {
            segmenter.push(0.9);
        }
        let span = segmenter.finish(u64::MAX).expect("open phrase");
        assert_eq!(span.start, 16_000);
        assert_eq!(span.end_ms(), 1_000 + 20 * 32 + 100);
    }
}
