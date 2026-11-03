//! Which app a capturing process belongs to, and whether it is one of ours
//! (design.md, decisions 2–3). Pure functions over paths and process
//! tables, so every platform's rules are tested on every platform.

#[cfg(any(windows, test))]
use std::collections::HashMap;

/// macOS: the name of the *outermost* `.app` a path lies in. A browser
/// helper (`Google Chrome.app/…/Google Chrome Helper.app/…`) is its browser.
/// `None` outside any bundle (daemons, XPC services of the system).
#[cfg(any(target_os = "macos", test))]
pub fn outermost_app(path: &str) -> Option<String> {
    path.split('/')
        .find_map(|component| {
            let (stem, extension) = component.rsplit_once('.')?;
            (extension.eq_ignore_ascii_case("app") && !stem.is_empty()).then_some(stem)
        })
        .map(str::to_owned)
}

/// Windows: the exe's `FileDescription` ("Google Chrome" for `chrome.exe`),
/// else its file name without `.exe`. `path` may be a bare file name (the
/// process table has only that).
#[cfg(any(windows, test))]
pub fn windows_app_name(description: Option<&str>, path: &str) -> Option<String> {
    if let Some(description) = description.map(str::trim).filter(|text| !text.is_empty()) {
        return Some(description.to_owned());
    }
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path).trim();
    let stem = match file.len().checked_sub(4) {
        Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".exe") => {
            &file[..cut]
        }
        _ => file,
    };
    (!stem.is_empty()).then(|| stem.to_owned())
}

/// Windows: whether `pid` is `root` or descends from it, by the parent ids
/// of a process snapshot. WebView2 runs in child processes of the app.
/// Parents may be gone and their ids reused, so the walk is bounded.
#[cfg(any(windows, test))]
pub fn in_process_tree(pid: u32, root: u32, parents: &HashMap<u32, u32>) -> bool {
    const MAX_DEPTH: usize = 64;
    let mut current = pid;
    for _ in 0..MAX_DEPTH {
        if current == root {
            return true;
        }
        match parents.get(&current) {
            Some(&parent) if parent != 0 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_helper_process_is_named_after_its_outermost_app() {
        for (path, expected) in [
            (
                "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131.0.6778.86/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
                Some("Google Chrome"),
            ),
            (
                "/Applications/zoom.us.app/Contents/MacOS/zoom.us",
                Some("zoom.us"),
            ),
            (
                "/Applications/Utilities/QuickTime Player.app/Contents/MacOS/QuickTime Player",
                Some("QuickTime Player"),
            ),
            (
                "/Users/me/Applications/Microsoft Teams.APP/Contents/MacOS/MSTeams",
                Some("Microsoft Teams"),
            ),
            (
                "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU",
                None,
            ),
            ("/usr/bin/say", None),
            ("/opt/tools/.app/bin/rec", None),
            ("", None),
        ] {
            assert_eq!(outermost_app(path).as_deref(), expected, "{path}");
        }
    }

    #[test]
    fn a_windows_exe_is_named_by_its_description_else_its_file_name() {
        for (description, path, expected) in [
            (
                Some("Google Chrome"),
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                Some("Google Chrome"),
            ),
            (
                Some("  Microsoft Teams  "),
                r"C:\Users\me\AppData\Local\Microsoft\Teams\ms-teams.exe",
                Some("Microsoft Teams"),
            ),
            (
                None,
                r"C:\Users\me\AppData\Roaming\Zoom\bin\Zoom.exe",
                Some("Zoom"),
            ),
            (Some(""), r"C:\Tools\recorder.EXE", Some("recorder")),
            (Some("   "), "Discord.exe", Some("Discord")),
            (None, r"C:\Tools\no-extension", Some("no-extension")),
            (None, r"C:\Tools\", None),
            (None, "", None),
        ] {
            assert_eq!(
                windows_app_name(description, path).as_deref(),
                expected,
                "{description:?} {path}"
            );
        }
    }

    #[test]
    fn the_process_tree_holds_the_app_and_its_descendants_only() {
        // 10 is the app, 11 its WebView2, 12 a WebView2 renderer; 20 is
        // Zoom, started by the shell 1.
        let parents = HashMap::from([(10, 1), (11, 10), (12, 11), (20, 1), (1, 0), (30, 30)]);
        assert!(in_process_tree(10, 10, &parents));
        assert!(in_process_tree(11, 10, &parents));
        assert!(in_process_tree(12, 10, &parents));
        assert!(!in_process_tree(20, 10, &parents));
        assert!(!in_process_tree(1, 10, &parents));
        assert!(
            !in_process_tree(30, 10, &parents),
            "a self-parent ends the walk"
        );
        assert!(!in_process_tree(99, 10, &parents), "unknown pid");
        // A cycle of reused ids ends too.
        let cycle = HashMap::from([(5, 6), (6, 5)]);
        assert!(!in_process_tree(5, 10, &cycle));
    }
}
