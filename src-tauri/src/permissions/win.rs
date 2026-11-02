//! Windows (decision 3): the microphone by the privacy switches in the
//! registry; system audio (loopback) needs no access. Classic apps get no
//! prompt: a denied microphone opens the privacy settings.

use tauri::{AppHandle, Runtime};
use windows::{
    Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{
            HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW,
        },
    },
    core::{HSTRING, w},
};

use super::{
    PermissionKind, PermissionState, PermissionStatus, blocking, microphone_from_consent,
    open_settings,
};
use crate::error::CommandResult;

const CONSENT: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

/// A `REG_SZ` named `Value`, or `None` when it (or its key) is missing.
fn read_value(root: HKEY, subkey: &str) -> Option<String> {
    let subkey = HSTRING::from(subkey);
    let mut buffer = [0u16; 64];
    let mut size = u32::try_from(size_of_val(&buffer)).unwrap_or(0);
    // SAFETY: `buffer` holds `size` bytes; RegGetValueW NUL-terminates.
    let status = unsafe {
        RegGetValueW(
            root,
            &subkey,
            w!("Value"),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..length]))
}

pub fn microphone() -> PermissionState {
    let user = read_value(HKEY_CURRENT_USER, CONSENT);
    let classic_apps = read_value(HKEY_CURRENT_USER, &format!(r"{CONSENT}\NonPackaged"));
    let machine = read_value(HKEY_LOCAL_MACHINE, CONSENT);
    microphone_from_consent(&[user.as_deref(), classic_apps.as_deref(), machine.as_deref()])
}

pub fn status(kind: PermissionKind) -> PermissionStatus {
    PermissionStatus::new(match kind {
        PermissionKind::Microphone => microphone(),
        PermissionKind::SystemAudio => PermissionState::Granted,
    })
}

pub async fn request<R: Runtime>(
    app: &AppHandle<R>,
    kind: PermissionKind,
) -> CommandResult<PermissionStatus> {
    let current = blocking(move || status(kind)).await?;
    if kind == PermissionKind::Microphone && current.state == PermissionState::Denied {
        open_settings(app, kind)?;
    }
    Ok(current)
}
