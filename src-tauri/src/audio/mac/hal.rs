//! Thin helpers over the Core Audio HAL property API, from
//! `spikes/audio/src/mac/hal.rs`.

use std::{
    ffi::c_void,
    ptr::{self, NonNull},
};

use objc2_core_audio::{
    AudioObjectAddPropertyListener, AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerProc,
    AudioObjectRemovePropertyListener, AudioObjectSetPropertyData,
};
use objc2_core_foundation::{CFRetained, CFString};

const fn fourcc(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

/// `kAudioObjectSystemObject`.
pub const SYSTEM: AudioObjectID = 1;

pub const SCOPE_GLOBAL: u32 = fourcc(b"glob");
pub const SCOPE_INPUT: u32 = fourcc(b"inpt");
const ELEMENT_MAIN: u32 = 0;

const HW_DEFAULT_OUTPUT: u32 = fourcc(b"dOut"); // kAudioHardwarePropertyDefaultOutputDevice
const HW_TRANSLATE_PID: u32 = fourcc(b"id2p"); // kAudioHardwarePropertyTranslatePIDToProcessObject
pub const HW_PROCESS_OBJECT_LIST: u32 = fourcc(b"prs#"); // kAudioHardwarePropertyProcessObjectList
const HW_RUN_LOOP: u32 = fourcc(b"rnlp"); // kAudioHardwarePropertyRunLoop
pub const PROC_PID: u32 = fourcc(b"ppid"); // kAudioProcessPropertyPID
pub const PROC_DEVICES: u32 = fourcc(b"pdv#"); // kAudioProcessPropertyDevices
pub const PROC_IS_RUNNING_INPUT: u32 = fourcc(b"piri"); // kAudioProcessPropertyIsRunningInput
const DEV_IS_RUNNING_SOMEWHERE: u32 = fourcc(b"gone"); // kAudioDevicePropertyDeviceIsRunningSomewhere
pub const TAP_UID: u32 = fourcc(b"tuid"); // kAudioTapPropertyUID
pub const TAP_FORMAT: u32 = fourcc(b"tfmt"); // kAudioTapPropertyFormat
pub const NOMINAL_SAMPLE_RATE: u32 = fourcc(b"nsrt"); // kAudioDevicePropertyNominalSampleRate

fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: scope,
        mElement: ELEMENT_MAIN,
    }
}

/// An `OSStatus` as an error text, with its four-char code when it has one.
pub fn check(status: i32, what: &str) -> Result<(), String> {
    if status == 0 {
        return Ok(());
    }
    let bytes = status.to_be_bytes();
    let code = if bytes.iter().all(u8::is_ascii_graphic) {
        format!(" '{}'", String::from_utf8_lossy(&bytes))
    } else {
        String::new()
    };
    Err(format!("{what}: OSStatus {status}{code}"))
}

fn get_with_qualifier<T: Copy, Q>(
    object: AudioObjectID,
    selector: u32,
    scope: u32,
    qualifier: Option<&Q>,
) -> Result<T, String> {
    let mut address = address(selector, scope);
    // SAFETY: only used with plain-old-data Core Audio types.
    let mut value: T = unsafe { std::mem::zeroed() };
    let mut size = u32::try_from(size_of::<T>()).unwrap_or(u32::MAX);
    let (qualifier_size, qualifier) = match qualifier {
        Some(qualifier) => (
            u32::try_from(size_of::<Q>()).unwrap_or(u32::MAX),
            ptr::from_ref(qualifier).cast::<c_void>(),
        ),
        None => (0, ptr::null()),
    };
    // SAFETY: `value` is a `T` of `size` bytes, the qualifier a `Q`.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&mut address),
            qualifier_size,
            qualifier,
            NonNull::from(&mut size),
            NonNull::from(&mut value).cast(),
        )
    };
    check(status, "AudioObjectGetPropertyData")?;
    Ok(value)
}

pub fn get<T: Copy>(object: AudioObjectID, selector: u32, scope: u32) -> Result<T, String> {
    get_with_qualifier(object, selector, scope, None::<&()>)
}

