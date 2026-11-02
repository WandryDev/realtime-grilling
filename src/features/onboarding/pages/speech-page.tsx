"use client";

import { useEffect } from "react";

import { toast } from "@/components/ui/toast";
import {
  cancelSpeechModel,
  downloadSpeechModel,
  forceSpeechModel,
  pauseSpeechModel,
  resumeSpeechModel,
  retrySpeechModel,
  type SpeechModelStatus,
  setSpeechLanguage,
  useSpeechSetup,
} from "@/data/onboarding-setup";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import { SPEECH_MODEL } from "../mock";
import {
  type SpeechModelHandlers,
  SpeechModelScreen,
  type SpeechModelState,
} from "../screens/speech-model-screen";
import { speechModelInfo } from "../speech-model";
import { useMicCheckTranscript } from "../use-live-audio";

const DEMO_STATES = [
  "language",
  "downloading",
  "paused",
  "checking",
  "ready",
  "no-space",
  "no-network",
] as const;

type DemoState = (typeof DEMO_STATES)[number];

/** Store status and progress each forced state starts from. */
const DEMO_MODEL: Record<
  DemoState,
  { percent: number; status: SpeechModelStatus }
> = {
  checking: { percent: 100, status: "checking" },
  downloading: { percent: SPEECH_MODEL.percent, status: "downloading" },
  language: { percent: 0, status: "idle" },
  "no-network": {
    percent: SPEECH_MODEL.interrupted.percent,
    status: "no-network",
  },
  "no-space": { percent: 0, status: "no-space" },
  paused: { percent: SPEECH_MODEL.percent, status: "paused" },
  ready: { percent: 100, status: "ready" },
};

function screenState(status: SpeechModelStatus): SpeechModelState {
  if (status === "idle") {
    return "language";
  }
  if (status === "paused") {
    return "downloading";
  }
  return status;
}

function openStorage() {
  // MOCK: the real app opens System Settings → Storage
  toast.add({
    description: "Освободите место и нажмите «Повторить».",
    title: "Открыли «Хранилище» macOS",
    type: "info",
  });
}

const HANDLERS: SpeechModelHandlers = {
  onCancel: cancelSpeechModel,
  onDownload: downloadSpeechModel,
  onLanguageChange: setSpeechLanguage,
  onOpenStorage: openStorage,
  onPause: pauseSpeechModel,
  onResume: resumeSpeechModel,
  onRetry: retrySpeechModel,
};

/* /onboarding/speech: step 03, the speech model download. */
export function SpeechPage() {
  const demo = useDemoState(DEMO_STATES);
  const speech = useSpeechSetup();
  const paused = speech.status === "paused";
  const ready = speech.status === "ready";

  useEffect(() => {
    if (demo) {
      const { percent, status } = DEMO_MODEL[demo];
      forceSpeechModel(status, percent);
    }
  }, [demo]);

  const transcript = useMicCheckTranscript(SPEECH_MODEL.transcript, ready);
  const model = {
    ...speechModelInfo({
      language: speech.language,
      paused,
      percent: speech.percent,
    }),
    transcript,
  };

  return (
    <SpeechModelScreen
      backHref={routes.onboarding("permissions")}
      className="h-svh"
      handlers={HANDLERS}
      language={speech.language}
      model={model}
      nextHref={routes.onboarding("agent")}
      paused={paused}
      state={screenState(speech.status)}
    />
  );
}
