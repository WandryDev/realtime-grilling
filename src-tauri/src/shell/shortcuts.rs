//! Global shortcuts from Settings (design.md, decision 6).
//!
//! The frontend stores a shortcut as key caps in the macOS order
//! (`["⌃", "⌥", "⇧", "⌘", "G"]`). Rust turns them into an accelerator for
//! `tauri-plugin-global-shortcut` and is the only side that registers them.

use std::{collections::BTreeMap, str::FromStr, sync::Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    GlobalShortcut, GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState,
};
use tauri_specta::Event;

use super::windows;
use crate::{events::ShortcutPressed, storage::settings::Shortcuts};

/// Why a shortcut from Settings is not active.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutError {
    /// Action id, a key of `shortcuts`.
    pub action: String,
    /// The key caps that failed.
    pub keys: Vec<String>,
    pub message: String,
}

pub const TOGGLE_CALL: &str = "toggle-call";
pub const TOGGLE_OVERLAY: &str = "toggle-overlay";

/// Modifier caps in the macOS order, with their accelerator names.
/// `⌘` is Command on macOS and Ctrl on Windows, so `⌥⌘G` works on both.
const MODIFIERS: [(&str, &str); 4] = [
    ("⌃", "Control"),
    ("⌥", "Alt"),
    ("⇧", "Shift"),
    ("⌘", "CommandOrControl"),
];

/// Caps of named keys (see `src/features/settings/shortcut-keys.ts`).
const NAMED_KEYS: [(&str, &str); 10] = [
    ("↓", "ArrowDown"),
    ("←", "ArrowLeft"),
    ("→", "ArrowRight"),
    ("↑", "ArrowUp"),
    ("⌫", "Backspace"),
    ("⌦", "Delete"),
    ("↩", "Enter"),
    ("⇥", "Tab"),
    ("⎋", "Escape"),
    ("Space", "Space"),
];

/// Key caps → accelerator, e.g. `["⌥", "⌘", "→"]` → `Alt+CommandOrControl+ArrowRight`.
/// An empty list means "not set" and gives `None`.
pub fn accelerator(keys: &[String]) -> Result<Option<String>, String> {
    if keys.is_empty() {
        return Ok(None);
    }
    let mut held = [false; MODIFIERS.len()];
    let mut main_key: Option<&str> = None;
    for key in keys {
        if let Some(index) = MODIFIERS.iter().position(|(cap, _)| cap == key) {
            held[index] = true;
            continue;
        }
        if main_key.is_some() {
            return Err("В сочетании может быть только одна основная клавиша".to_owned());
        }
        main_key = Some(key);
    }
    let Some(main_key) = main_key else {
        return Err("В сочетании нет основной клавиши".to_owned());
    };
    if !held.contains(&true) {
        return Err("Глобальному сочетанию нужен модификатор: ⌃, ⌥, ⇧ или ⌘".to_owned());
    }
    let key = NAMED_KEYS
        .iter()
        .find(|(cap, _)| *cap == main_key)
        .map_or(main_key, |(_, name)| name);
    let mut parts: Vec<&str> = MODIFIERS
        .iter()
        .zip(held)
        .filter_map(|((_, name), on)| on.then_some(*name))
        .collect();
    parts.push(key);
    let accelerator = parts.join("+");
    Shortcut::from_str(&accelerator)
        .map_err(|_| format!("Клавиша «{main_key}» не поддерживается в глобальных сочетаниях"))?;
    Ok(Some(accelerator))
}

/// The action and keys of every shortcut the app registered, by action.
type Active = BTreeMap<String, (Vec<String>, Shortcut)>;

/// Shortcuts registered by the app.
///
/// `on_shortcut` runs on the main thread, and registering a shortcut waits
/// for the main thread. So `apply` never holds the lock `on_shortcut` takes
/// while it registers: it builds the new set unlocked and swaps it in at
/// the end. `applying` only keeps two `apply` calls from interleaving;
/// `on_shortcut` never touches it.
#[derive(Default)]
pub struct Registered {
    applying: Mutex<()>,
    active: Mutex<Active>,
}

impl Registered {
    fn active(&self) -> std::sync::MutexGuard<'_, Active> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The action of a pressed shortcut. Takes the lock only to look it up.
    fn action_of(&self, shortcut: &Shortcut) -> Option<String> {
        self.active()
            .iter()
            .find(|(_, (_, registered))| registered.id() == shortcut.id())
            .map(|(action, _)| action.clone())
    }
}

/// What applying the shortcuts gave: the keys now active (or kept) per action
/// and the actions that failed.
pub struct Applied {
    /// For every requested action: the new keys if they registered, otherwise
    /// the keys that were active before (they keep working).
    pub effective: Shortcuts,
    pub errors: Vec<ShortcutError>,
}

