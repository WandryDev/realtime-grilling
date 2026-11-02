//! Item 2: system audio capture with a Core Audio process tap (macOS 14.2+).
//!
//! CATapDescription(stereo global tap, excluding our own process object)
//!   -> AudioHardwareCreateProcessTap
//!   -> private aggregate device with the tap in kAudioAggregateDeviceTapListKey
//!   -> AudioDeviceCreateIOProcID + AudioDeviceStart: tap audio arrives as *input* of the aggregate.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use objc2::AllocAnyThread;
use objc2::runtime::AnyObject;
use objc2_core_audio::{
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop,
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice,
    AudioHardwareDestroyProcessTap, AudioObjectID, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSMutableDictionary, NSNumber, NSString};

use super::hal::{self, check};

fn any<T: objc2::Message>(x: &T) -> &AnyObject {
    // SAFETY: every Objective-C object is an AnyObject.
    unsafe { &*(std::ptr::from_ref(x).cast::<AnyObject>()) }
}

struct Sink {
    samples: Mutex<Vec<f32>>,
    channels: std::sync::atomic::AtomicU32,
    callbacks: std::sync::atomic::AtomicU64,
    first_cb: Mutex<Option<Instant>>,
    /// (expected next mSampleTime, number of gaps, total gap frames, wall-clock of last callback)
    timing: Mutex<(f64, u32, f64, Option<Instant>, f64)>,
}

unsafe extern "C-unwind" fn io_proc(
    _dev: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    ctx: *mut c_void,
) -> i32 {
    let sink = unsafe { &*(ctx as *const Sink) };
    let abl = unsafe { input.as_ref() };
    if abl.mNumberBuffers == 0 {
        return 0;
    }
    let b = &abl.mBuffers[0];
    if b.mData.is_null() {
        return 0;
    }
    let n = b.mDataByteSize as usize / 4;
    let s = unsafe { std::slice::from_raw_parts(b.mData.cast::<f32>(), n) };
    sink.channels.store(b.mNumberChannels, std::sync::atomic::Ordering::Relaxed);
    if sink.callbacks.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
        *sink.first_cb.lock().unwrap() = Some(Instant::now());
    }
    sink.samples.lock().unwrap().extend_from_slice(s);
    let st = unsafe { input_time.as_ref() }.mSampleTime;
    let frames = (n / b.mNumberChannels.max(1) as usize) as f64;
    let now = Instant::now();
    let mut t = sink.timing.lock().unwrap();
    if t.3.is_some() && (st - t.0).abs() > 1.0 {
        t.1 += 1;
        t.2 += st - t.0;
    }
    if let Some(prev) = t.3 {
        t.4 = t.4.max(now.duration_since(prev).as_secs_f64());
    }
    t.0 = st + frames;
    t.3 = Some(now);
    0
}

pub struct TapResult {
    pub rate: f64,
    pub channels: u32,
    /// interleaved
    pub samples: Vec<f32>,
}

pub struct TapOpts {
    pub secs: f64,
    pub exclude_self: bool,
    /// Called once the tap is running (e.g. to start a player).
    pub on_running: Option<Box<dyn FnOnce() + Send>>,
    /// Main sub-device of the aggregate: None = default output, Some("none") = tap-only aggregate.
    pub main_device: Option<String>,
}

