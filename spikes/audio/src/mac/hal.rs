//! Thin helpers over the Core Audio HAL (AudioObject* property API).
#![allow(non_upper_case_globals)]

use std::ffi::c_void;
use std::ptr::{self, NonNull};

use anyhow::{Result, bail};
use objc2_core_audio::{
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
    AudioObjectPropertyAddress, AudioObjectSetPropertyData,
};
use objc2_core_foundation::{CFRetained, CFString};

pub const fn fourcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
}

pub const SYSTEM: AudioObjectID = 1; // kAudioObjectSystemObject

// Scopes / elements (AudioHardwareBase.h)
pub const SCOPE_GLOBAL: u32 = fourcc(b"glob");
pub const SCOPE_INPUT: u32 = fourcc(b"inpt");
pub const SCOPE_OUTPUT: u32 = fourcc(b"outp");
pub const ELEMENT_MAIN: u32 = 0;

// Selectors (AudioHardware.h / AudioHardwareBase.h, checked against the macOS 26 SDK)
pub const HW_DEVICES: u32 = fourcc(b"dev#"); // kAudioHardwarePropertyDevices
pub const HW_DEFAULT_INPUT: u32 = fourcc(b"dIn "); // kAudioHardwarePropertyDefaultInputDevice
pub const HW_DEFAULT_OUTPUT: u32 = fourcc(b"dOut"); // kAudioHardwarePropertyDefaultOutputDevice
pub const HW_PROCESS_OBJECT_LIST: u32 = fourcc(b"prs#"); // kAudioHardwarePropertyProcessObjectList
pub const HW_TRANSLATE_PID: u32 = fourcc(b"id2p"); // kAudioHardwarePropertyTranslatePIDToProcessObject
pub const HW_RUN_LOOP: u32 = fourcc(b"rnlp"); // kAudioHardwarePropertyRunLoop

pub const PROC_PID: u32 = fourcc(b"ppid"); // kAudioProcessPropertyPID
pub const PROC_BUNDLE_ID: u32 = fourcc(b"pbid"); // kAudioProcessPropertyBundleID
pub const PROC_DEVICES: u32 = fourcc(b"pdv#"); // kAudioProcessPropertyDevices
pub const PROC_IS_RUNNING_INPUT: u32 = fourcc(b"piri"); // kAudioProcessPropertyIsRunningInput
#[allow(dead_code)]
pub const PROC_IS_RUNNING_OUTPUT: u32 = fourcc(b"piro"); // kAudioProcessPropertyIsRunningOutput

pub const DEV_IS_RUNNING_SOMEWHERE: u32 = fourcc(b"gone"); // kAudioDevicePropertyDeviceIsRunningSomewhere
pub const DEV_UID: u32 = fourcc(b"uid "); // kAudioDevicePropertyDeviceUID
pub const OBJ_NAME: u32 = fourcc(b"lnam"); // kAudioObjectPropertyName
pub const DEV_STREAMS: u32 = fourcc(b"stm#"); // kAudioDevicePropertyStreams
pub const DEV_NOMINAL_RATE: u32 = fourcc(b"nsrt"); // kAudioDevicePropertyNominalSampleRate
pub const DEV_VOLUME_SCALAR: u32 = fourcc(b"volm"); // kAudioDevicePropertyVolumeScalar
pub const DEV_MUTE: u32 = fourcc(b"mute"); // kAudioDevicePropertyMute

pub const TAP_UID: u32 = fourcc(b"tuid"); // kAudioTapPropertyUID
pub const TAP_FORMAT: u32 = fourcc(b"tfmt"); // kAudioTapPropertyFormat

pub fn addr(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: ELEMENT_MAIN,
    }
}

pub fn check(status: i32, what: &str) -> Result<()> {
    if status != 0 {
        let b = status.to_be_bytes();
        let cc = if b.iter().all(|c| c.is_ascii_graphic()) {
            format!(" '{}'", String::from_utf8_lossy(&b))
        } else {
            String::new()
        };
        bail!("{what} failed: OSStatus {status}{cc}");
    }
    Ok(())
}

pub fn get<T: Copy>(obj: AudioObjectID, selector: u32, scope: u32) -> Result<T> {
    get_with_qualifier(obj, selector, scope, None::<&()>)
}

pub fn get_with_qualifier<T: Copy, Q>(
    obj: AudioObjectID,
    selector: u32,
    scope: u32,
    qualifier: Option<&Q>,
) -> Result<T> {
    let mut a = addr(selector, scope);
    // SAFETY: only used with plain-old-data Core Audio types.
    let mut value: T = unsafe { std::mem::zeroed() };
    let mut size = size_of::<T>() as u32;
    let (qs, qp) = match qualifier {
        Some(q) => (size_of::<Q>() as u32, ptr::from_ref(q).cast::<c_void>()),
        None => (0, ptr::null()),
    };
    let st = unsafe {
        AudioObjectGetPropertyData(
            obj,
            NonNull::from(&mut a),
            qs,
            qp,
            NonNull::from(&mut size),
            NonNull::from(&mut value).cast(),
        )
    };
    check(st, &format!("get '{}' on {obj}", cc_str(selector)))?;
    Ok(value)
}

