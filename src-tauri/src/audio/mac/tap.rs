//! System audio with a Core Audio process tap (macOS 14.2+), from
//! `spikes/audio/src/mac/tap.rs`:
//!
//! `CATapDescription` (stereo global tap without our own process)
//! → `AudioHardwareCreateProcessTap` → private aggregate device with the tap
//! and no sub-device → IOProc: the tap's audio arrives as the aggregate's
//! input. The IO starts only once something plays.

use std::{
    ffi::c_void,
    ptr::NonNull,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
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

use super::hal::{self, check};
use crate::audio::level::Feed;

/// `kAudioFormatFlagIsFloat`.
const FORMAT_FLAG_IS_FLOAT: u32 = 1;
/// `kAudioObjectUnknown`.
const UNKNOWN_OBJECT: AudioObjectID = 0;

fn any<T: objc2::Message>(object: &T) -> &AnyObject {
    // SAFETY: every Objective-C object is an AnyObject.
    unsafe { &*(std::ptr::from_ref(object).cast::<AnyObject>()) }
}

/// A running tap; dropping it stops the IO and destroys the aggregate
/// device and the tap.
pub struct SystemTap {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    io_proc: AudioDeviceIOProcID,
    /// The IOProc's context; lives as long as the IOProc.
    feed: Arc<Feed>,
}

unsafe extern "C-unwind" fn io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    context: *mut c_void,
) -> i32 {
    // SAFETY: `context` is the `Arc<Feed>` the `SystemTap` keeps alive until
    // the IOProc is destroyed.
    let feed = unsafe { &*context.cast::<Feed>() };
    // SAFETY: Core Audio passes a valid buffer list for the callback's duration.
    let list = unsafe { input.as_ref() };
    let count = list.mNumberBuffers as usize;
    // SAFETY: `mBuffers` is a variable-length array of `mNumberBuffers`.
    let buffers: &[AudioBuffer] =
        unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), count) };
    for buffer in buffers {
        if buffer.mData.is_null() {
            continue;
        }
        let samples = buffer.mDataByteSize as usize / size_of::<f32>();
        // SAFETY: the tap's format is checked to be 32-bit float.
        let samples = unsafe { std::slice::from_raw_parts(buffer.mData.cast::<f32>(), samples) };
        feed.push(samples.iter().copied());
    }
    0
}

static NEXT_AGGREGATE: AtomicU32 = AtomicU32::new(0);

impl SystemTap {
    /// Starts a tap of everything that plays except this process. On the
    /// first tap macOS asks for "Запись системного аудио"; without the
    /// access the tap gives silence.
    pub fn start(feed: Feed) -> Result<Self, String> {
        let own_object =
            hal::process_object_for_pid(i32::try_from(std::process::id()).unwrap_or(0));
        let exclude: Vec<Retained<NSNumber>> = if own_object == 0 {
            Vec::new()
        } else {
            vec![NSNumber::new_u32(own_object)]
        };
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
            feed: Arc::new(feed),
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
        // SAFETY: the context (`feed`) outlives the IOProc: both live in `Self`.
        check(
            unsafe {
                AudioDeviceCreateIOProcID(
                    running.aggregate,
                    Some(io_proc),
                    Arc::as_ptr(&running.feed).cast_mut().cast(),
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

impl Drop for SystemTap {
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
        }
    }
}
