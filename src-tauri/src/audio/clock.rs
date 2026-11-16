//! The host clock the capture blocks are stamped with (audio-capture
//! design.md, decision 9): one monotonic nanosecond clock for the
//! microphone, system audio and the recorder.
//!
//! - macOS: `mach_absolute_time` in nanoseconds. The tap's `mHostTime` and
//!   `cpal`'s CoreAudio `StreamInstant` (also `mHostTime`, converted with
//!   `mach_timebase_info`) are on it.
//! - Windows: `QueryPerformanceCounter` on a 100-ns grid, in nanoseconds.
//!   `IAudioCaptureClient::GetBuffer`'s QPC position and `cpal`'s WASAPI
//!   `StreamInstant` are on it.
//! - Elsewhere: an `Instant` since the first call; devices give no stamp
//!   there, so blocks are stamped "now minus the block".
//!
//! Every function here is cheap and allocation-free: capture callbacks
//! call them.

const NANOS_PER_SECOND: u128 = 1_000_000_000;

/// Mach ticks → nanoseconds with the timebase `numer / denom`, the way
/// `cpal` converts `mHostTime` (so both land on the same nanosecond).
#[cfg(any(target_os = "macos", test))]
pub fn mach_ticks_to_ns(ticks: u64, numer: u32, denom: u32) -> u64 {
    if denom == 0 {
        return ticks;
    }
    let nanos = u128::from(ticks) * u128::from(numer) / u128::from(denom);
    u64::try_from(nanos).unwrap_or(u64::MAX)
}

/// A WASAPI QPC position (100-ns units) → nanoseconds.
#[cfg_attr(not(any(windows, test)), allow(dead_code, reason = "Windows only"))]
pub const fn hundred_ns_to_ns(units: u64) -> u64 {
    units.saturating_mul(100)
}

/// A raw QPC counter → nanoseconds, through 100-ns units like `cpal` and
/// `GetBuffer`, so all three share one grid.
#[cfg_attr(not(any(windows, test)), allow(dead_code, reason = "Windows only"))]
pub fn qpc_to_ns(counter: u64, frequency: u64) -> u64 {
    if frequency == 0 {
        return 0;
    }
    let units = u128::from(counter) * 10_000_000 / u128::from(frequency);
    hundred_ns_to_ns(u64::try_from(units).unwrap_or(u64::MAX))
}

/// How long `frames` last at `rate`, in nanoseconds.
pub fn frames_to_ns(frames: usize, rate: u32) -> u64 {
    if rate == 0 {
        return 0;
    }
    let nanos = (frames as u128) * NANOS_PER_SECOND / u128::from(rate);
    u64::try_from(nanos).unwrap_or(u64::MAX)
}

/// The fallback stamp of a block without one: it was captured just
/// before the callback that delivers it, `now − its duration`.
pub fn block_start_ns(now_ns: u64, frames: usize, rate: u32) -> u64 {
    now_ns.saturating_sub(frames_to_ns(frames, rate))
}

/// A device stamp further than this from the callback's "now" is not
/// believed: device buffers and latency are milliseconds, not seconds.
pub const STAMP_TOLERANCE_NS: u64 = 2 * NANOS_PER_SECOND as u64;

