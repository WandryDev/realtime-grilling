"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { takeOnboardingResume } from "@/data/onboarding";
import { routes } from "@/lib/routes";
import { WelcomeScreen } from "../screens/welcome-screen";

/* /onboarding: step 01, the greeting. */
export function WelcomePage() {
  const router = useRouter();

  // After "Перезапустить" on a later step, onboarding goes on from there.
  useEffect(() => {
    const resume = takeOnboardingResume();
    if (resume) {
      router.replace(resume);
    }
  }, [router]);

  return (
    <WelcomeScreen
      className="h-svh"
      nextHref={routes.onboarding("permissions")}
    />
  );
}
