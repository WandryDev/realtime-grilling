//! The four windows declared in `tauri.conf.json` (design.md, decision 1).

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

pub const MAIN: &str = "main";
pub const ONBOARDING: &str = "onboarding";
pub const WIDGET: &str = "widget";
pub const OVERLAY: &str = "overlay";

fn window<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<WebviewWindow<R>> {
    let window = app.get_webview_window(label);
    if window.is_none() {
        eprintln!("grill: window {label} is not declared");
    }
    window
}

/// Shows, restores and focuses a window.
pub fn show<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(window) = window(app, label) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Hides a window; it stops listening to the level meters.
pub fn hide<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(window) = window(app, label) {
        let _ = window.hide();
    }
    crate::audio::forget_window(app, label);
}

pub fn toggle<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(window) = window(app, label) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        hide(app, label);
    } else {
        show(app, label);
    }
}

/// The window the app opens with: onboarding until it is done, then main.
pub fn entry_label(onboarding_completed: bool) -> &'static str {
    if onboarding_completed {
        MAIN
    } else {
        ONBOARDING
    }
}

/// Keeps the call overlay out of screen sharing and recording
/// (`NSWindow.sharingType = none` / `WDA_EXCLUDEFROMCAPTURE`).
pub fn protect_overlay<R: Runtime>(app: &AppHandle<R>, protected: bool) {
    if let Some(window) = window(app, OVERLAY)
        && let Err(error) = window.set_content_protected(protected)
    {
        eprintln!("grill: failed to set content protection: {error}");
    }
}
