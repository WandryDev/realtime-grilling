"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { useOnboardingDone } from "@/data/onboarding";
import { useProjects } from "@/data/projects";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { recentCalls, toHomeProject } from "../project-data";
import { HomeScreen } from "../screens/home-screen";

/** `?demo=first-run`: home before the first project, even with projects. */
export const HOME_DEMO_STATES = ["first-run"] as const;

/**
 * `/`: the onboarding gate, then home. Until the flag is read nothing is
 * drawn; without onboarding the app goes to its first step.
 */
export function HomePage() {
  const router = useRouter();
  const onboardingDone = useOnboardingDone();
  const demo = useDemoState(HOME_DEMO_STATES);
  const projects = useProjects();
  const rows = useMemo(() => projects.map(toHomeProject), [projects]);
  const calls = useMemo(() => recentCalls(projects), [projects]);

  const needsOnboarding = onboardingDone === false && !demo;
  useEffect(() => {
    if (needsOnboarding) {
      router.replace(routes.onboarding());
    }
  }, [needsOnboarding, router]);

  if (onboardingDone !== true && !demo) {
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
