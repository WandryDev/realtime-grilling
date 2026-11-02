//! Menu bar / tray icon (design.md, decision 6).

use tauri::{
    App, AppHandle, Runtime,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_specta::Event;

use super::{QuitRequested, windows};
use crate::events::Navigate;

const OPEN: &str = "open";
const START_CALL: &str = "start-call";
const SETTINGS: &str = "settings";
const QUIT: &str = "quit";

pub const SETTINGS_ROUTE: &str = "/settings/general";

pub fn create<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN, "Открыть Grill", true, None::<&str>)?,
            &MenuItem::with_id(app, START_CALL, "Начать звонок", true, None::<&str>)?,
            &MenuItem::with_id(app, SETTINGS, "Настройки", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Выйти", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("grill")
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

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        OPEN => super::show_entry(app),
        START_CALL => windows::show(app, windows::WIDGET),
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
