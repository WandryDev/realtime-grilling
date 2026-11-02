//! The app's access to the microphone and to system audio recording
//! (`specs/system-permissions`, design.md decisions 1–5).
//!
//! Reading a state never shows a system prompt; only `request` does. Rust
//! keeps no watchers on the OS: the frontend reads again on focus and on
//! "Проверить".

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as platform;

/// Platforms we don't ship: the microphone is assumed open, system audio
/// unknown.
#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use tauri::{AppHandle, Runtime};

    use super::{PermissionKind, PermissionState, PermissionStatus};
    use crate::error::CommandResult;

    pub fn status(kind: PermissionKind) -> PermissionStatus {
        PermissionStatus::new(match kind {
            PermissionKind::Microphone => PermissionState::Granted,
            PermissionKind::SystemAudio => PermissionState::Unknown,
        })
    }

    pub async fn request<R: Runtime>(
        _app: &AppHandle<R>,
        kind: PermissionKind,
    ) -> CommandResult<PermissionStatus> {
        Ok(status(kind))
    }
}

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt as _;

use crate::error::{CommandError, CommandResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    /// The user's own voice ("Я").
    Microphone,
    /// Sound of the other apps, i.e. the call ("Остальные").
    SystemAudio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PermissionState {
    /// Not asked yet: "Разрешить" shows the system prompt.
    NotDetermined,
    Granted,
    /// Refused, restricted by a policy or turned off in the settings.
    Denied,
    /// The OS doesn't tell without trying to record.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub state: PermissionState,
    /// Why the access can't be given here, e.g. the macOS version is too
    /// old for system audio. Shown as is.
    #[specta(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PermissionStatus {
    pub const fn new(state: PermissionState) -> Self {
        Self {
            state,
            message: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub microphone: PermissionStatus,
    pub system_audio: PermissionStatus,
}

/// The current state, without a prompt. Fast, but may touch private
/// frameworks: call it off the main thread.
pub fn status(kind: PermissionKind) -> PermissionStatus {
    platform::status(kind)
}

pub fn all() -> Permissions {
    Permissions {
        microphone: status(PermissionKind::Microphone),
        system_audio: status(PermissionKind::SystemAudio),
    }
}

/// "Разрешить": the system prompt where the OS has one, then the state the
/// user left. A denied access stays denied; on Windows a denied microphone
/// opens the privacy settings instead.
pub async fn request<R: Runtime>(
    app: &AppHandle<R>,
    kind: PermissionKind,
) -> CommandResult<PermissionStatus> {
    platform::request(app, kind).await
}

/// Which OS the settings URLs are for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Other,
}

impl Os {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

const MAC_PRIVACY: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy";

/// The settings pages for an access, the exact one first and then the
/// general privacy page. Only Rust picks these URLs: the frontend passes a
/// kind.
pub fn settings_urls(kind: PermissionKind, os: Os) -> &'static [&'static str] {
    match (os, kind) {
        (Os::Mac, PermissionKind::Microphone) => &[
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            MAC_PRIVACY,
        ],
        (Os::Mac, PermissionKind::SystemAudio) => &[
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
            MAC_PRIVACY,
        ],
        (Os::Windows, _) => &["ms-settings:privacy-microphone"],
        (Os::Other, _) => &[],
    }
}

/// Opens the settings page of an access, falling back to the general
/// privacy page when the exact one can't be opened.
pub fn open_settings<R: Runtime>(app: &AppHandle<R>, kind: PermissionKind) -> CommandResult<()> {
    let mut last_error = None;
    for url in settings_urls(kind, Os::current()) {
        match app.opener().open_url(*url, None::<&str>) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(CommandError::external(format!(
        "Не удалось открыть системные настройки: {}",
        last_error.unwrap_or_else(|| "раздела нет на этой ОС".to_owned())
    )))
}

/// Runs a call into the OS off the async runtime's workers.
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::external(error.to_string()))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// `AVAuthorizationStatus` → state: `restricted` (a policy) is `denied`.
pub fn from_av_status(status: isize) -> PermissionState {
    match status {
        0 => PermissionState::NotDetermined,
        1 | 2 => PermissionState::Denied,
        3 => PermissionState::Granted,
        _ => PermissionState::Unknown,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Result of the private `TCCAccessPreflight` (`None`: the function is
/// missing) → state. 0 granted, 1 denied, 2 not asked yet; anything else
/// is a code we don't know.
pub fn from_tcc_preflight(code: Option<i32>) -> PermissionState {
    match code {
        Some(0) => PermissionState::Granted,
        Some(1) => PermissionState::Denied,
        Some(2) => PermissionState::NotDetermined,
        _ => PermissionState::Unknown,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
/// The `Value`s of `ConsentStore\microphone` (user switch, the "classic
/// apps" switch, the machine-wide switch). `Deny` in any of them denies;
/// a missing value doesn't.
pub fn microphone_from_consent(values: &[Option<&str>]) -> PermissionState {
    let denied = values
        .iter()
        .flatten()
        .any(|value| value.trim().eq_ignore_ascii_case("deny"));
    if denied {
        PermissionState::Denied
    } else {
        PermissionState::Granted
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Whether a process tap exists on this macOS (14.2+).
pub const fn tap_supported(major: u32, minor: u32) -> bool {
    major > 14 || (major == 14 && minor >= 2)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const OLD_MACOS: &str = "Запись системного звука работает на macOS 14.2 или новее";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av_status_maps_to_states() {
        assert_eq!(from_av_status(0), PermissionState::NotDetermined);
        assert_eq!(from_av_status(1), PermissionState::Denied, "restricted");
        assert_eq!(from_av_status(2), PermissionState::Denied);
        assert_eq!(from_av_status(3), PermissionState::Granted);
        assert_eq!(from_av_status(42), PermissionState::Unknown);
    }

    #[test]
    fn tcc_preflight_codes_map_to_states() {
        assert_eq!(from_tcc_preflight(Some(0)), PermissionState::Granted);
        assert_eq!(from_tcc_preflight(Some(1)), PermissionState::Denied);
        assert_eq!(from_tcc_preflight(Some(2)), PermissionState::NotDetermined);
        assert_eq!(from_tcc_preflight(Some(-1)), PermissionState::Unknown);
        assert_eq!(from_tcc_preflight(None), PermissionState::Unknown);
    }

    #[test]
    fn process_tap_needs_macos_14_2() {
        assert!(!tap_supported(13, 6));
        assert!(!tap_supported(14, 1));
        assert!(tap_supported(14, 2));
        assert!(tap_supported(15, 0));
        assert!(tap_supported(26, 0));
    }

    #[test]
    fn windows_consent_values() {
        let granted = microphone_from_consent(&[Some("Allow"), Some("Allow"), Some("Allow")]);
        assert_eq!(granted, PermissionState::Granted);
        let missing = microphone_from_consent(&[None, None, None]);
        assert_eq!(
            missing,
            PermissionState::Granted,
            "no value is not a denial"
        );
        for values in [
            [Some("Deny"), Some("Allow"), Some("Allow")],
            [Some("Allow"), Some("Deny"), None],
            [None, None, Some("Deny")],
            [Some("deny "), None, None],
        ] {
            assert_eq!(
                microphone_from_consent(&values),
                PermissionState::Denied,
                "{values:?}"
            );
        }
    }

    #[test]
    fn settings_urls_by_kind_and_os() {
        let mic = settings_urls(PermissionKind::Microphone, Os::Mac);
        assert!(mic[0].ends_with("?Privacy_Microphone"));
        assert_eq!(mic.last(), Some(&MAC_PRIVACY));
        let system = settings_urls(PermissionKind::SystemAudio, Os::Mac);
        assert!(system[0].ends_with("?Privacy_AudioCapture"));
        assert_eq!(system.last(), Some(&MAC_PRIVACY));
        for kind in [PermissionKind::Microphone, PermissionKind::SystemAudio] {
            assert_eq!(
                settings_urls(kind, Os::Windows),
                ["ms-settings:privacy-microphone"]
            );
        }
        assert!(settings_urls(PermissionKind::Microphone, Os::Other).is_empty());
    }

    #[test]
    fn permissions_serialize_in_camel_case() {
        let permissions = Permissions {
            microphone: PermissionStatus::new(PermissionState::NotDetermined),
            system_audio: PermissionStatus {
                state: PermissionState::Denied,
                message: Some(OLD_MACOS.to_owned()),
            },
        };
        assert_eq!(
            serde_json::to_value(permissions).unwrap(),
            serde_json::json!({
                "microphone": { "state": "notDetermined" },
                "systemAudio": { "state": "denied", "message": OLD_MACOS },
            })
        );
        let kind: PermissionKind =
            serde_json::from_value(serde_json::json!("systemAudio")).unwrap();
        assert_eq!(kind, PermissionKind::SystemAudio);
    }
}
