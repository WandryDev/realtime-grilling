//! System audio with a Core Audio process tap (macOS 14.2+), from
//! `spikes/audio/src/mac/tap.rs`:
//!
//! `CATapDescription` (stereo global tap without our own processes)
//! → `AudioHardwareCreateProcessTap` → private aggregate device with the tap
//! and no sub-device → IOProc: the tap's audio arrives as the aggregate's
//! input. The IO starts only once something plays.

use std::{
    ffi::c_void,
    ptr::NonNull,
    sync::atomic::{AtomicU32, Ordering},
};

use objc2::{AllocAnyThread, rc::Retained, runtime::AnyObject};
use objc2_core_audio::{
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap, AudioObjectID,
    CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSMutableDictionary, NSNumber, NSString};

use super::{
    hal::{self, check},
    process,
};
use crate::audio::{
    clock,
    sink::{BlockFormat, SampleSink},
};

/// `kAudioFormatFlagIsFloat`.
const FORMAT_FLAG_IS_FLOAT: u32 = 1;
/// `kAudioObjectUnknown`.
const UNKNOWN_OBJECT: AudioObjectID = 0;
/// `kAudioTimeStampHostTimeValid`.
const HOST_TIME_VALID: u32 = 1 << 1;

fn any<T: objc2::Message>(object: &T) -> &AnyObject {
    // SAFETY: every Objective-C object is an AnyObject.
    unsafe { &*(std::ptr::from_ref(object).cast::<AnyObject>()) }
}

/// What the IOProc gets as its context: the sink and the IO's rate.
struct Context<S> {
    sink: S,
    sample_rate: u32,
}

/// A running tap; dropping it stops the IO and destroys the aggregate
/// device and the tap.
pub struct SystemTap<S: SampleSink> {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    io_proc: AudioDeviceIOProcID,
    /// The IOProc's context (`Box::into_raw`); freed after the IOProc is
    /// destroyed.
    context: *mut Context<S>,
}

// SAFETY: the context is only touched by the IOProc (one HAL thread) while
// it runs, and by `Drop` after it stopped; `S` itself is `Send`.
unsafe impl<S: SampleSink> Send for SystemTap<S> {}

/// The host time of the input's first frame, when the HAL set it.
fn host_time(stamp: &AudioTimeStamp) -> Option<u64> {
    (stamp.mFlags.0 & HOST_TIME_VALID != 0).then(|| clock::host_ticks_to_ns(stamp.mHostTime))
}

unsafe extern "C-unwind" fn io_proc<S: SampleSink>(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    context: *mut c_void,
) -> i32 {
    // SAFETY: `context` is the `Context<S>` the `SystemTap` keeps alive
    // until the IOProc is destroyed; the HAL calls an IOProc on one thread.
    let context = unsafe { &mut *context.cast::<Context<S>>() };
    // SAFETY: Core Audio passes valid structures for the callback's duration.
    let (list, stamp) = unsafe { (input.as_ref(), input_time.as_ref()) };
    let host_time = host_time(stamp);
    let count = list.mNumberBuffers as usize;
    // SAFETY: `mBuffers` is a variable-length array of `mNumberBuffers`.
    let buffers: &[AudioBuffer] =
        unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), count) };
    // The tap is interleaved: one buffer. A non-interleaved one gives a
    // buffer per channel at the same time; the first stands for them all
    // (two blocks with one stamp would double the duration).
    if let Some(buffer) = buffers.iter().find(|buffer| !buffer.mData.is_null()) {
        let samples = buffer.mDataByteSize as usize / size_of::<f32>();
        // SAFETY: the tap's format is checked to be 32-bit float.
        let samples = unsafe { std::slice::from_raw_parts(buffer.mData.cast::<f32>(), samples) };
        let format = BlockFormat {
            channels: u16::try_from(buffer.mNumberChannels.max(1)).unwrap_or(1),
            sample_rate: context.sample_rate,
        };
        context
            .sink
            .push(format, host_time, samples.iter().copied());
    }
    0
}

static NEXT_AGGREGATE: AtomicU32 = AtomicU32::new(0);

