//! macOS: the microphone through AVFoundation (decision 1), system audio
//! through a short process tap and the private `TCCAccessPreflight`
//! (decision 2).

use std::{
    ffi::{c_int, c_void},
    sync::{Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
use objc2_core_foundation::CFString;
use objc2_foundation::NSProcessInfo;
use tauri::{AppHandle, Runtime};
use tokio::sync::oneshot;

use super::{
    OLD_MACOS, PermissionKind, PermissionState, PermissionStatus, blocking, from_av_status,
    from_tcc_preflight, tap_supported,
};
use crate::{
    audio::{level::Feed, mac::tap::SystemTap},
    error::CommandResult,
};

/// How long the tap of a request runs: macOS prompts on its creation.
const REQUEST_TAP: Duration = Duration::from_millis(500);
/// How long a request waits for the user's answer to the prompt.
const ANSWER_WAIT: Duration = Duration::from_secs(30);
const ANSWER_POLL: Duration = Duration::from_millis(300);

pub fn status(kind: PermissionKind) -> PermissionStatus {
    match kind {
        PermissionKind::Microphone => PermissionStatus::new(microphone()),
        PermissionKind::SystemAudio => system_audio(),
    }
}

pub async fn request<R: Runtime>(
    _app: &AppHandle<R>,
    kind: PermissionKind,
) -> CommandResult<PermissionStatus> {
    Ok(match kind {
        PermissionKind::Microphone => PermissionStatus::new(request_microphone().await?),
        PermissionKind::SystemAudio => request_system_audio().await?,
    })
}

pub fn microphone() -> PermissionState {
    // SAFETY: a constant of AVFoundation.
    let Some(audio) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionState::Unknown;
    };
    // SAFETY: a class method without side effects; no prompt.
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) };
    from_av_status(status.0)
}

/// Asks for the microphone; the answer comes on another thread.
fn ask_microphone() -> Option<oneshot::Receiver<bool>> {
    // SAFETY: a constant of AVFoundation.
    let audio = unsafe { AVMediaTypeAudio }?;
    let (sender, receiver) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    let handler = RcBlock::new(move |granted: Bool| {
        let sender = sender.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(sender) = sender {
            let _ = sender.send(granted.as_bool());
        }
    });
    // SAFETY: AVFoundation copies the block and calls it once.
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
    Some(receiver)
}

/// Shows the prompt the first time; afterwards the state stays as the
/// user (or the settings) left it.
pub async fn request_microphone() -> CommandResult<PermissionState> {
    if blocking(microphone).await? != PermissionState::NotDetermined {
        return blocking(microphone).await;
    }
    // The receiver resolves when the user answers; a dropped handler is
    // an answer too.
    if let Some(answer) = ask_microphone() {
        let _ = answer.await;
    }
    blocking(microphone).await
}

/// `int TCCAccessPreflight(CFStringRef service, CFDictionaryRef options)`.
type Preflight = unsafe extern "C" fn(*const c_void, *const c_void) -> c_int;

fn preflight_function() -> Option<Preflight> {
    static FUNCTION: OnceLock<Option<usize>> = OnceLock::new();
    let address = *FUNCTION.get_or_init(|| {
        // SAFETY: dlopen/dlsym with NUL-terminated names; the handle stays open.
        unsafe {
            let handle = libc::dlopen(
                c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC".as_ptr(),
                libc::RTLD_LAZY,
            );
            if handle.is_null() {
                return None;
            }
            let symbol = libc::dlsym(handle, c"TCCAccessPreflight".as_ptr());
            (!symbol.is_null()).then_some(symbol as usize)
        }
    });
    // SAFETY: the symbol is `TCCAccessPreflight` with this signature.
    address.map(|address| unsafe { std::mem::transmute::<usize, Preflight>(address) })
}

/// The private preflight of "Запись системного аудио", read only.
fn preflight() -> Option<i32> {
    let function = preflight_function()?;
    let service = CFString::from_static_str("kTCCServiceAudioCapture");
    // SAFETY: a CFString service and no options; the function only reads.
    let code = unsafe { function(std::ptr::from_ref(&*service).cast(), std::ptr::null()) };
    Some(code)
}

/// Whether this macOS has process taps (14.2+).
pub fn tap_available() -> bool {
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    tap_supported(
        u32::try_from(version.majorVersion).unwrap_or(0),
        u32::try_from(version.minorVersion).unwrap_or(0),
    )
}

pub fn system_audio() -> PermissionStatus {
    if !tap_available() {
        return PermissionStatus {
            state: PermissionState::Denied,
            message: Some(OLD_MACOS.to_owned()),
        };
    }
    PermissionStatus::new(from_tcc_preflight(preflight()))
}

/// Starts a tap for half a second: its creation shows the prompt. Then
/// waits for the answer while the preflight says "not asked yet".
pub async fn request_system_audio() -> CommandResult<PermissionStatus> {
    let current = blocking(system_audio).await?;
    if matches!(
        current.state,
        PermissionState::Granted | PermissionState::Denied
    ) {
        return Ok(current);
    }
    let tapped = blocking(|| {
        let tap = SystemTap::start(Feed::default())?;
        std::thread::sleep(REQUEST_TAP);
        drop(tap);
        Ok::<_, String>(())
    })
    .await?;
    if let Err(error) = tapped {
        // No tap, no prompt: nothing to wait for.
        eprintln!("grill: system audio request tap failed: {error}");
        return blocking(system_audio).await;
    }
    let deadline = Instant::now() + ANSWER_WAIT;
    loop {
        let state = blocking(system_audio).await?;
        if state.state != PermissionState::NotDetermined || Instant::now() >= deadline {
            return Ok(state);
        }
        tokio::time::sleep(ANSWER_POLL).await;
    }
}