/// Registers shortcuts with the OS: the plugin in the app, a fake in tests.
pub trait Registrar {
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut);
}

impl<R: Runtime> Registrar for GlobalShortcut<R> {
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        GlobalShortcut::register(self, shortcut).map_err(|error| error.to_string())
    }

    fn unregister(&self, shortcut: Shortcut) {
        let _ = GlobalShortcut::unregister(self, shortcut);
    }
}

/// Replaces the app's global shortcuts. A shortcut that fails leaves the
/// previous one of that action registered; the others are not affected.
///
/// Blocks until the main thread registered them (macOS needs it there), so
/// call it from setup or a blocking task.
pub fn apply<R: Runtime>(app: &AppHandle<R>, requested: &Shortcuts) -> Applied {
    apply_with(&app.state::<Registered>(), app.global_shortcut(), requested)
}

/// [`apply`] over any [`Registrar`].
pub fn apply_with(
    registry: &Registered,
    manager: &impl Registrar,
    requested: &Shortcuts,
) -> Applied {
    let _applying = registry
        .applying
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A copy: the lock is not held while the OS (un)registers.
    let previous = registry.active().clone();
    for (_, shortcut) in previous.values() {
        manager.unregister(*shortcut);
    }

    let mut next = Active::new();
    let mut taken: BTreeMap<u32, String> = BTreeMap::new();
    let mut effective = Shortcuts::new();
    let mut errors = Vec::new();
    let mut register = |action: &str, keys: &[String]| -> Result<(), String> {
        let Some(accelerator) = accelerator(keys)? else {
            return Ok(());
        };
        let shortcut = Shortcut::from_str(&accelerator).map_err(|error| error.to_string())?;
        if let Some(other) = taken.get(&shortcut.id()) {
            return Err(format!("Это сочетание уже задано для действия «{other}»"));
        }
        manager.register(shortcut).map_err(|error| {
            format!("Система не дала зарегистрировать сочетание, возможно, его занимает другое приложение ({error})")
        })?;
        taken.insert(shortcut.id(), action.to_owned());
        next.insert(action.to_owned(), (keys.to_vec(), shortcut));
        Ok(())
    };

    for (action, keys) in requested {
        match register(action, keys) {
            Ok(()) => {
                effective.insert(action.clone(), keys.clone());
            }
            Err(message) => {
                errors.push(ShortcutError {
                    action: action.clone(),
                    keys: keys.clone(),
                    message,
                });
                let kept = previous
                    .get(action)
                    .map(|(keys, _)| keys.clone())
                    .filter(|keys| register(action, keys).is_ok())
                    .unwrap_or_default();
                effective.insert(action.clone(), kept);
            }
        }
    }
    *registry.active() = next;
    Applied { effective, errors }
}

