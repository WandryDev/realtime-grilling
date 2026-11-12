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

/// The first step of onboarding, the route its window opens with.
pub const ONBOARDING_ROUTE: &str = "/onboarding";

/// Loads the onboarding window anew at its first step («Удалить всё»): it
/// was only hidden when onboarding ended, so it still shows the last step
/// and keeps what the steps remembered in memory.
pub fn restart_onboarding<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = window(app, ONBOARDING) else {
        return;
    };
    let reloaded = window.url().and_then(|mut url| {
        url.set_path(ONBOARDING_ROUTE);
        url.set_query(None);
        url.set_fragment(None);
        window.navigate(url)
    });
    if let Err(error) = reloaded {
        eprintln!("grill: failed to start onboarding again: {error}");
    }
}

/// «Удалить всё» is done: onboarding shows from its first step, the main
/// window hides.
pub fn onboarding_again<R: Runtime>(app: &AppHandle<R>) {
    restart_onboarding(app);
    show(app, ONBOARDING);
    hide(app, MAIN);
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

#[cfg(test)]
mod tests {
    use tauri::{WebviewUrl, WebviewWindowBuilder, test::mock_builder};

    use super::*;

    /// «Удалить всё» after onboarding ended on «Готово»: the hidden window
    /// opens its first step, without the query of the last one.
    #[test]
    fn onboarding_again_loads_its_first_step() {
        let app = mock_builder()
            .build(tauri::generate_context!(test = true))
            .expect("failed to build the mock app");
        let window = WebviewWindowBuilder::new(
            &app,
            ONBOARDING,
            WebviewUrl::App("onboarding/done?from=agent".into()),
        )
        .build()
        .unwrap();
        assert_eq!(window.url().unwrap().path(), "/onboarding/done");

        onboarding_again(app.handle());

        let url = window.url().unwrap();
        assert_eq!(url.path(), ONBOARDING_ROUTE);
        assert_eq!(url.query(), None);
    }
}