pub fn get_vec<T: Copy + Default>(obj: AudioObjectID, selector: u32, scope: u32) -> Result<Vec<T>> {
    let mut a = addr(selector, scope);
    let mut size = 0u32;
    let st = unsafe {
        AudioObjectGetPropertyDataSize(obj, NonNull::from(&mut a), 0, ptr::null(), NonNull::from(&mut size))
    };
    check(st, &format!("size '{}' on {obj}", cc_str(selector)))?;
    let n = size as usize / size_of::<T>();
    let mut v = vec![T::default(); n];
    if n == 0 {
        return Ok(v);
    }
    let st = unsafe {
        AudioObjectGetPropertyData(
            obj,
            NonNull::from(&mut a),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            NonNull::new(v.as_mut_ptr()).unwrap().cast(),
        )
    };
    check(st, &format!("get '{}' on {obj}", cc_str(selector)))?;
    v.truncate(size as usize / size_of::<T>());
    Ok(v)
}

pub fn get_string(obj: AudioObjectID, selector: u32, scope: u32) -> Result<String> {
    let mut a = addr(selector, scope);
    let mut s: *const CFString = ptr::null();
    let mut size = size_of::<*const CFString>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            obj,
            NonNull::from(&mut a),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut s).cast(),
        )
    };
    check(st, &format!("get string '{}' on {obj}", cc_str(selector)))?;
    let Some(nn) = NonNull::new(s.cast_mut()) else {
        return Ok(String::new());
    };
    // The property returns a +1 reference.
    let cf: CFRetained<CFString> = unsafe { CFRetained::from_raw(nn) };
    Ok(cf.to_string())
}

pub fn set<T>(obj: AudioObjectID, selector: u32, scope: u32, value: &T) -> Result<()> {
    let mut a = addr(selector, scope);
    let st = unsafe {
        AudioObjectSetPropertyData(
            obj,
            NonNull::from(&mut a),
            0,
            ptr::null(),
            size_of::<T>() as u32,
            NonNull::from(value).cast(),
        )
    };
    check(st, &format!("set '{}' on {obj}", cc_str(selector)))
}

pub fn cc_str(v: u32) -> String {
    String::from_utf8_lossy(&v.to_be_bytes()).into_owned()
}

/// Tell the HAL to deliver property notifications on its own thread instead of the
/// main run loop (a CLI has no running main run loop).
pub fn use_hal_notification_thread() -> Result<()> {
    let null_loop: *const c_void = ptr::null();
    set(SYSTEM, HW_RUN_LOOP, SCOPE_GLOBAL, &null_loop)
}

pub fn default_input() -> Result<AudioObjectID> {
    get(SYSTEM, HW_DEFAULT_INPUT, SCOPE_GLOBAL)
}

pub fn default_output() -> Result<AudioObjectID> {
    get(SYSTEM, HW_DEFAULT_OUTPUT, SCOPE_GLOBAL)
}

pub fn device_name(dev: AudioObjectID) -> String {
    get_string(dev, OBJ_NAME, SCOPE_GLOBAL).unwrap_or_else(|_| "?".into())
}

pub fn device_uid(dev: AudioObjectID) -> Result<String> {
    get_string(dev, DEV_UID, SCOPE_GLOBAL)
}

pub fn stream_count(dev: AudioObjectID, scope: u32) -> usize {
    get_vec::<u32>(dev, DEV_STREAMS, scope).map(|v| v.len()).unwrap_or(0)
}

pub fn all_devices() -> Result<Vec<AudioObjectID>> {
    get_vec(SYSTEM, HW_DEVICES, SCOPE_GLOBAL)
}

/// Finds a device by case-insensitive name substring, restricted to devices with streams in `scope`.
pub fn find_device(name_substr: &str, scope: u32) -> Result<AudioObjectID> {
    let needle = name_substr.to_lowercase();
    for d in all_devices()? {
        if stream_count(d, scope) > 0 && device_name(d).to_lowercase().contains(&needle) {
            return Ok(d);
        }
    }
    bail!("no device matching '{name_substr}' with streams in that scope")
}

pub fn list_devices() -> Result<()> {
    let din = default_input().unwrap_or(0);
    let dout = default_output().unwrap_or(0);
    for d in all_devices()? {
        let ins = stream_count(d, SCOPE_INPUT);
        let outs = stream_count(d, SCOPE_OUTPUT);
        let rate: f64 = get(d, DEV_NOMINAL_RATE, SCOPE_GLOBAL).unwrap_or(0.0);
        let mut flags = String::new();
        if d == din {
            flags.push_str(" [default in]");
        }
        if d == dout {
            flags.push_str(" [default out]");
        }
        println!(
            "{d:>4}  in-streams={ins} out-streams={outs} rate={rate:.0}  {}  uid={}{flags}",
            device_name(d),
            device_uid(d).unwrap_or_default()
        );
    }
    Ok(())
}

/// Process object ID for a PID, or 0 if the process has no audio client in coreaudiod yet.
pub fn process_object_for_pid(pid: i32) -> AudioObjectID {
    get_with_qualifier::<AudioObjectID, i32>(SYSTEM, HW_TRANSLATE_PID, SCOPE_GLOBAL, Some(&pid)).unwrap_or(0)
}
