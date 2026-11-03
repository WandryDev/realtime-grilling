//! One channel file: Opus in Ogg, RFC 7845 (audio-capture design.md,
//! decision 11).
//!
//! 16 kHz mono, `Application::Voip`, VBR 20 kbit/s, 20 ms packets. A page
//! goes to the OS every second and to the disk every 5 seconds, so a crash
//! loses at most the last couple of seconds; the file stays readable up to
//! its last complete page. [`OggOpusWriter::finish`] ends the stream (EOS)
//! with the exact length in its last granule position.

use std::{
    io::{self, Read, Seek},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use ogg::{PacketReader, PacketWriteEndInfo, PacketWriter};
use opus::{Application, Bitrate, Channels, Decoder, Encoder};

use super::{SAMPLE_RATE, store::ChannelSink};

/// Samples per Opus packet (20 ms at 16 kHz).
pub const PACKET_SAMPLES: usize = 320;
/// Granule positions count 48 kHz samples whatever the input rate.
const GRANULE_RATE: u32 = 48_000;
const GRANULE_PER_SAMPLE: u64 = (GRANULE_RATE / SAMPLE_RATE) as u64;
const BITRATE: i32 = 20_000;
/// 50 packets of 20 ms: one page a second.
const PACKETS_PER_PAGE: u32 = 50;
/// `sync_data` every 5 pages (5 s).
const PAGES_PER_SYNC: u32 = 5;
/// Opus never needs more for one packet (RFC 6716 §3.2.1).
const MAX_PACKET: usize = 1_275;
const VENDOR: &str = "Grill (libopus)";
/// The largest Opus frame: 120 ms at 48 kHz.
const MAX_FRAME: usize = 5_760;

fn codec_error(error: opus::Error) -> io::Error {
    io::Error::other(error)
}

/// Writes 16 kHz mono samples into an Ogg Opus stream.
pub struct OggOpusWriter<W: ChannelSink> {
    pages: PacketWriter<'static, W>,
    serial: u32,
    encoder: Encoder,
    /// Encoder delay at 48 kHz (`OpusHead` pre-skip).
    pre_skip: u16,
    /// Samples waiting for a full packet.
    pending: Vec<f32>,
    /// Input samples written so far (16 kHz).
    samples: u64,
    /// Packets written so far.
    packets: u64,
    packets_in_page: u32,
    pages_since_sync: u32,
    packet: Vec<u8>,
}

impl<W: ChannelSink> OggOpusWriter<W> {
    /// Starts the stream: `OpusHead` and `OpusTags`, each on its own page,
    /// flushed to the OS.
    pub fn new(sink: W) -> io::Result<Self> {
        let mut encoder =
            Encoder::new(SAMPLE_RATE, Channels::Mono, Application::Voip).map_err(codec_error)?;
        encoder
            .set_bitrate(Bitrate::Bits(BITRATE))
            .map_err(codec_error)?;
        encoder.set_vbr(true).map_err(codec_error)?;
        encoder.set_vbr_constraint(false).map_err(codec_error)?;
        // Lookahead is in samples at the encoder's rate.
        let lookahead = u64::try_from(encoder.get_lookahead().map_err(codec_error)?).unwrap_or(0);
        let pre_skip = u16::try_from(lookahead * GRANULE_PER_SAMPLE).unwrap_or(u16::MAX);

        let serial = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(1, |time| time.subsec_nanos() ^ (time.as_secs() as u32));
        let mut writer = Self {
            pages: PacketWriter::new(sink),
            serial,
            encoder,
            pre_skip,
            pending: Vec::with_capacity(PACKET_SAMPLES),
            samples: 0,
            packets: 0,
            packets_in_page: 0,
            pages_since_sync: 0,
            packet: vec![0; MAX_PACKET],
        };
        writer.write_headers()?;
        Ok(writer)
    }

    /// Encoder delay at 48 kHz, as written in `OpusHead`.
    #[allow(
        dead_code,
        reason = "the OpusHead value, for readers of the writer; nothing needs it yet"
    )]
    pub fn pre_skip(&self) -> u16 {
        self.pre_skip
    }

    /// Duration written so far, in 16 kHz samples.
    pub fn samples_written(&self) -> u64 {
        self.samples
    }

    fn write_headers(&mut self) -> io::Result<()> {
        let mut head = Vec::with_capacity(19);
        head.extend_from_slice(b"OpusHead");
        head.push(1); // version
        head.push(1); // channels
        head.extend_from_slice(&self.pre_skip.to_le_bytes());
        head.extend_from_slice(&SAMPLE_RATE.to_le_bytes()); // input sample rate
        head.extend_from_slice(&0_i16.to_le_bytes()); // output gain
        head.push(0); // mapping family: mono/stereo
        self.pages
            .write_packet(head, self.serial, PacketWriteEndInfo::EndPage, 0)?;

        let mut tags = Vec::with_capacity(8 + 4 + VENDOR.len() + 4);
        tags.extend_from_slice(b"OpusTags");
        tags.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
        tags.extend_from_slice(VENDOR.as_bytes());
        tags.extend_from_slice(&0_u32.to_le_bytes()); // no user comments
        self.pages
            .write_packet(tags, self.serial, PacketWriteEndInfo::EndPage, 0)?;
        self.pages.inner_mut().flush()
    }

    /// Appends samples (any count; 10 ms frames are the usual).
    pub fn write(&mut self, samples: &[f32]) -> io::Result<()> {
        self.samples += samples.len() as u64;
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (PACKET_SAMPLES - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == PACKET_SAMPLES {
                self.encode_pending(None)?;
            }
        }
        Ok(())
    }

    /// Encodes `pending` as one packet. `last` carries the final granule
    /// position and ends the stream.
    fn encode_pending(&mut self, last: Option<u64>) -> io::Result<()> {
        self.pending.resize(PACKET_SAMPLES, 0.0);
        let length = self
            .encoder
            .encode_float(&self.pending, &mut self.packet)
            .map_err(codec_error)?;
        self.pending.clear();
        self.packets += 1;
        self.packets_in_page += 1;

        let (end, granule) = match last {
            Some(granule) => (PacketWriteEndInfo::EndStream, granule),
            None if self.packets_in_page >= PACKETS_PER_PAGE => (
                PacketWriteEndInfo::EndPage,
                self.packets * PACKET_SAMPLES as u64 * GRANULE_PER_SAMPLE,
            ),
            None => (
                PacketWriteEndInfo::NormalPacket,
                self.packets * PACKET_SAMPLES as u64 * GRANULE_PER_SAMPLE,
            ),
        };
        self.pages
            .write_packet(self.packet[..length].to_vec(), self.serial, end, granule)?;
        if end != PacketWriteEndInfo::NormalPacket {
            self.page_written()?;
        }
        Ok(())
    }

    fn page_written(&mut self) -> io::Result<()> {
        self.packets_in_page = 0;
        self.pages_since_sync += 1;
        if self.pages_since_sync >= PAGES_PER_SYNC {
            self.pages_since_sync = 0;
            self.pages.inner_mut().sync()
        } else {
            self.pages.inner_mut().flush()
        }
    }

    /// Ends the stream: encodes what is left plus the encoder's lookahead,
    /// marks the last page EOS with the exact end, syncs, and returns the
    /// sink.
    pub fn finish(mut self) -> io::Result<W> {
        let end_granule = u64::from(self.pre_skip) + self.samples * GRANULE_PER_SAMPLE;
        // Packets until the decoder has every input sample past the delay.
        let needed = end_granule.div_ceil(PACKET_SAMPLES as u64 * GRANULE_PER_SAMPLE);
        while self.packets + 1 < needed.max(1) {
            self.encode_pending(None)?;
        }
        self.encode_pending(Some(end_granule))?;
        let mut sink = self.pages.into_inner();
        sink.sync()?;
        Ok(sink)
    }
}