/// The stamp of a block delivered at `now_ns`: the device's, unless it is
/// missing, zero (`mHostTime` left unset) or implausibly far from now (a
/// bogus QPC position, a clock that jumped), then [`block_start_ns`]. One
/// bad stamp would otherwise cut the channel or pad it with hours of
/// silence.
pub fn block_stamp_ns(stamp: Option<u64>, now_ns: u64, frames: usize, rate: u32) -> u64 {
    stamp
        .filter(|stamp| *stamp != 0 && stamp.abs_diff(now_ns) <= STAMP_TOLERANCE_NS)
        .unwrap_or_else(|| block_start_ns(now_ns, frames, rate))
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::OnceLock;

    static TIMEBASE: OnceLock<(u32, u32)> = OnceLock::new();

    /// `mach_timebase_info`, read once.
    #[allow(deprecated, reason = "libc points at the mach2 crate; same symbols")]
    pub fn timebase() -> (u32, u32) {
        *TIMEBASE.get_or_init(|| {
            let mut info = libc::mach_timebase_info { numer: 0, denom: 0 };
            // SAFETY: `info` is a valid out-pointer.
            let status = unsafe { libc::mach_timebase_info(&raw mut info) };
            if status == 0 && info.denom != 0 {
                (info.numer, info.denom)
            } else {
                (1, 1)
            }
        })
    }

    #[allow(deprecated, reason = "libc points at the mach2 crate; same symbol")]
    pub fn now_ns() -> u64 {
        // SAFETY: no arguments, no side effects.
        let ticks = unsafe { libc::mach_absolute_time() };
        host_ticks_to_ns(ticks)
    }

    /// An `AudioTimeStamp.mHostTime` → nanoseconds of [`now_ns`].
    pub fn host_ticks_to_ns(ticks: u64) -> u64 {
        let (numer, denom) = timebase();
        super::mach_ticks_to_ns(ticks, numer, denom)
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::OnceLock;

    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

    static FREQUENCY: OnceLock<u64> = OnceLock::new();

    fn frequency() -> u64 {
        *FREQUENCY.get_or_init(|| {
            let mut frequency = 0i64;
            // SAFETY: a valid out-pointer.
            let read = unsafe { QueryPerformanceFrequency(&raw mut frequency) };
            if read.is_ok() {
                u64::try_from(frequency).unwrap_or(0)
            } else {
                0
            }
        })
    }

    pub fn now_ns() -> u64 {
        let mut counter = 0i64;
        // SAFETY: a valid out-pointer.
        if unsafe { QueryPerformanceCounter(&raw mut counter) }.is_err() {
            return 0;
        }
        super::qpc_to_ns(u64::try_from(counter).unwrap_or(0), frequency())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use std::{sync::OnceLock, time::Instant};

    static EPOCH: OnceLock<Instant> = OnceLock::new();

    pub fn now_ns() -> u64 {
        let epoch = EPOCH.get_or_init(Instant::now);
        u64::try_from(epoch.elapsed().as_nanos()).unwrap_or(u64::MAX)
    }
}

#[cfg(target_os = "macos")]
pub use platform::host_ticks_to_ns;

/// Now on the host clock, in nanoseconds.
pub fn now_ns() -> u64 {
    platform::now_ns()
}

/// Reads the clock once so a capture callback never pays for the first
/// read (the timebase on macOS).
pub fn warm_up() {
    let _ = now_ns();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording::timeline::Timeline;

    const MS: u64 = 1_000_000;

    #[test]
    fn mach_ticks_convert_like_cpal() {
        // Apple silicon: 125/3 (24 MHz ticks); Intel: 1/1.
        assert_eq!(mach_ticks_to_ns(24_000_000, 125, 3), 1_000_000_000);
        assert_eq!(mach_ticks_to_ns(1_234_567, 1, 1), 1_234_567);
        // No overflow on a machine that has been up for a year.
        let year_of_ticks = 24_000_000u64 * 3600 * 24 * 365;
        assert_eq!(
            mach_ticks_to_ns(year_of_ticks, 125, 3),
            1_000_000_000 * 3600 * 24 * 365
        );
        assert_eq!(mach_ticks_to_ns(5, 1, 0), 5, "a broken timebase");
    }

    #[test]
    fn qpc_positions_land_on_a_100_ns_grid() {
        assert_eq!(hundred_ns_to_ns(10_000_000), 1_000_000_000);
        // A 10 MHz counter is 100-ns units already.
        assert_eq!(qpc_to_ns(12_345_678, 10_000_000), 1_234_567_800);
        // A 3 MHz counter: 1 tick ≈ 333 ns, floored to the grid.
        assert_eq!(qpc_to_ns(1, 3_000_000), 300);
        assert_eq!(qpc_to_ns(3_000_000, 3_000_000), 1_000_000_000);
        assert_eq!(qpc_to_ns(1, 0), 0);
    }

    #[test]
    fn a_block_without_a_stamp_ends_now() {
        // 480 frames at 48 kHz = 10 ms.
        assert_eq!(block_start_ns(1_000 * MS, 480, 48_000), 990 * MS);
        assert_eq!(block_start_ns(MS, 48_000, 48_000), 0, "saturates");
        assert_eq!(frames_to_ns(441, 44_100), 10 * MS);
        assert_eq!(frames_to_ns(10, 0), 0);
    }

    #[test]
    fn implausible_stamps_fall_back_to_now() {
        let now = 3_600_000 * MS;
        let fallback = now - 10 * MS;
        // A device stamp a few ms back is kept.
        assert_eq!(
            block_stamp_ns(Some(now - 25 * MS), now, 480, 48_000),
            now - 25 * MS
        );
        assert_eq!(block_stamp_ns(None, now, 480, 48_000), fallback);
        // `mHostTime` == 0 (or a zero QPC position).
        assert_eq!(block_stamp_ns(Some(0), now, 480, 48_000), fallback);
        // Far in the future or the past.
        assert_eq!(
            block_stamp_ns(Some(now + 3_600_000 * MS), now, 480, 48_000),
            fallback
        );
        assert_eq!(
            block_stamp_ns(Some(now - 60_000 * MS), now, 480, 48_000),
            fallback
        );
        assert_eq!(
            block_stamp_ns(Some(now + STAMP_TOLERANCE_NS), now, 480, 48_000),
            now + STAMP_TOLERANCE_NS,
            "the edge is still believed"
        );
    }

    /// Stamps of each source become timeline positions (16 kHz samples
    /// since the recording started).
    #[test]
    fn stamps_become_timeline_positions() {
        // macOS: t0 and a tap block 1.5 s later, both in mach ticks.
        let (numer, denom) = (125, 3);
        let t0_ticks = 24_000_000 * 100;
        let block_ticks = t0_ticks + 36_000_000;
        let timeline = Timeline::new(mach_ticks_to_ns(t0_ticks, numer, denom));
        let position = timeline.position_of(mach_ticks_to_ns(block_ticks, numer, denom));
        assert!((position - 24_000.0).abs() < 1e-6, "{position}");

        // Windows: GetBuffer's QPC position (100-ns units), 250 ms after t0.
        let t0 = hundred_ns_to_ns(50_000_000);
        let timeline = Timeline::new(t0);
        let position = timeline.position_of(hundred_ns_to_ns(50_000_000 + 2_500_000));
        assert!((position - 4_000.0).abs() < 1e-6, "{position}");

        // No stamp: 10 ms at 48 kHz delivered 1 s after t0 started 990 ms in.
        let timeline = Timeline::new(5_000 * MS);
        let start = block_start_ns(6_000 * MS, 480, 48_000);
        let position = timeline.position_of(start);
        assert!((position - 15_840.0).abs() < 1e-6, "{position}");

        // A block from before the start is negative (its head is cut).
        assert!(timeline.position_of(4_990 * MS) < 0.0);
    }

    #[test]
    fn the_host_clock_moves_forward() {
        warm_up();
        let first = now_ns();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = now_ns();
        assert!(second > first);
        let elapsed = second - first;
        assert!((4 * MS..500 * MS).contains(&elapsed), "{elapsed}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mach_host_time_is_the_clock() {
        #[allow(deprecated)]
        // SAFETY: no arguments.
        let ticks = unsafe { libc::mach_absolute_time() };
        let stamped = host_ticks_to_ns(ticks);
        let now = now_ns();
        assert!(now >= stamped && now - stamped < 50 * MS);
    }
}
