//! Why the agent can't be called now, shared by the fast and the slow loop
//! (agent-slow-loop design.md, decision 1): «Нужен вход» and a used-up
//! subscription limit stop both loops until the same event. The loop whose
//! call got the error sets it; both read it before a call.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::time::Instant;

/// What stops the calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Halted {
    /// Until a status check finds the agent ready (`agent_ready`).
    NeedsLogin,
    /// Until the limit resets (`until`, on the loops' clock; `resets_at`,
    /// Unix ms, as the CLI said), or a call goes through.
    RateLimited {
        until: Option<Instant>,
        resets_at: Option<i64>,
    },
}

/// The shared halt; cheap to clone.
#[derive(Debug, Clone, Default)]
pub struct AgentHalt(Arc<Mutex<Option<Halted>>>);

impl AgentHalt {
    fn lock(&self) -> MutexGuard<'_, Option<Halted>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn set(&self, halted: Halted) {
        *self.lock() = Some(halted);
    }

    /// A call went through, or the user asked for one: nothing stops them.
    pub fn clear(&self) {
        *self.lock() = None;
    }

    /// A status check found the agent ready: a missing login no longer
    /// stops the calls; a limit still does.
    pub fn clear_login(&self) {
        let mut halted = self.lock();
        if *halted == Some(Halted::NeedsLogin) {
            *halted = None;
        }
    }

    /// What stops the calls now; a limit whose reset time passed is over.
    pub fn active(&self) -> Option<Halted> {
        let mut halted = self.lock();
        if let Some(Halted::RateLimited {
            until: Some(until), ..
        }) = *halted
            && until <= Instant::now()
        {
            *halted = None;
        }
        *halted
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_limit_ends_at_its_reset_and_a_login_at_agent_ready() {
        let halt = AgentHalt::default();
        assert_eq!(halt.active(), None);
        let limited = Halted::RateLimited {
            until: Some(Instant::now() + Duration::from_secs(60)),
            resets_at: Some(1),
        };
        halt.clone().set(limited);
        halt.clear_login();
        assert_eq!(halt.active(), Some(limited), "a clone shares it");
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(halt.active(), None);

        halt.set(Halted::NeedsLogin);
        assert_eq!(halt.active(), Some(Halted::NeedsLogin));
        halt.clear_login();
        assert_eq!(halt.active(), None);

        halt.set(Halted::RateLimited {
            until: None,
            resets_at: None,
        });
        tokio::time::sleep(Duration::from_secs(3600)).await;
        assert!(halt.active().is_some(), "without a reset time it waits");
        halt.clear();
        assert_eq!(halt.active(), None);
    }
}