pub fn record(o: TapOpts) -> Result<TapResult> {
    let t0 = Instant::now();
    let own_pid = std::process::id() as i32;
    let own_obj = hal::process_object_for_pid(own_pid);
    let exclude: Vec<objc2::rc::Retained<NSNumber>> = if o.exclude_self && own_obj != 0 {
        vec![NSNumber::new_u32(own_obj)]
    } else {
        vec![]
    };
    eprintln!(
        "own pid={own_pid} process-object={own_obj} ({}); exclude_self={}",
        if own_obj == 0 { "not an audio client yet" } else { "audio client" },
        o.exclude_self
    );
    let exclude_arr = NSArray::from_retained_slice(&exclude);

    let desc = unsafe { CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &exclude_arr) };
    unsafe {
        desc.setName(&NSString::from_str("audio-spike tap"));
        desc.setPrivate(true);
        desc.setMuteBehavior(CATapMuteBehavior::Unmuted);
    }
    let mut tap_id: AudioObjectID = 0;
    check(unsafe { AudioHardwareCreateProcessTap(Some(&desc), &mut tap_id) }, "AudioHardwareCreateProcessTap")?;
    let tap_uid = hal::get_string(tap_id, hal::TAP_UID, hal::SCOPE_GLOBAL)?;
    let fmt: AudioStreamBasicDescription = hal::get(tap_id, hal::TAP_FORMAT, hal::SCOPE_GLOBAL)?;
    eprintln!(
        "tap id={tap_id} uid={tap_uid} format: {} Hz, {} ch, flags={:#x}, {} bits  (created in {:.1} ms)",
        fmt.mSampleRate,
        fmt.mChannelsPerFrame,
        fmt.mFormatFlags,
        fmt.mBitsPerChannel,
        t0.elapsed().as_secs_f64() * 1e3
    );

    let out_dev = match o.main_device.as_deref() {
        None => Some(hal::default_output()?),
        Some("none") => None,
        Some(n) => Some(hal::find_device(n, hal::SCOPE_OUTPUT)?),
    };
    let agg_uid = format!("audio-spike-agg-{}", std::process::id());

    let tap_entry = NSMutableDictionary::<NSString, AnyObject>::new();
    tap_entry.insert(&*NSString::from_str("uid"), any(&*NSString::from_str(&tap_uid))); // kAudioSubTapUIDKey
    tap_entry.insert(&*NSString::from_str("drift"), any(&*NSNumber::new_bool(true))); // kAudioSubTapDriftCompensationKey

    let d = NSMutableDictionary::<NSString, AnyObject>::new();
    let k = |s: &str| NSString::from_str(s);
    d.insert(&*k("name"), any(&*k("audio-spike tap aggregate"))); // kAudioAggregateDeviceNameKey
    d.insert(&*k("uid"), any(&*k(&agg_uid))); // kAudioAggregateDeviceUIDKey
    if let Some(dev) = out_dev {
        let out_uid = hal::device_uid(dev)?;
        let sub_entry = NSMutableDictionary::<NSString, AnyObject>::new();
        sub_entry.insert(&*NSString::from_str("uid"), any(&*NSString::from_str(&out_uid))); // kAudioSubDeviceUIDKey
        d.insert(&*k("master"), any(&*k(&out_uid))); // kAudioAggregateDeviceMainSubDeviceKey
        d.insert(&*k("subdevices"), any(&*NSArray::from_retained_slice(&[sub_entry]))); // kAudioAggregateDeviceSubDeviceListKey
    }
    d.insert(&*k("private"), any(&*NSNumber::new_bool(true))); // kAudioAggregateDeviceIsPrivateKey
    d.insert(&*k("stacked"), any(&*NSNumber::new_bool(false))); // kAudioAggregateDeviceIsStackedKey
    d.insert(&*k("tapautostart"), any(&*NSNumber::new_bool(true))); // kAudioAggregateDeviceTapAutoStartKey
    d.insert(&*k("taps"), any(&*NSArray::from_retained_slice(&[tap_entry]))); // kAudioAggregateDeviceTapListKey
    // NSDictionary is toll-free bridged to CFDictionary.
    let cfd: &CFDictionary = unsafe { &*(std::ptr::from_ref(&*d).cast::<CFDictionary>()) };

    let mut agg: AudioObjectID = 0;
    let r = check(
        unsafe { AudioHardwareCreateAggregateDevice(cfd, NonNull::from(&mut agg)) },
        "AudioHardwareCreateAggregateDevice",
    );
    if let Err(e) = r {
        unsafe { AudioHardwareDestroyProcessTap(tap_id) };
        return Err(e);
    }
    eprintln!("aggregate device id={agg} (main sub-device: {})", out_dev.map_or("none (tap only)".into(), hal::device_name));

    let sink = Arc::new(Sink {
        samples: Mutex::new(Vec::with_capacity((fmt.mSampleRate * 2.0 * (o.secs + 1.0)) as usize)),
        channels: 0.into(),
        callbacks: 0.into(),
        first_cb: Mutex::new(None),
        timing: Mutex::new((0.0, 0, 0.0, None, 0.0)),
    });
    let mut proc_id: AudioDeviceIOProcID = None;
    let result = (|| -> Result<()> {
        check(
            unsafe {
                AudioDeviceCreateIOProcID(agg, Some(io_proc), Arc::as_ptr(&sink).cast_mut().cast(), NonNull::from(&mut proc_id))
            },
            "AudioDeviceCreateIOProcID",
        )?;
        let start = Instant::now();
        check(unsafe { AudioDeviceStart(agg, proc_id) }, "AudioDeviceStart")?;
        eprintln!("AudioDeviceStart returned after {:.1} ms", start.elapsed().as_secs_f64() * 1e3);
        if let Some(f) = o.on_running {
            f();
        }
        std::thread::sleep(Duration::from_secs_f64(o.secs));
        unsafe { AudioDeviceStop(agg, proc_id) };
        if let Some(t) = *sink.first_cb.lock().unwrap() {
            eprintln!(
                "first IO callback {:.1} ms after AudioDeviceStart; {} callbacks",
                t.duration_since(start).as_secs_f64() * 1e3,
                sink.callbacks.load(std::sync::atomic::Ordering::Relaxed)
            );
        } else {
            eprintln!("no IO callbacks received");
        }
        let t = sink.timing.lock().unwrap();
        eprintln!(
            "timestamp gaps: {} (total {:.0} frames = {:.2} s); max wall-clock interval between callbacks {:.1} ms",
            t.1,
            t.2,
            t.2 / fmt.mSampleRate,
            t.4 * 1e3
        );
        Ok(())
    })();
    unsafe {
        if proc_id.is_some() {
            AudioDeviceDestroyIOProcID(agg, proc_id);
        }
        AudioHardwareDestroyAggregateDevice(agg);
        AudioHardwareDestroyProcessTap(tap_id);
    }
    result.context("tap capture")?;
    let channels = sink.channels.load(std::sync::atomic::Ordering::Relaxed).max(1);
    let samples = std::mem::take(&mut *sink.samples.lock().unwrap());
    Ok(TapResult { rate: fmt.mSampleRate, channels, samples })
}