/// A channel file read back (see [`read`]).
#[derive(Debug)]
#[cfg_attr(
    not(test),
    allow(dead_code, reason = "the stream fields are checked by the tests")
)]
pub struct Decoded {
    /// Encoder delay at 48 kHz, from `OpusHead`.
    pub pre_skip: u16,
    /// The `OpusHead` input sample rate.
    pub input_rate: u32,
    /// Granule position of the last complete page read.
    pub last_granule: u64,
    /// Whether the stream's EOS page was reached.
    pub eos: bool,
    /// 16 kHz mono samples after the pre-skip, trimmed to the last granule.
    pub samples: Vec<f32>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// [`read_into`] a new buffer.
#[cfg(test)]
pub fn read<R: Read + Seek>(reader: R) -> io::Result<Decoded> {
    read_into(reader, Vec::new())
}

/// Decodes a mono Ogg Opus stream to 16 kHz into `pcm` (reserved by the
/// caller). Reads up to the end or the first broken page, so a file cut by a
/// crash gives everything up to its last complete page.
fn read_into<R: Read + Seek>(reader: R, mut pcm: Vec<f32>) -> io::Result<Decoded> {
    let mut pages = PacketReader::new(reader);
    let head = pages
        .read_packet()
        .map_err(io::Error::other)?
        .ok_or_else(|| invalid("empty Ogg stream"))?;
    if head.data.len() < 19 || &head.data[..8] != b"OpusHead" {
        return Err(invalid("not an Opus stream"));
    }
    if head.data[9] != 1 {
        return Err(invalid("not a mono Opus stream"));
    }
    let pre_skip = u16::from_le_bytes([head.data[10], head.data[11]]);
    let input_rate =
        u32::from_le_bytes([head.data[12], head.data[13], head.data[14], head.data[15]]);
    let tags = pages
        .read_packet()
        .map_err(io::Error::other)?
        .ok_or_else(|| invalid("no OpusTags"))?;
    if !tags.data.starts_with(b"OpusTags") {
        return Err(invalid("no OpusTags"));
    }

    let mut decoder = Decoder::new(SAMPLE_RATE, Channels::Mono).map_err(codec_error)?;
    let mut frame = vec![0.0; MAX_FRAME];
    let mut last_granule = 0;
    let mut eos = false;
    while let Ok(Some(packet)) = pages.read_packet() {
        let count = decoder
            .decode_float(&packet.data, &mut frame, false)
            .map_err(codec_error)?;
        pcm.extend_from_slice(&frame[..count]);
        if packet.last_in_page() {
            last_granule = packet.absgp_page();
        }
        eos |= packet.last_in_stream();
    }
    let to_samples =
        |granule: u64| usize::try_from(granule / GRANULE_PER_SAMPLE).unwrap_or(usize::MAX);
    let end = to_samples(last_granule).min(pcm.len());
    let skip = to_samples(u64::from(pre_skip)).min(end);
    pcm.truncate(end);
    pcm.drain(..skip);
    Ok(Decoded {
        pre_skip,
        input_rate,
        last_granule,
        eos,
        samples: pcm,
    })
}

/// A channel file as 16 kHz mono samples (see [`read_into`]). The buffer is
/// reserved from the last page's granule position up front: growing it by
/// doubling would hold up to twice a long call's samples.
pub fn read_file(path: &Path) -> io::Result<Vec<f32>> {
    let mut file = std::fs::File::open(path)?;
    let samples = last_granule(&mut file)?.map_or(0, |granule| {
        usize::try_from(granule / GRANULE_PER_SAMPLE).unwrap_or(0) + MAX_FRAME
    });
    // A broken page can't ask for more than this much audio per byte.
    let len = file.seek(io::SeekFrom::End(0))?;
    let bound = usize::try_from(len.saturating_mul(MAX_SAMPLES_PER_BYTE)).unwrap_or(usize::MAX);
    file.seek(io::SeekFrom::Start(0))?;
    let pcm = Vec::with_capacity(samples.min(bound));
    Ok(read_into(io::BufReader::new(file), pcm)?.samples)
}

/// An Ogg page header is at most this far from the end (255 segments of
/// 255 bytes after a 27 + 255 byte header).
const LAST_PAGE_SPAN: u64 = 27 + 255 + 255 * 255;
/// More 16 kHz samples than one byte of an Opus stream ever decodes to: a
/// 20 ms packet (320 samples) is never under 1 byte plus its lacing.
const MAX_SAMPLES_PER_BYTE: u64 = 320;

/// The granule position of the last page header in the file's tail.
fn last_granule(file: &mut std::fs::File) -> io::Result<Option<u64>> {
    let len = file.seek(io::SeekFrom::End(0))?;
    let from = len.saturating_sub(LAST_PAGE_SPAN);
    file.seek(io::SeekFrom::Start(from))?;
    let mut tail = Vec::new();
    file.take(LAST_PAGE_SPAN).read_to_end(&mut tail)?;
    let granule = (0..tail.len().saturating_sub(13))
        .rev()
        .find(|&at| tail[at..].starts_with(b"OggS\0"))
        .map(|at| {
            let mut bytes = [0; 8];
            bytes.copy_from_slice(&tail[at + 6..at + 14]);
            u64::from_le_bytes(bytes)
        })
        // -1: no packet ends on that page.
        .filter(|&granule| granule != u64::MAX);
    Ok(granule)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use super::*;

    /// Counts what the writer asks of the disk.
    #[derive(Default)]
    struct Sink {
        bytes: Vec<u8>,
        flushes: usize,
        syncs: usize,
    }

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.bytes.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    impl ChannelSink for Sink {
        fn sync(&mut self) -> io::Result<()> {
            self.syncs += 1;
            Ok(())
        }
    }

    fn sine(seconds: f64) -> Vec<f32> {
        let count = (seconds * f64::from(SAMPLE_RATE)) as usize;
        (0..count)
            .map(|n| {
                let t = n as f64 / f64::from(SAMPLE_RATE);
                (0.4 * (2.0 * std::f64::consts::PI * 300.0 * t).sin()) as f32
            })
            .collect()
    }

    fn write_all(samples: &[f32]) -> Sink {
        let mut writer = OggOpusWriter::new(Sink::default()).unwrap();
        for frame in samples.chunks(160) {
            writer.write(frame).unwrap();
        }
        writer.finish().unwrap()
    }

    fn decode(bytes: Vec<u8>) -> Decoded {
        let decoded = read(Cursor::new(bytes)).unwrap();
        assert!(decoded.pre_skip > 0);
        decoded
    }

    fn rms(samples: &[f32]) -> f64 {
        let sum: f64 = samples.iter().map(|v| f64::from(*v).powi(2)).sum();
        (sum / samples.len().max(1) as f64).sqrt()
    }

    #[test]
    fn a_file_decodes_into_a_buffer_reserved_once() {
        let input = sine(30.0);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("me.opus");
        std::fs::write(&path, write_all(&input).bytes).unwrap();

        let samples = read_file(&path).unwrap();
        assert!(
            samples.len().abs_diff(input.len()) <= 320,
            "{}",
            samples.len()
        );
        // Reserved from the last granule: no doubling on the way.
        assert!(
            samples.capacity() <= samples.len() + 2 * MAX_FRAME,
            "{} for {}",
            samples.capacity(),
            samples.len()
        );
        assert_eq!(
            last_granule(&mut std::fs::File::open(&path).unwrap()).unwrap(),
            Some(decode(std::fs::read(&path).unwrap()).last_granule)
        );
    }

    #[test]
    fn sine_decodes_back_with_the_same_duration() {
        let input = sine(3.0);
        let sink = write_all(&input);
        let decoded = decode(sink.bytes);

        assert!(decoded.eos);
        assert_eq!(decoded.input_rate, SAMPLE_RATE);
        assert!(decoded.pre_skip > 0);
        let duration = decoded.samples.len() as f64 / f64::from(SAMPLE_RATE);
        assert!((duration - 3.0).abs() <= 0.020, "decoded {duration} s");
        let granule_duration =
            (decoded.last_granule - u64::from(decoded.pre_skip)) as f64 / f64::from(GRANULE_RATE);
        assert!(
            (granule_duration - 3.0).abs() <= 0.020,
            "{granule_duration} s"
        );

        // Same signal: level within 1 dB and in phase after the pre-skip.
        let middle = 16_000..32_000;
        let ratio = rms(&decoded.samples[middle.clone()]) / rms(&input[middle.clone()]);
        assert!((20.0 * ratio.log10()).abs() < 1.0, "level ratio {ratio}");
        let dot: f64 = middle
            .clone()
            .map(|i| f64::from(decoded.samples[i]) * f64::from(input[i]))
            .sum();
        let correlation = dot
            / (rms(&input[middle.clone()])
                * rms(&decoded.samples[middle.clone()])
                * middle.len() as f64);
        assert!(correlation > 0.9, "correlation {correlation}");
    }

    #[test]
    fn odd_lengths_and_empty_streams_finish() {
        for samples in [0, 1, 159, 321, 16_001] {
            let decoded = decode(write_all(&vec![0.1; samples]).bytes);
            assert!(decoded.eos);
            assert_eq!(decoded.samples.len(), samples, "{samples} samples");
        }
    }

    #[test]
    fn pages_reach_the_os_every_second_and_the_disk_every_5() {
        let mut writer = OggOpusWriter::new(Sink::default()).unwrap();
        let after_headers = writer.pages.inner_mut().flushes;
        for frame in sine(10.0).chunks(160) {
            writer.write(frame).unwrap();
        }
        let sink = writer.pages.inner_mut();
        // 10 pages: 8 flushed, 2 synced.
        assert_eq!(sink.flushes - after_headers, 8);
        assert_eq!(sink.syncs, 2);
        let sink = writer.finish().unwrap();
        assert_eq!(sink.syncs, 3);
    }

    #[test]
    fn truncated_file_reads_up_to_its_last_complete_page() {
        let mut writer = OggOpusWriter::new(Sink::default()).unwrap();
        for frame in sine(5.5).chunks(160) {
            writer.write(frame).unwrap();
        }
        // The app dies: 5 full pages on disk, the sixth cut in the middle.
        let mut bytes = std::mem::take(&mut writer.pages.inner_mut().bytes);
        drop(writer);
        let pages_end = bytes.len();
        bytes.extend_from_slice(b"OggS\0\0\x01\x02");
        let cut_in_page = pages_end + 5;
        bytes.truncate(cut_in_page);

        let decoded = decode(bytes);
        assert!(!decoded.eos);
        let duration = decoded.samples.len() as f64 / f64::from(SAMPLE_RATE);
        assert!(
            (duration - (5.0 - f64::from(decoded.pre_skip) / 48_000.0)).abs() <= 0.020,
            "{duration} s"
        );
    }

    #[test]
    fn truncated_mid_page_drops_only_that_page() {
        let sink = write_all(&sine(4.0));
        let full = sink.bytes;
        // Cut the last page in half: everything before it decodes.
        let last_page = full.windows(4).rposition(|w| w == b"OggS").unwrap();
        let cut = last_page + (full.len() - last_page) / 2;
        let decoded = decode(full[..cut].to_vec());
        assert!(!decoded.eos);
        let duration = decoded.samples.len() as f64 / f64::from(SAMPLE_RATE);
        assert!((2.9..=4.0).contains(&duration), "{duration} s");
        assert_eq!(decoded.last_granule % (PACKET_SAMPLES as u64 * 3), 0);
    }

    /// 20 kbit/s VBR: an hour of speech-like sound or noise stays under
    /// 12.5 MB per channel.
    #[test]
    fn an_hour_fits_in_12_5_mb() {
        let mut seed = 0x2545_f491_u32;
        let mut noise = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (f64::from(seed) / f64::from(u32::MAX)) * 2.0 - 1.0
        };
        let seconds = 30.0;
        let count = (seconds * f64::from(SAMPLE_RATE)) as usize;
        let speech: Vec<f32> = (0..count)
            .map(|n| {
                let t = n as f64 / f64::from(SAMPLE_RATE);
                let syllable = (t * 4.0) % 1.0;
                if t % 2.5 >= 1.8 {
                    return (0.002 * noise()) as f32;
                }
                let envelope = (std::f64::consts::PI * syllable).sin().powi(2);
                let f0 = 140.0 + 30.0 * (t * 1.3).sin();
                let voiced: f64 = (1..=12)
                    .map(|h| {
                        let h = f64::from(h);
                        let formant = 1.0 / (1.0 + ((h * f0 - 700.0) / 400.0).powi(2));
                        formant * (2.0 * std::f64::consts::PI * h * f0 * t).sin()
                    })
                    .sum();
                (0.25 * envelope * voiced + 0.01 * noise() * envelope) as f32
            })
            .collect();
        let white: Vec<f32> = (0..count).map(|_| (0.1 * noise()) as f32).collect();

        for (name, signal) in [("speech", speech), ("noise", white)] {
            let bytes = write_all(&signal).bytes.len() as f64;
            let per_hour = bytes / seconds * 3_600.0;
            assert!(
                per_hour <= 12.5e6,
                "{name}: {:.1} MB per hour",
                per_hour / 1e6
            );
        }
    }
}