impl<S: SampleSink> SystemTap<S> {
    /// Starts a tap of everything that plays except this app: our process
    /// and the WebKit processes playing our webview's sound (macOS holds us
    /// responsible for them). The list is taken now: one of ours that
    /// becomes an audio client later (the webview plays its first sound
    /// mid-recording) is not excluded until the tap is opened again. On the
    /// first tap macOS asks for "Запись системного аудио"; without the
    /// access the tap gives silence.
    pub fn start(sink: S) -> Result<Self, String> {
        let mut own = process::own_process_objects();
        let own_object =
            hal::process_object_for_pid(i32::try_from(std::process::id()).unwrap_or(0));
        if own_object != 0 && !own.contains(&own_object) {
            own.push(own_object);
        }
        let exclude: Vec<Retained<NSNumber>> = own.into_iter().map(NSNumber::new_u32).collect();
        let exclude = NSArray::from_retained_slice(&exclude);
        // SAFETY: plain Objective-C calls on a fresh description.
        let description = unsafe {
            CATapDescription::initStereoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &exclude,
            )
        };
        unsafe {
            description.setName(&NSString::from_str("Grill level"));
            description.setPrivate(true);
            description.setMuteBehavior(CATapMuteBehavior::Unmuted);
        }
        let mut tap: AudioObjectID = 0;
        // SAFETY: `tap` receives the new object's id.
        check(
            unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap) },
            "AudioHardwareCreateProcessTap",
        )?;
        // From here on `Drop` releases whatever was created.
        let mut running = Self {
            tap,
            aggregate: UNKNOWN_OBJECT,
            io_proc: None,
            context: Box::into_raw(Box::new(Context {
                sink,
                sample_rate: 48_000,
            })),
        };

        let format: AudioStreamBasicDescription =
            hal::get(tap, hal::TAP_FORMAT, hal::SCOPE_GLOBAL)?;
        if format.mFormatFlags & FORMAT_FLAG_IS_FLOAT == 0 || format.mBitsPerChannel != 32 {
            return Err(format!(
                "Неожиданный формат системного звука: флаги {:#x}, {} бит",
                format.mFormatFlags, format.mBitsPerChannel
            ));
        }

        let tap_uid = hal::get_string(tap, hal::TAP_UID, hal::SCOPE_GLOBAL)?;

        let key = NSString::from_str;
        let tap_entry = NSMutableDictionary::<NSString, AnyObject>::new();
        tap_entry.insert(&*key("uid"), any(&*key(&tap_uid))); // kAudioSubTapUIDKey
        tap_entry.insert(&*key("drift"), any(&*NSNumber::new_bool(true))); // kAudioSubTapDriftCompensationKey

        let number = NEXT_AGGREGATE.fetch_add(1, Ordering::Relaxed);
        let aggregate_uid = format!("grill-level-tap-{}-{number}", std::process::id());
        let options = NSMutableDictionary::<NSString, AnyObject>::new();
        options.insert(&*key("name"), any(&*key("Grill level"))); // kAudioAggregateDeviceNameKey
        options.insert(&*key("uid"), any(&*key(&aggregate_uid))); // kAudioAggregateDeviceUIDKey
        options.insert(&*key("private"), any(&*NSNumber::new_bool(true))); // kAudioAggregateDeviceIsPrivateKey
        options.insert(&*key("stacked"), any(&*NSNumber::new_bool(false))); // kAudioAggregateDeviceIsStackedKey
        options.insert(&*key("tapautostart"), any(&*NSNumber::new_bool(true))); // kAudioAggregateDeviceTapAutoStartKey
        options.insert(
            &*key("taps"),
            any(&*NSArray::from_retained_slice(&[tap_entry])),
        ); // kAudioAggregateDeviceTapListKey
        // SAFETY: NSDictionary is toll-free bridged to CFDictionary.
        let options: &CFDictionary =
            unsafe { &*(std::ptr::from_ref(&*options).cast::<CFDictionary>()) };

        // SAFETY: `aggregate` receives the new device's id.
        check(
            unsafe {
                AudioHardwareCreateAggregateDevice(options, NonNull::from(&mut running.aggregate))
            },
            "AudioHardwareCreateAggregateDevice",
        )?;
        // The IO runs at the aggregate's rate (the tap's when it can't tell).
        let rate = hal::get::<f64>(
            running.aggregate,
            hal::NOMINAL_SAMPLE_RATE,
            hal::SCOPE_GLOBAL,
        )
        .ok()
        .filter(|rate| *rate > 0.0)
        .unwrap_or(format.mSampleRate);
        // SAFETY: the IOProc does not exist yet.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        unsafe {
            (*running.context).sample_rate = rate.round() as u32;
        }
        // SAFETY: the context outlives the IOProc: `Drop` frees it last.
        check(
            unsafe {
                AudioDeviceCreateIOProcID(
                    running.aggregate,
                    Some(io_proc::<S>),
                    running.context.cast(),
                    NonNull::from(&mut running.io_proc),
                )
            },
            "AudioDeviceCreateIOProcID",
        )?;
        // SAFETY: the IOProc was created on this device.
        check(
            unsafe { AudioDeviceStart(running.aggregate, running.io_proc) },
            "AudioDeviceStart",
        )?;
        Ok(running)
    }
}

impl<S: SampleSink> Drop for SystemTap<S> {
    fn drop(&mut self) {
        // SAFETY: the ids belong to this tap and are destroyed once, in the
        // reverse order of creation; the unset ones are skipped.
        unsafe {
            if self.io_proc.is_some() {
                AudioDeviceStop(self.aggregate, self.io_proc);
                AudioDeviceDestroyIOProcID(self.aggregate, self.io_proc);
            }
            if self.aggregate != UNKNOWN_OBJECT {
                AudioHardwareDestroyAggregateDevice(self.aggregate);
            }
            AudioHardwareDestroyProcessTap(self.tap);
            // The IOProc is gone: nothing else points at the context.
            drop(Box::from_raw(self.context));
        }
    }
}
