"use client";

import { useEffect } from "react";

import { resetIntegrations } from "@/data/integrations";

/*
 * The integrations store starts with everything connected (what Settings and
 * projects show). Onboarding starts from a clean slate instead: the first
 * time any step 05–06 opens in this session it disconnects every service.
 * Later visits keep what the user connected, so the list reflects it.
 *
 * `seed` forces a `?demo=` state into the store right after that, in the
 * same effect, so the reset never wipes it.
 */
let started = false;

export function useOnboardingIntegrationsSession(seed?: () => void) {
  useEffect(() => {
    if (!started) {
      started = true;
      resetIntegrations();
    }
    seed?.();
  }, [seed]);
}
