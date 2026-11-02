"use client";

import { useSearchParams } from "next/navigation";

import type { IntegrationService } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import {
  CLICKUP_DEMO_STATES,
  ClickUpConnectFlow,
} from "./clickup-connect-flow";
import { GITHUB_DEMO_STATES, GitHubConnectFlow } from "./github-connect-flow";
import {
  OUTLINE_DEMO_STATES,
  OutlineConnectFlow,
} from "./outline-connect-flow";

/*
 * /onboarding/integrations/[service] — steps 05a–05c. `?from=done` returns
 * to the summary instead of the list. Each flow is keyed by its demo state
 * so jumping between states in the dev navigator starts it fresh.
 */
export function ServiceConnectPage({
  service,
}: {
  service: IntegrationService;
}) {
  const from = useSearchParams().get("from") === "done" ? "done" : undefined;

  switch (service) {
    case "github":
      return <GitHubStep from={from} />;
    case "outline":
      return <OutlineStep from={from} />;
    default:
      return <ClickUpStep from={from} />;
  }
}

interface StepProps {
  from?: "done";
}

function GitHubStep({ from }: StepProps) {
  const demo = useDemoState(GITHUB_DEMO_STATES);
  return <GitHubConnectFlow demo={demo} from={from} key={demo ?? "live"} />;
}

function OutlineStep({ from }: StepProps) {
  const demo = useDemoState(OUTLINE_DEMO_STATES);
  return <OutlineConnectFlow demo={demo} from={from} key={demo ?? "live"} />;
}

function ClickUpStep({ from }: StepProps) {
  const demo = useDemoState(CLICKUP_DEMO_STATES);
  return <ClickUpConnectFlow demo={demo} from={from} key={demo ?? "live"} />;
}
