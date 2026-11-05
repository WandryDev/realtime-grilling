//! Which windows a change of the call shows and hides (call-lifecycle
//! design.md, decisions 5 and 8), in one place: the windows themselves no
//! longer hand the call over to each other.

use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

use crate::{
    events::{CallSessionStatus, Navigate},
    shell::windows::{self, MAIN, OVERLAY, WIDGET},
};

/// The call window's route in the main window.
pub const CALL_ROUTE: &str = "/call";

/// One thing done to a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowStep {
    /// Shows, restores and focuses the window; with `route`, opens it there
    /// first (`Navigate`).
    Show {
        label: &'static str,
        route: Option<&'static str>,
    },
    Hide(&'static str),
}

/// The window of the call: the overlay, or the call window in the main
/// window. While the call finishes, the main window builds its summary.
pub const fn call_window(status: CallSessionStatus, overlay: bool) -> WindowStep {
    if overlay && !matches!(status, CallSessionStatus::Finishing) {
        WindowStep::Show {
            label: OVERLAY,
            route: None,
        }
    } else {
        WindowStep::Show {
            label: MAIN,
            route: Some(CALL_ROUTE),
        }
    }
}

/// `Idle → Live`: the start widget goes, the call shows. `overlay`: the
/// "Компактный оверлей" setting, or a call started by "Сразу записывать".
pub fn started(overlay: bool) -> Vec<WindowStep> {
    vec![
        WindowStep::Hide(WIDGET),
        call_window(CallSessionStatus::Live, overlay),
    ]
}

/// `Live → Finishing`, wherever "Завершить" came from: the overlay goes,
/// the main window shows "Собираю итоги" of the call.
pub fn finishing() -> Vec<WindowStep> {
    vec![
        WindowStep::Hide(OVERLAY),
        call_window(CallSessionStatus::Finishing, false),
    ]
}

/// The call is gone without a summary (deleted, or discarded before its
/// data is): the overlay goes, the main window stays where it is.
pub fn gone() -> Vec<WindowStep> {
    vec![WindowStep::Hide(OVERLAY)]
}

/// The `toggle-call` shortcut and "Открыть звонок" in the tray: the call
/// in progress as at its start (`overlay`: the start showed the overlay),
/// or the start widget without one.
pub fn toggle_call(status: CallSessionStatus, overlay: bool) -> Vec<WindowStep> {
    match status {
        CallSessionStatus::Idle => vec![WindowStep::Show {
            label: WIDGET,
            route: None,
        }],
        status => vec![call_window(status, overlay)],
    }
}

/// Does `step` to the app's windows.
pub fn apply<R: Runtime>(app: &AppHandle<R>, step: WindowStep) {
    match step {
        WindowStep::Show { label, route } => {
            if let Some(route) = route {
                let navigate = Navigate {
                    route: route.to_owned(),
                };
                if let Err(error) = navigate.emit_to(app, label) {
                    eprintln!("grill: failed to send the route {route} to {label}: {error}");
                }
            }
            windows::show(app, label);
        }
        WindowStep::Hide(label) => windows::hide(app, label),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OVERLAY_SHOWN: WindowStep = WindowStep::Show {
        label: OVERLAY,
        route: None,
    };
    const CALL_SHOWN: WindowStep = WindowStep::Show {
        label: MAIN,
        route: Some(CALL_ROUTE),
    };

    #[test]
    fn a_start_hides_the_widget_and_shows_the_overlay_or_the_call_window() {
        assert_eq!(started(true), vec![WindowStep::Hide(WIDGET), OVERLAY_SHOWN]);
        assert_eq!(started(false), vec![WindowStep::Hide(WIDGET), CALL_SHOWN]);
    }

    #[test]
    fn finishing_hides_the_overlay_and_opens_the_call_window() {
        assert_eq!(finishing(), vec![WindowStep::Hide(OVERLAY), CALL_SHOWN]);
    }

    /// `app-shell`, "Сочетание при другом активном приложении" and
    /// "Сочетание во время звонка".
    #[test]
    fn toggle_call_opens_the_call_in_progress_or_the_widget() {
        let widget = WindowStep::Show {
            label: WIDGET,
            route: None,
        };
        for compact in [true, false] {
            assert_eq!(toggle_call(CallSessionStatus::Idle, compact), vec![widget]);
            assert_eq!(
                toggle_call(CallSessionStatus::Finishing, compact),
                vec![CALL_SHOWN],
                "the summary is built in the main window"
            );
        }
        assert_eq!(
            toggle_call(CallSessionStatus::Live, true),
            vec![OVERLAY_SHOWN]
        );
        assert_eq!(
            toggle_call(CallSessionStatus::Live, false),
            vec![CALL_SHOWN]
        );
    }
}
