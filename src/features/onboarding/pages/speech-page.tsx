"use client";

import { useEffect, useState } from "react";

import { toast } from "@/components/ui/toast";
import {
  cancelSpeechModel,
  downloadFallbackModel,
  downloadSpeechModel,
  followSpeechModels,
  forceSpeechModel,
  pauseSpeechModel,
  recheckSpeechModel,
  redownloadSpeechModel,
  resumeSpeechModel,
  retrySpeechModel,
  type SpeechSetup,
  setSpeechLanguage,
  startMicCheck,
  stopMicCheck,
  useSpeechSetup,
} from "@/data/onboarding-setup";
import {
  type BenchmarkResult,
  MOCK_BENCHMARK,
  type ModelState,
} from "@/features/speech/backend";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import {
  type SpeechModelHandlers,
  SpeechModelScreen,
  type SpeechModelState,
} from "../screens/speech-model-screen";
import { speechModelInfo } from "../speech-model";

const DEMO_STATES = [
  "language",
  "downloading",
  "paused",
  "checking",
  "ready",
  "check-failed",
  "no-space",
  "no-network",
] as const;

type DemoState = (typeof DEMO_STATES)[number];

const DEMO_PERCENT = 48;
const DEMO_SPACE = { freeBytes: 300_000_000, needBytes: 631_445_315 };
const DEMO_SLOW: BenchmarkResult = {
  p95Ms: 13_000,
  passed: false,
  reason: "slow",
  rtf: 2.1,
  wer: 0.05,
};

/** The mock model each forced state starts from (and its check). */
const DEMO_MODEL: Record<
  DemoState,
  { check?: BenchmarkResult; state: ModelState }
> = {
  "check-failed": { check: DEMO_SLOW, state: { status: "ready" } },
  checking: { state: { status: "checking" } },
  downloading: {
    state: {
      bytesPerSec: 12_400_000,
      percent: DEMO_PERCENT,
      status: "downloading",
    },
  },
  language: { state: { status: "notDownloaded" } },
  "no-network": {
    state: { percent: 63, retryInSec: 24, status: "noNetwork" },
  },
  "no-space": { state: { ...DEMO_SPACE, status: "noSpace" } },
  paused: { state: { percent: DEMO_PERCENT, status: "paused" } },
  ready: { check: MOCK_BENCHMARK, state: { status: "ready" } },
};

function screenState(speech: SpeechSetup): SpeechModelState {
  switch (speech.status) {
    case "idle":
      return "language";
    case "paused":
      return "downloading";
    case "ready":
      if (speech.check.status === "running" || speech.check.status === "idle") {
        return "checking";
      }
      if (speech.check.status === "done" && !speech.check.result.passed) {
        return "check-failed";
      }
      return "ready";
    default:
      return speech.status;
  }
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
  onDownloadFallback: downloadFallbackModel,
  onLanguageChange: setSpeechLanguage,
  onMicCheckAgain: startMicCheck,
  onOpenStorage: openStorage,
  onPause: pauseSpeechModel,
  onRecheck: recheckSpeechModel,
  onRedownload: redownloadSpeechModel,
  onResume: resumeSpeechModel,
  onRetry: retrySpeechModel,
};

const TICK_MS = 1000;

/** Now, ticking every second while `enabled` (the retry countdown). */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/* /onboarding/speech: step 03, the speech model download. */
export function SpeechPage() {
  const demo = useDemoState(DEMO_STATES);
  const speech = useSpeechSetup();
  const state = screenState(speech);
  const now = useNow(state === "no-network");

  useEffect(() => {
    followSpeechModels();
  }, []);

  useEffect(() => {
    if (demo) {
      const { check, state: forced } = DEMO_MODEL[demo];
      forceSpeechModel(forced, check);
    }
  }, [demo]);

  // The mic check listens once the model is ready, and stops on leaving.
  const ready = state === "ready";
  useEffect(() => {
    if (!ready) {
      return;
    }
    startMicCheck();
    return stopMicCheck;
  }, [ready]);

  return (
    <SpeechModelScreen
      backHref={routes.onboarding("permissions")}
      className="h-svh"
      handlers={HANDLERS}
      language={speech.language}
      model={speechModelInfo(speech, now)}
      nextHref={routes.onboarding("agent")}
      paused={speech.status === "paused"}
      state={state}
    />
  );
}
