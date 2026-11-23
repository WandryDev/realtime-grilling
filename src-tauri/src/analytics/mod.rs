//! The team's analytics (call-analytics design.md, decisions 5–7): the
//! contract of the events Grill sends, where it sends them and the sender.

pub mod contract;
pub mod sender;

/// The server's address in a release build: set by CI.
const BAKED: Option<&str> = option_env!("GRILL_ANALYTICS_URL");

/// Where the events go, or `None` when nothing is sent (decision 7): a
/// release build sends to the address baked into it; a debug build only to
/// `GRILL_ANALYTICS_URL` set when it starts; `grill-eval` never.
pub fn url() -> Option<String> {
    if cfg!(feature = "eval") {
        return None;
    }
    let url = if cfg!(debug_assertions) {
        std::env::var("GRILL_ANALYTICS_URL").ok()
    } else {
        BAKED.map(str::to_owned)
    };
    url.map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty())
}

#[cfg(test)]
mod tests {
    /// Spec «Debug-сборка»: without the variable nothing is sent, and the
    /// database opens with the queue off.
    #[test]
    fn a_debug_build_without_the_variable_sends_nothing() {
        assert!(std::env::var_os("GRILL_ANALYTICS_URL").is_none());
        assert_eq!(super::url(), None);
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::storage::Storage::open_in(dir.path());
        let on = storage
            .read_now(|connection| Ok(crate::storage::analytics::is_enabled(connection)))
            .unwrap();
        assert!(!on);
    }

    /// Nothing of the analytics in the windows' contract (spec «Тишина в
    /// интерфейсе Grill»).
    #[test]
    fn the_windows_know_nothing_of_the_analytics() {
        let bindings = std::fs::read_to_string(crate::bindings::bindings_path()).unwrap();
        assert!(!bindings.to_lowercase().contains("analytics"));
    }
}
