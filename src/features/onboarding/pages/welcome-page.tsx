"use client";

import { routes } from "@/lib/routes";
import { WelcomeScreen } from "../screens/welcome-screen";

/* /onboarding: step 01, the greeting. */
export function WelcomePage() {
  return (
    <WelcomeScreen
      className="h-svh"
      nextHref={routes.onboarding("permissions")}
    />
  );
}