/// Runs the action of a pressed shortcut.
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    let Some(action) = app.state::<Registered>().action_of(shortcut) else {
        return;
    };
    match action.as_str() {
        TOGGLE_CALL => windows::show(app, windows::WIDGET),
        TOGGLE_OVERLAY => windows::toggle(app, windows::OVERLAY),
        _ => {}
    }
    // Every window hears the action; the call screens handle the rest.
    if let Err(error) = (ShortcutPressed { action }).emit(app) {
        eprintln!("grill: failed to emit shortcut-pressed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, mpsc},
        time::Duration,
    };

    use super::*;

    fn caps(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|key| (*key).to_owned()).collect()
    }

    fn accel(keys: &[&str]) -> Result<Option<String>, String> {
        accelerator(&caps(keys))
    }

    #[test]
    fn maps_the_default_shortcuts() {
        assert_eq!(
            accel(&["⌥", "⌘", "G"]).unwrap().as_deref(),
            Some("Alt+CommandOrControl+G")
        );
        assert_eq!(
            accel(&["⌥", "⌘", "→"]).unwrap().as_deref(),
            Some("Alt+CommandOrControl+ArrowRight")
        );
        assert_eq!(
            accel(&["⌥", "⌘", "↩"]).unwrap().as_deref(),
            Some("Alt+CommandOrControl+Enter")
        );
        assert_eq!(
            accel(&["⌥", "⌘", "⌫"]).unwrap().as_deref(),
            Some("Alt+CommandOrControl+Backspace")
        );
    }

    #[test]
    fn keeps_the_macos_modifier_order() {
        assert_eq!(
            accel(&["⌘", "⇧", "⌥", "⌃", "K"]).unwrap().as_deref(),
            Some("Control+Alt+Shift+CommandOrControl+K")
        );
    }

    #[test]
    fn maps_named_keys_digits_and_symbols() {
        for (cap, name) in NAMED_KEYS {
            let expected = format!("Shift+{name}");
            assert_eq!(accel(&["⇧", cap]).unwrap(), Some(expected));
        }
        assert_eq!(accel(&["⌃", "7"]).unwrap().as_deref(), Some("Control+7"));
        assert_eq!(accel(&["⌃", ","]).unwrap().as_deref(), Some("Control+,"));
        assert_eq!(accel(&["⌃", "F5"]).unwrap().as_deref(), Some("Control+F5"));
    }

    #[test]
    fn every_accelerator_parses() {
        for keys in [
            caps(&["⌥", "⌘", "O"]),
            caps(&["⌃", "⇧", "Space"]),
            caps(&["⌘", "↑"]),
        ] {
            let accelerator = accelerator(&keys).unwrap().unwrap();
            assert!(Shortcut::from_str(&accelerator).is_ok(), "{accelerator}");
        }
    }

    #[test]
    fn empty_means_not_set() {
        assert_eq!(accel(&[]).unwrap(), None);
    }

    #[test]
    fn rejects_invalid_shortcuts() {
        assert!(accel(&["G"]).is_err(), "no modifier");
        assert!(accel(&["⌘"]).is_err(), "no main key");
        assert!(accel(&["⌘", "G", "H"]).is_err(), "two main keys");
        assert!(accel(&["⌘", "П"]).is_err(), "unknown key");
    }

    /// Plays the OS: registering waits for the "main thread", which is busy
    /// running `on_shortcut` for a key the user pressed meanwhile. If
    /// `apply` held the lock `on_shortcut` takes, this would never finish.
    struct MainThread {
        registry: Arc<Registered>,
        refused: Vec<u32>,
        registered: Mutex<Vec<u32>>,
    }

    impl Registrar for MainThread {
        fn register(&self, shortcut: Shortcut) -> Result<(), String> {
            let registry = Arc::clone(&self.registry);
            let (done, finished) = mpsc::channel();
            std::thread::spawn(move || {
                let pressed = Shortcut::from_str("Alt+CommandOrControl+G").unwrap();
                let _ = done.send(registry.action_of(&pressed));
            });
            finished
                .recv_timeout(Duration::from_secs(5))
                .expect("on_shortcut is blocked while apply registers");
            if self.refused.contains(&shortcut.id()) {
                return Err("taken".to_owned());
            }
            self.registered.lock().unwrap().push(shortcut.id());
            Ok(())
        }

        fn unregister(&self, shortcut: Shortcut) {
            self.registered
                .lock()
                .unwrap()
                .retain(|id| *id != shortcut.id());
        }
    }

    fn shortcuts(pairs: &[(&str, &[&str])]) -> Shortcuts {
        pairs
            .iter()
            .map(|(action, keys)| ((*action).to_owned(), caps(keys)))
            .collect()
    }

    #[test]
    fn apply_does_not_block_on_shortcut_while_registering() {
        let registry = Arc::new(Registered::default());
        let os = MainThread {
            registry: Arc::clone(&registry),
            refused: vec![Shortcut::from_str("Alt+CommandOrControl+K").unwrap().id()],
            registered: Mutex::default(),
        };
        let first = apply_with(
            &registry,
            &os,
            &shortcuts(&[
                (TOGGLE_CALL, &["⌥", "⌘", "G"]),
                (TOGGLE_OVERLAY, &["⌥", "⌘", "O"]),
            ]),
        );
        assert!(first.errors.is_empty());
        let pressed = Shortcut::from_str("Alt+CommandOrControl+G").unwrap();
        assert_eq!(registry.action_of(&pressed).as_deref(), Some(TOGGLE_CALL));

        // ⌥⌘K is taken: toggle-overlay keeps ⌥⌘O, toggle-call moves to ⌥⌘J.
        let second = apply_with(
            &registry,
            &os,
            &shortcuts(&[
                (TOGGLE_CALL, &["⌥", "⌘", "J"]),
                (TOGGLE_OVERLAY, &["⌥", "⌘", "K"]),
            ]),
        );
        assert_eq!(second.errors.len(), 1);
        assert_eq!(second.errors[0].action, TOGGLE_OVERLAY);
        assert_eq!(second.effective[TOGGLE_OVERLAY], caps(&["⌥", "⌘", "O"]));
        assert_eq!(second.effective[TOGGLE_CALL], caps(&["⌥", "⌘", "J"]));
        assert_eq!(registry.action_of(&pressed), None);
        let overlay = Shortcut::from_str("Alt+CommandOrControl+O").unwrap();
        assert_eq!(
            registry.action_of(&overlay).as_deref(),
            Some(TOGGLE_OVERLAY)
        );
        assert_eq!(os.registered.lock().unwrap().len(), 2);
    }
}
