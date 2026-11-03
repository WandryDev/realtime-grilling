//! The debounce of "микрофон занят" (design.md, decision 4): a pure state
//! machine. In: snapshots of the processes that hold an input, and the time.
//! Out: `busy` at once, `free` only after [`RELEASE_DELAY_MS`] without any
//! foreign input, so a call app restarting its stream is not the end of the
//! call. The clock is the caller's: every input carries its time.

/// How long the input stays free before `free` (spec: 5 s).
pub const RELEASE_DELAY_MS: i64 = 5_000;

/// A process that captures from an input device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub pid: u32,
    /// The app to show: "Google Chrome", not its helper process.
    pub app: String,
}

/// What the windows are told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    /// A busy period began: no foreign input before, now there is.
    Busy { app: String, since: i64 },
    /// Same busy period, another app holds the input now. `since` is the
    /// start of the period.
    AppChanged { app: String, since: i64 },
    /// No foreign input for the whole delay. `released_at` is when the
    /// input went away, not when the delay ran out.
    Free { app: String, released_at: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum State {
    /// `app`: who held it last, `None` before the first busy period.
    Free {
        app: Option<String>,
        since: i64,
    },
    Busy {
        app: String,
        since: i64,
    },
    /// Busy for the windows; the input went away at `released_at`.
    Releasing {
        app: String,
        since: i64,
        released_at: i64,
    },
}

/// The current state as the windows see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    pub busy: bool,
    pub app: Option<String>,
    /// Start of the busy period, or when the input was released (the
    /// watcher's start before the first busy period).
    pub since: i64,
}

#[derive(Debug)]
pub struct Debouncer {
    own_pid: u32,
    state: State,
}

impl Debouncer {
    /// Starts free at `now`. Holders with `own_pid` are ignored: the app's
    /// own capture (recording, level check) is not "busy".
    pub const fn new(own_pid: u32, now: i64) -> Self {
        Self {
            own_pid,
            state: State::Free {
                app: None,
                since: now,
            },
        }
    }

    pub fn activity(&self) -> Activity {
        match &self.state {
            State::Free { app, since } => Activity {
                busy: false,
                app: app.clone(),
                since: *since,
            },
            State::Busy { app, since } | State::Releasing { app, since, .. } => Activity {
                busy: true,
                app: Some(app.clone()),
                since: *since,
            },
        }
    }

    /// When [`Self::tick`] would send `free`, if no input comes back.
    pub const fn deadline(&self) -> Option<i64> {
        match self.state {
            State::Releasing { released_at, .. } => Some(released_at + RELEASE_DELAY_MS),
            _ => None,
        }
    }

    /// A new snapshot of who captures from an input, taken at `now`.
    pub fn observe(&mut self, holders: &[Holder], now: i64) -> Option<Transition> {
        let foreign: Vec<&Holder> = holders
            .iter()
            .filter(|holder| holder.pid != self.own_pid)
            .collect();
        if foreign.is_empty() {
            return self.released(now);
        }
        let pick = |current: &str| -> String {
            // The app that holds it keeps it while it does; otherwise the
            // first by name, so equal snapshots give the same app.
            if foreign.iter().any(|holder| holder.app == current) {
                return current.to_owned();
            }
            foreign
                .iter()
                .map(|holder| holder.app.as_str())
                .min()
                .unwrap_or_default()
                .to_owned()
        };
        match &self.state {
            State::Free { .. } => {
                let app = pick("");
                self.state = State::Busy {
                    app: app.clone(),
                    since: now,
                };
                Some(Transition::Busy { app, since: now })
            }
            State::Busy { app, since } | State::Releasing { app, since, .. } => {
                let since = *since;
                let next = pick(app);
                let changed = next != *app;
                self.state = State::Busy {
                    app: next.clone(),
                    since,
                };
                changed.then_some(Transition::AppChanged { app: next, since })
            }
        }
    }

    /// Time passed without a new snapshot (none was taken, or it failed):
    /// sends `free` once the delay of a release ran out. Never starts a
    /// release itself.
    pub fn tick(&mut self, now: i64) -> Option<Transition> {
        self.tick_releasing(now)
    }

    fn released(&mut self, now: i64) -> Option<Transition> {
        match &self.state {
            State::Free { .. } => None,
            State::Busy { app, since } => {
                self.state = State::Releasing {
                    app: app.clone(),
                    since: *since,
                    released_at: now,
                };
                self.tick_releasing(now)
            }
            State::Releasing { .. } => self.tick_releasing(now),
        }
    }

