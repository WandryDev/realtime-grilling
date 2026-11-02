"use client";

import { useEffect } from "react";

import { toast } from "@/components/ui/toast";
import {
  answerMicrophone,
  answerScreenAudio,
  forcePermissions,
  openPrivacySettings,
  recheckPermissions,
  requestMicrophone,
  requestScreenAudio,
  usePermissionsSetup,
} from "@/data/onboarding-setup";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import {
  type AccessState,
  type PermissionsHandlers,
  PermissionsScreen,
  type PermissionsState,
} from "../screens/permissions-screen";
import { useAudioLevelBars } from "../use-live-audio";

const DEMO_STATES = [
  "idle",
  "prompt",
  "granted",
  "denied",
  "windows",
] as const satisfies readonly PermissionsState[];

const DEMO_ACCESS: Record<
  PermissionsState,
  { microphone: AccessState; screenAudio: AccessState }
> = {
  denied: { microphone: "granted", screenAudio: "denied" },
  granted: { microphone: "granted", screenAudio: "granted" },
  idle: { microphone: "idle", screenAudio: "idle" },
  prompt: { microphone: "asking", screenAudio: "idle" },
  windows: { microphone: "granted", screenAudio: "idle" },
};

function openSettings() {
  openPrivacySettings();
  // MOCK: the real app opens System Settings on the right pane
  toast.add({
    description:
      "«Конфиденциальность и безопасность» открылись. Включите Grill и нажмите «Проверить».",
    title: "Открыли настройки macOS",
    type: "info",
  });
}

async function recheck() {
  const granted = await recheckPermissions();
  if (!granted) {
    toast.add({
      description: "Включите переключатель рядом с Grill в настройках macOS.",
      title: "Доступ всё ещё выключен",
      type: "warning",
    });
  }
}

const HANDLERS: PermissionsHandlers = {
  onAnswerMicrophone: answerMicrophone,
  onAnswerScreenAudio: answerScreenAudio,
  onOpenSettings: openSettings,
  onRecheck: recheck,
  onRequestMicrophone: requestMicrophone,
  onRequestScreenAudio: requestScreenAudio,
};

/* /onboarding/permissions: step 02, microphone and call audio. */
export function PermissionsPage() {
  const demo = useDemoState(DEMO_STATES);
  const permissions = usePermissionsSetup();
  const windows = demo === "windows";

  useEffect(() => {
    if (demo) {
      forcePermissions(DEMO_ACCESS[demo]);
    }
  }, [demo]);

  const microphoneLevel = useAudioLevelBars(
    "microphone",
    !windows && permissions.microphone === "granted"
  );
  const systemLevel = useAudioLevelBars("system", windows);

  return (
    <PermissionsScreen
      backHref={routes.onboarding()}
      checking={permissions.checking}
      className="h-svh"
      handlers={HANDLERS}
      microphone={permissions.microphone}
      microphoneLevel={microphoneLevel}
      nextHref={routes.onboarding("speech")}
      screenAudio={permissions.screenAudio}
      soundActive={systemLevel.active}
      soundLevels={systemLevel.levels}
      state={windows ? "windows" : undefined}
    />
  );
}
