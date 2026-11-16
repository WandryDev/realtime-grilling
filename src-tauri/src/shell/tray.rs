//! Menu bar / tray icon (design.md, decision 6). During a call "Начать
//! звонок" gives way to "Открыть звонок" and "Завершить звонок"
//! (call-lifecycle design.md, decision 8).

use tauri::{
    App, AppHandle, Manager, Runtime,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_specta::Event;

use super::{QuitRequested, windows};
use crate::events::Navigate;

const TRAY: &str = "grill";

const OPEN: &str = "open";
const START_CALL: &str = "start-call";
const OPEN_CALL: &str = "open-call";
const FINISH_CALL: &str = "finish-call";
const SETTINGS: &str = "settings";
const QUIT: &str = "quit";

pub const SETTINGS_ROUTE: &str = "/settings/general";

/// A line of the tray menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    Item {
        id: &'static str,
        label: &'static str,
    },
    Separator,
}

/// The menu with or without a call in progress.
fn entries(in_call: bool) -> Vec<Entry> {
    let item = |id, label| Entry::Item { id, label };
    let mut entries = vec![item(OPEN, "Открыть Grill")];
    if in_call {
        entries.push(item(OPEN_CALL, "Открыть звонок"));
        entries.push(item(FINISH_CALL, "Завершить звонок"));
    } else {
        entries.push(item(START_CALL, "Начать звонок"));
    }
    entries.extend([
        item(SETTINGS, "Настройки"),
        Entry::Separator,
        item(QUIT, "Выйти"),
    ]);
    entries
}

fn menu<R: Runtime, M: Manager<R>>(manager: &M, in_call: bool) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(manager)?;
    for entry in entries(in_call) {
        match entry {
            Entry::Item { id, label } => {
                menu.append(&MenuItem::with_id(manager, id, label, true, None::<&str>)?)?;
            }
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(manager)?)?,
        }
    }
    Ok(menu)
}

pub fn create<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let menu = menu(app, false)?;
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .tooltip("Grill")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// The menu for a call that started (`true`) or ended.
pub fn set_in_call<R: Runtime>(app: &AppHandle<R>, in_call: bool) {
    let Some(tray) = app.tray_by_id(TRAY) else {
        return;
    };
    let updated = menu(app, in_call).and_then(|menu| tray.set_menu(Some(menu)));
    if let Err(error) = updated {
        eprintln!("grill: failed to update the tray menu: {error}");
    }
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        OPEN => super::show_entry(app),
        START_CALL => windows::show(app, windows::WIDGET),
        // As the `toggle-call` shortcut during a call.
        OPEN_CALL => crate::call::toggle_call(app),
        FINISH_CALL => crate::call::finish_current(app),
        SETTINGS => {
            windows::show(app, windows::MAIN);
            let navigate = Navigate {
                route: SETTINGS_ROUTE.to_owned(),
            };
            if let Err(error) = navigate.emit_to(app, windows::MAIN) {
                eprintln!("grill: failed to emit navigate: {error}");
            }
        }
        QUIT => QuitRequested::quit(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(in_call: bool) -> Vec<&'static str> {
        entries(in_call)
            .into_iter()
            .map(|entry| match entry {
                Entry::Item { label, .. } => label,
                Entry::Separator => "—",
            })
            .collect()
    }

    /// `app-shell`, "Иконка в трее".
    #[test]
    fn the_menu_follows_the_call() {
        assert_eq!(
            labels(false),
            vec!["Открыть Grill", "Начать звонок", "Настройки", "—", "Выйти"]
        );
        assert_eq!(
            labels(true),
            vec![
                "Открыть Grill",
                "Открыть звонок",
                "Завершить звонок",
                "Настройки",
                "—",
                "Выйти"
            ]
        );
    }
}
