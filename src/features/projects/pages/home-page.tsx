"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { useOnboardingDone } from "@/data/onboarding";
import { useProjects } from "@/data/projects";
import { inTauri } from "@/effect/runtime";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { recentCalls, toHomeProject } from "../project-data";
import { HomeScreen } from "../screens/home-screen";

/** `?demo=first-run`: home before the first project, even with projects. */
export const HOME_DEMO_STATES = ["first-run"] as const;

/**
 * `/`: home. In the browser it is also the onboarding gate: until the flag
 * is read nothing is drawn, and without onboarding the page goes to its
 * first step. In Tauri, Rust shows the onboarding window or this one, so
 * the main window never leaves for onboarding (it loads, hidden, before
 * onboarding is done).
 */
export function HomePage() {
  const router = useRouter();
  const onboardingDone = useOnboardingDone();
  const demo = useDemoState(HOME_DEMO_STATES);
  const projects = useProjects();
  const rows = useMemo(() => projects.map(toHomeProject), [projects]);
  const calls = useMemo(() => recentCalls(projects), [projects]);

  const gated = !(inTauri || demo);
  const needsOnboarding = gated && onboardingDone === false;
  useEffect(() => {
    if (needsOnboarding) {
      router.replace(routes.onboarding());
    }
  }, [needsOnboarding, router]);

  if (gated && onboardingDone !== true) {
    return <div aria-busy="true" className="bg-surface h-svh" />;
  }

  const isFirstRun = demo === "first-run" || projects.length === 0;
  return (
    <HomeScreen
      calls={calls}
      className="h-svh"
      projects={rows}
      state={isFirstRun ? "first-run" : "projects"}
    />
  );
}
