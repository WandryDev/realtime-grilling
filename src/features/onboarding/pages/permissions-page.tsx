"use client";

import { useEffect } from "react";

import { toast } from "@/components/ui/toast";
import {
  answerMicrophone,
  answerScreenAudio,
  forcePermissions,
  loadPermissions,
  openPrivacySettings,
  type PermissionsSetup,
  recheckPermissions,
  requestMicrophone,
  requestScreenAudio,
  restartForPermissions,
  usePermissionsSetup,
} from "@/data/onboarding-setup";
import { inTauri } from "@/effect/runtime";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import { useRunsOnWindows } from "../platform";
import {
  type PermissionsHandlers,
  PermissionsScreen,
  type PermissionsState,
} from "../screens/permissions-screen";
import { useAudioLevelCheck, useWindowFocus } from "../use-live-audio";

const DEMO_STATES = [
  "idle",
  "prompt",
  "granted",
  "denied",
  "unknown",
  "windows",
] as const satisfies readonly PermissionsState[];

const DEMO_ACCESS: Record<
  PermissionsState,
  Pick<PermissionsSetup, "microphone" | "screenAudio">
> = {
  denied: { microphone: "granted", screenAudio: "denied" },
  granted: { microphone: "granted", screenAudio: "granted" },
  idle: { microphone: "idle", screenAudio: "idle" },
  prompt: { microphone: "asking", screenAudio: "idle" },
  unknown: { microphone: "granted", screenAudio: "unknown" },
  windows: { microphone: "granted", screenAudio: "idle" },
};

function openSettings() {
  openPrivacySettings();
  if (inTauri) {
    return;
  }
  // MOCK: the app opens System Settings on the right pane itself
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
  onRestart: restartForPermissions,
};

/* /onboarding/permissions: step 02, microphone and call audio. */
export function PermissionsPage() {
  const demo = useDemoState(DEMO_STATES);
  const permissions = usePermissionsSetup();
  const onWindows = useRunsOnWindows();
  const windows = demo ? demo === "windows" : onWindows;
  const unknownSystemAudio = !windows && permissions.screenAudio === "unknown";

  useEffect(() => {
    if (demo) {
      forcePermissions(DEMO_ACCESS[demo]);
    } else {
      loadPermissions();
    }
  }, [demo]);
  // Back from System Settings: the toggle may be on now
  useWindowFocus(loadPermissions);

  const microphone = useAudioLevelCheck(
    "microphone",
    !(windows || unknownSystemAudio) && permissions.microphone === "granted"
  );
  const system = useAudioLevelCheck("system", windows || unknownSystemAudio);

  return (
    <PermissionsScreen
      backHref={routes.onboarding()}
      checking={permissions.checking}
      className="h-svh"
      drawSystemPrompt={!inTauri}
      handlers={HANDLERS}
      messages={{
        microphone: permissions.microphoneMessage,
        screenAudio: permissions.screenAudioMessage,
      }}
      microphone={permissions.microphone}
      microphoneLevel={{ ...microphone.bars, problem: microphone.problem }}
      nextHref={routes.onboarding("speech")}
      restartNeeded={permissions.screenAudioRestart}
      screenAudio={permissions.screenAudio}
      silentSystemAudio={system.silentWhilePlaying}
      soundActive={system.bars.active}
      soundLevels={system.bars.levels}
      soundProblem={system.problem}
      state={windows ? "windows" : undefined}
      systemLevel={{ ...system.bars, problem: system.problem }}
    />
  );
}
