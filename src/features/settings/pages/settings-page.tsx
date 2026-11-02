"use client";

import { type ReactNode, useEffect, useRef } from "react";

import { useIntegrations } from "@/data/integrations";
import { setMicrophoneMissing, useMicrophoneMissing } from "@/data/settings";
import type { SettingsSection } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { SettingsScreen } from "../components/settings-screen";
import type { SettingsSectionId } from "../mock";
import { NoMicrophoneStatus } from "../screens/audio-settings";
import { screenSection } from "../sections";
import { AgentSection } from "./agent-section";
import { AudioSection } from "./audio-section";
import { GeneralSection } from "./general-section";
import { IntegrationsSection } from "./integrations-section";
import { PrivacySection } from "./privacy-section";
import { WidgetSection } from "./widget-section";

/** States that clicking can't reach (see demo.ts). */
export const SETTINGS_DEMO_STATES = [
  "mic-disabled",
  "in-call",
  "limit-low",
  "recording",
  "outline-broken",
  "confirm-disconnect",
  "github-disconnected",
] as const;

/** The shortcut being recorded in ?demo=recording, as in Paper. */
const DEMO_RECORDING = "toggle-overlay";

/**
 * /settings/[section]: the settings window around the section's container.
 * Problems that show from every section (a missing microphone, a broken
 * service) light up the red dots and the sidebar status.
 */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const demo = useDemoState(SETTINGS_DEMO_STATES);
  const id = screenSection(section);
  const micMissing = useMicrophoneMissing();
  const integrations = useIntegrations();

  // Once per visit: Strict Mode runs effects twice in development.
  const appliedDemo = useRef<string>(undefined);
  useEffect(() => {
    if (demo === "mic-disabled" && appliedDemo.current !== demo) {
      setMicrophoneMissing(true);
    }
    appliedDemo.current = demo;
  }, [demo]);

  const alerts: SettingsSectionId[] = [];
  if (micMissing) {
    alerts.push("audio");
  }
  if (Object.values(integrations).some((state) => state.status === "error")) {
    alerts.push("integrations");
  }

  let body: ReactNode;
  switch (id) {
    case "audio":
      body = <AudioSection inCall={demo === "in-call"} />;
      break;
    case "agent":
      body = <AgentSection limitLow={demo === "limit-low"} />;
      break;
    case "widget":
      body = (
        <WidgetSection
          recordingDemo={demo === "recording" ? DEMO_RECORDING : undefined}
        />
      );
      break;
    case "privacy":
      body = <PrivacySection />;
      break;
    case "integrations":
      body = (
        <IntegrationsSection
          demo={
            demo === "outline-broken" ||
            demo === "confirm-disconnect" ||
            demo === "github-disconnected"
              ? demo
              : undefined
          }
        />
      );
      break;
    default:
      body = <GeneralSection />;
  }

  return (
    <SettingsScreen
      alerts={alerts}
      className="h-svh"
      // Key by demo so a forced state starts fresh when the navigator
      // switches states on the same route.
      key={`${section}:${demo ?? ""}`}
      navigation={id === "integrations" ? "panel" : "sidebar"}
      section={id}
      status={micMissing ? <NoMicrophoneStatus /> : undefined}
    >
      {body}
    </SettingsScreen>
  );
}
