//! Where a capture callback puts its samples (audio-capture design.md,
//! decisions 7–8). One capture code path, two sinks:
//!
//! - the meters' [`Feed`](super::level::Feed): RMS only, the stamp is unused;
//! - the recorder's [`RingSink`]: an `rtrb` SPSC ring of samples plus a ring
//!   of block headers (format, host time of the first frame). The recorder
//!   thread drains it through the [`RingSource`].
//!
//! `push` runs in the audio callback: no locks, no allocations. A block that
//! does not fit is dropped whole and counted.

use std::sync::{
    Arc, Mutex, PoisonError,
    atomic::{AtomicU64, Ordering},
};

use rtrb::{Consumer, Producer, RingBuffer};

use super::{
    clock,
    level::{Failure, Feed},
};
use crate::error::CaptureFailure;

/// What a block of interleaved samples is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockFormat {
    pub channels: u16,
    pub sample_rate: u32,
}

/// The first breakdown of a running capture (device unplugged, stream
/// lost…), kept until read. Shared by the sink, the error callback and
/// whoever watches the capture.
#[derive(Debug, Clone, Default)]
pub struct Breakdown(Arc<Mutex<Option<Failure>>>);

impl Breakdown {
    /// The capture broke; the first failure is kept until it is read.
    pub fn fail(&self, reason: CaptureFailure, message: impl Into<String>) {
        let mut failure = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if failure.is_none() {
            *failure = Some(Failure {
                reason,
                message: message.into(),
            });
        }
    }

    pub fn take(&self) -> Option<Failure> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

/// Receives the blocks of one capture, in the capture's thread.
pub trait SampleSink: Send + 'static {
    /// One block of interleaved `samples`. `host_time_ns` is the time of its
    /// first frame on [`clock`]; `None` when the device gave no stamp.
    fn push<I>(&mut self, format: BlockFormat, host_time_ns: Option<u64>, samples: I)
    where
        I: ExactSizeIterator<Item = f32>;

    /// Where a later breakdown of the capture goes.
    fn breakdown(&self) -> Breakdown;
}

impl SampleSink for Feed {
    fn push<I>(&mut self, _format: BlockFormat, _host_time_ns: Option<u64>, samples: I)
    where
        I: ExactSizeIterator<Item = f32>,
    {
        Feed::push(self, samples);
    }

    fn breakdown(&self) -> Breakdown {
        self.breakdown_handle()
    }
}

/// 2^19 samples: ~2.7 s of 48 kHz stereo, ~5 s of 48 kHz mono; the recorder
/// drains every 10 ms.
pub const RING_SAMPLES: usize = 1 << 19;
/// Block headers; a callback delivers ~100 blocks a second.
pub const RING_BLOCKS: usize = 1 << 10;

/// A block in the ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockHeader {
    pub format: BlockFormat,
    /// Samples (not frames) of the block in the sample ring.
    pub len: usize,
    pub host_time_ns: u64,
}

/// The capture's end of the ring.
pub struct RingSink {
    samples: Producer<f32>,
    blocks: Producer<BlockHeader>,
    dropped: Arc<AtomicU64>,
    breakdown: Breakdown,
}

/// The recorder's end of the ring.
pub struct RingSource {
    samples: Consumer<f32>,
    blocks: Consumer<BlockHeader>,
    dropped: Arc<AtomicU64>,
    breakdown: Breakdown,
}

/// A ring with room for `samples` samples in `blocks` blocks.
pub fn ring(samples: usize, blocks: usize) -> (RingSink, RingSource) {
    clock::warm_up();
    let (sample_producer, sample_consumer) = RingBuffer::new(samples);
    let (block_producer, block_consumer) = RingBuffer::new(blocks);
    let dropped = Arc::new(AtomicU64::new(0));
    let breakdown = Breakdown::default();
    (
        RingSink {
            samples: sample_producer,
            blocks: block_producer,
            dropped: Arc::clone(&dropped),
            breakdown: breakdown.clone(),
        },
        RingSource {
            samples: sample_consumer,
            blocks: block_consumer,
            dropped,
            breakdown,
        },
    )
}