/// A property that is an array of `T`.
pub fn get_vec<T: Copy + Default>(
    object: AudioObjectID,
    selector: u32,
    scope: u32,
) -> Result<Vec<T>, String> {
    let mut address = address(selector, scope);
    let mut size = 0u32;
    // SAFETY: asks only for the size.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            object,
            NonNull::from(&mut address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
        )
    };
    check(status, "AudioObjectGetPropertyDataSize")?;
    let mut values = vec![T::default(); size as usize / size_of::<T>()];
    if values.is_empty() {
        return Ok(values);
    }
    let mut size = u32::try_from(values.len() * size_of::<T>()).unwrap_or(u32::MAX);
    // SAFETY: `values` holds `size` bytes of plain-old-data `T`.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&mut address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(values.as_mut_slice()).cast(),
        )
    };
    check(status, "AudioObjectGetPropertyData")?;
    // The list may have shrunk between the two calls.
    values.truncate(size as usize / size_of::<T>());
    Ok(values)
}

fn set<T>(object: AudioObjectID, selector: u32, scope: u32, value: &T) -> Result<(), String> {
    let mut address = address(selector, scope);
    // SAFETY: `value` is a `T` of the size given.
    let status = unsafe {
        AudioObjectSetPropertyData(
            object,
            NonNull::from(&mut address),
            0,
            ptr::null(),
            u32::try_from(size_of::<T>()).unwrap_or(u32::MAX),
            NonNull::from(value).cast(),
        )
    };
    check(status, "AudioObjectSetPropertyData")
}

/// Property notifications on the HAL's own thread instead of the main run
/// loop (`kAudioHardwarePropertyRunLoop = NULL`). Process-wide.
pub fn use_hal_notification_thread() -> Result<(), String> {
    let no_run_loop: *const c_void = ptr::null();
    set(SYSTEM, HW_RUN_LOOP, SCOPE_GLOBAL, &no_run_loop)
}

/// Calls `listener` (with a null client pointer) when the property changes.
pub fn add_listener(
    object: AudioObjectID,
    selector: u32,
    scope: u32,
    listener: AudioObjectPropertyListenerProc,
) -> Result<(), String> {
    let mut address = address(selector, scope);
    // SAFETY: the HAL copies the address; the listener is a plain function.
    let status = unsafe {
        AudioObjectAddPropertyListener(
            object,
            NonNull::from(&mut address),
            listener,
            ptr::null_mut(),
        )
    };
    check(status, "AudioObjectAddPropertyListener")
}

/// Undoes [`add_listener`] with the same arguments.
pub fn remove_listener(
    object: AudioObjectID,
    selector: u32,
    scope: u32,
    listener: AudioObjectPropertyListenerProc,
) -> Result<(), String> {
    let mut address = address(selector, scope);
    // SAFETY: as in `add_listener`.
    let status = unsafe {
        AudioObjectRemovePropertyListener(
            object,
            NonNull::from(&mut address),
            listener,
            ptr::null_mut(),
        )
    };
    check(status, "AudioObjectRemovePropertyListener")
}

pub fn get_string(object: AudioObjectID, selector: u32, scope: u32) -> Result<String, String> {
    let mut address = address(selector, scope);
    let mut string: *const CFString = ptr::null();
    let mut size = u32::try_from(size_of::<*const CFString>()).unwrap_or(u32::MAX);
    // SAFETY: the property is a `CFStringRef`.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&mut address),
            0,
            ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut string).cast(),
        )
    };
    check(status, "AudioObjectGetPropertyData")?;
    let Some(string) = NonNull::new(string.cast_mut()) else {
        return Ok(String::new());
    };
    // SAFETY: the property returns a +1 reference.
    let string: CFRetained<CFString> = unsafe { CFRetained::from_raw(string) };
    Ok(string.to_string())
}

pub fn default_output() -> Result<AudioObjectID, String> {
    get(SYSTEM, HW_DEFAULT_OUTPUT, SCOPE_GLOBAL)
}

/// Whether any process plays to (or records from) the device.
pub fn is_running_somewhere(device: AudioObjectID) -> bool {
    get::<u32>(device, DEV_IS_RUNNING_SOMEWHERE, SCOPE_GLOBAL).is_ok_and(|running| running != 0)
}

/// Whether some app plays sound to the default output.
pub fn output_playing() -> bool {
    default_output().is_ok_and(is_running_somewhere)
}

/// The process object of a PID, or 0 if it isn't an audio client yet.
pub fn process_object_for_pid(pid: i32) -> AudioObjectID {
    get_with_qualifier::<AudioObjectID, i32>(SYSTEM, HW_TRANSLATE_PID, SCOPE_GLOBAL, Some(&pid))
        .unwrap_or(0)
}