    fn tick_releasing(&mut self, now: i64) -> Option<Transition> {
        let State::Releasing {
            app, released_at, ..
        } = &self.state
        else {
            return None;
        };
        if now - released_at < RELEASE_DELAY_MS {
            return None;
        }
        let (app, released_at) = (app.clone(), *released_at);
        self.state = State::Free {
            app: Some(app.clone()),
            since: released_at,
        };
        Some(Transition::Free { app, released_at })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: u32 = 100;

    fn zoom() -> Holder {
        Holder {
            pid: 200,
            app: "zoom.us".to_owned(),
        }
    }

    fn chrome() -> Holder {
        Holder {
            pid: 300,
            app: "Google Chrome".to_owned(),
        }
    }

    fn own() -> Holder {
        Holder {
            pid: OWN,
            app: "Grill".to_owned(),
        }
    }

    fn busy(app: &str, since: i64) -> Option<Transition> {
        Some(Transition::Busy {
            app: app.to_owned(),
            since,
        })
    }

    #[test]
    fn a_call_starting_is_busy_at_once() {
        let mut debouncer = Debouncer::new(OWN, 0);
        assert!(!debouncer.activity().busy);
        assert_eq!(debouncer.observe(&[zoom()], 1_000), busy("zoom.us", 1_000));
        assert_eq!(
            debouncer.activity(),
            Activity {
                busy: true,
                app: Some("zoom.us".to_owned()),
                since: 1_000
            }
        );
        // The same snapshot again changes nothing.
        assert_eq!(debouncer.observe(&[zoom()], 3_000), None);
    }

    #[test]
    fn leaving_the_call_is_free_after_five_seconds_with_the_release_time() {
        let mut debouncer = Debouncer::new(OWN, 0);
        debouncer.observe(&[zoom()], 1_000);
        assert_eq!(debouncer.observe(&[], 10_000), None);
        assert!(debouncer.activity().busy, "busy until the delay ran out");
        assert_eq!(debouncer.deadline(), Some(15_000));
        assert_eq!(debouncer.tick(12_000), None);
        assert_eq!(debouncer.observe(&[], 14_999), None);
        assert_eq!(
            debouncer.tick(15_000),
            Some(Transition::Free {
                app: "zoom.us".to_owned(),
                released_at: 10_000
            })
        );
        assert_eq!(
            debouncer.activity(),
            Activity {
                busy: false,
                app: Some("zoom.us".to_owned()),
                since: 10_000
            }
        );
        assert_eq!(debouncer.deadline(), None);
        assert_eq!(debouncer.tick(30_000), None, "free only once");
    }

    #[test]
    fn a_stream_restart_within_two_seconds_is_not_free() {
        let mut debouncer = Debouncer::new(OWN, 0);
        debouncer.observe(&[zoom()], 1_000);
        assert_eq!(debouncer.observe(&[], 10_000), None);
        assert_eq!(debouncer.observe(&[zoom()], 12_000), None);
        assert_eq!(debouncer.tick(16_000), None);
        assert_eq!(debouncer.deadline(), None);
        assert_eq!(debouncer.activity().since, 1_000, "the same busy period");
        // A later release counts from its own time.
        debouncer.observe(&[], 20_000);
        assert_eq!(debouncer.tick(24_999), None);
        assert!(matches!(
            debouncer.tick(25_000),
            Some(Transition::Free {
                released_at: 20_000,
                ..
            })
        ));
    }

    #[test]
    fn another_app_taking_over_changes_the_app_in_the_same_period() {
        let mut debouncer = Debouncer::new(OWN, 0);
        debouncer.observe(&[zoom()], 1_000);
        // Both hold it: the first one keeps it.
        assert_eq!(debouncer.observe(&[chrome(), zoom()], 2_000), None);
        assert_eq!(
            debouncer.observe(&[chrome()], 3_000),
            Some(Transition::AppChanged {
                app: "Google Chrome".to_owned(),
                since: 1_000
            })
        );
        // Zoom leaves, Chrome comes within the delay: no free in between.
        let mut debouncer = Debouncer::new(OWN, 0);
        debouncer.observe(&[zoom()], 1_000);
        debouncer.observe(&[], 2_000);
        assert!(matches!(
            debouncer.observe(&[chrome()], 4_000),
            Some(Transition::AppChanged { .. })
        ));
        assert_eq!(debouncer.tick(10_000), None);
        // After a free, the next app starts a new period.
        debouncer.observe(&[], 11_000);
        debouncer.tick(16_000);
        assert_eq!(
            debouncer.observe(&[zoom()], 17_000),
            busy("zoom.us", 17_000)
        );
    }

    #[test]
    fn the_apps_own_capture_is_ignored() {
        let mut debouncer = Debouncer::new(OWN, 0);
        assert_eq!(debouncer.observe(&[own()], 1_000), None);
        assert!(!debouncer.activity().busy);
        debouncer.observe(&[own(), zoom()], 2_000);
        // Only our own capture left: Zoom released it.
        assert_eq!(debouncer.observe(&[own()], 3_000), None);
        assert!(matches!(
            debouncer.tick(8_000),
            Some(Transition::Free {
                released_at: 3_000,
                ..
            })
        ));
    }

    #[test]
    fn time_alone_never_frees_a_busy_input() {
        let mut debouncer = Debouncer::new(OWN, 0);
        debouncer.observe(&[zoom()], 1_000);
        assert_eq!(debouncer.tick(60_000), None);
        assert!(debouncer.activity().busy);
    }

    #[test]
    fn several_apps_at_start_pick_the_same_one_every_time() {
        let mut first = Debouncer::new(OWN, 0);
        let mut second = Debouncer::new(OWN, 0);
        assert_eq!(
            first.observe(&[zoom(), chrome()], 1_000),
            second.observe(&[chrome(), zoom()], 1_000)
        );
    }
}