impl SampleSink for RingSink {
    fn push<I>(&mut self, format: BlockFormat, host_time_ns: Option<u64>, samples: I)
    where
        I: ExactSizeIterator<Item = f32>,
    {
        let len = samples.len();
        let channels = usize::from(format.channels);
        if len == 0 || channels == 0 {
            return;
        }
        let host_time_ns = host_time_ns.unwrap_or_else(|| {
            clock::block_start_ns(clock::now_ns(), len / channels, format.sample_rate)
        });
        if self.blocks.is_full() || self.samples.slots() < len {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let Ok(chunk) = self.samples.write_chunk_uninit(len) else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        let len = chunk.fill_from_iter(samples);
        // The header goes after its samples: the reader never sees a header
        // whose samples are not there yet.
        let pushed = self.blocks.push(BlockHeader {
            format,
            len,
            host_time_ns,
        });
        debug_assert!(pushed.is_ok(), "checked for room above");
    }

    fn breakdown(&self) -> Breakdown {
        self.breakdown.clone()
    }
}

impl RingSource {
    /// The next block: its samples replace `buffer`'s.
    pub fn pop(&mut self, buffer: &mut Vec<f32>) -> Option<BlockHeader> {
        let header = self.blocks.pop().ok()?;
        buffer.clear();
        if let Ok(chunk) = self.samples.read_chunk(header.len) {
            let (head, tail) = chunk.as_slices();
            buffer.extend_from_slice(head);
            buffer.extend_from_slice(tail);
            chunk.commit_all();
        }
        Some(header)
    }

    /// Blocks dropped so far because the ring was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn breakdown(&self) -> Breakdown {
        self.breakdown.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEREO_48K: BlockFormat = BlockFormat {
        channels: 2,
        sample_rate: 48_000,
    };

    #[test]
    fn blocks_come_out_in_order_with_their_stamps() {
        let (mut sink, mut source) = ring(64, 4);
        sink.push(STEREO_48K, Some(1_000), [0.1, 0.2, 0.3, 0.4].into_iter());
        sink.push(
            STEREO_48K,
            Some(2_000),
            [0.5_f32, 0.6].iter().map(|sample| sample * 2.0),
        );
        let mut buffer = Vec::new();
        let first = source.pop(&mut buffer).unwrap();
        assert_eq!(first.host_time_ns, 1_000);
        assert_eq!(first.format, STEREO_48K);
        assert_eq!(buffer, [0.1, 0.2, 0.3, 0.4]);
        let second = source.pop(&mut buffer).unwrap();
        assert_eq!(second.host_time_ns, 2_000);
        assert_eq!(buffer, [1.0, 1.2]);
        assert!(source.pop(&mut buffer).is_none());
        assert_eq!(source.dropped(), 0);
    }

    #[test]
    fn a_block_that_does_not_fit_is_dropped_whole_and_counted() {
        let (mut sink, mut source) = ring(8, 2);
        sink.push(STEREO_48K, Some(1), [0.0; 6].into_iter());
        sink.push(STEREO_48K, Some(2), [0.0; 4].into_iter()); // 10 > 8
        sink.push(STEREO_48K, Some(3), [0.0; 2].into_iter());
        sink.push(STEREO_48K, Some(4), [0.0; 2].into_iter()); // no header slot
        assert_eq!(source.dropped(), 2);
        let mut buffer = Vec::new();
        let stamps: Vec<u64> = std::iter::from_fn(|| source.pop(&mut buffer))
            .map(|header| header.host_time_ns)
            .collect();
        assert_eq!(stamps, [1, 3]);
        // Room again once read.
        sink.push(STEREO_48K, Some(5), [0.0; 8].into_iter());
        assert_eq!(source.pop(&mut buffer).unwrap().host_time_ns, 5);
    }

    #[test]
    fn a_block_without_a_stamp_ends_now() {
        let (mut sink, mut source) = ring(4_096, 4);
        let before = clock::now_ns();
        // 480 frames at 48 kHz: 10 ms.
        sink.push(STEREO_48K, None, std::iter::repeat_n(0.0, 960));
        let after = clock::now_ns();
        let header = source.pop(&mut Vec::new()).unwrap();
        let ten_ms = 10_000_000;
        assert!(header.host_time_ns >= before - ten_ms);
        assert!(header.host_time_ns <= after - ten_ms);
    }

    #[test]
    fn empty_blocks_are_ignored_and_failures_are_shared() {
        let (mut sink, mut source) = ring(16, 4);
        sink.push(STEREO_48K, Some(1), std::iter::empty());
        assert!(source.pop(&mut Vec::new()).is_none());
        sink.breakdown()
            .fail(CaptureFailure::NoDevice, "Микрофон отключён");
        sink.breakdown().fail(CaptureFailure::Busy, "later");
        let failure = source.breakdown().take().unwrap();
        assert_eq!(failure.reason, CaptureFailure::NoDevice);
        assert!(source.breakdown().take().is_none());
    }
}
