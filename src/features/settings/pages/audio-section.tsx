"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AudioInputs } from "@/bindings";
import { useCallSession } from "@/data/call-session";
import { loadPermissions, usePermissionsSetup } from "@/data/onboarding-setup";
import {
  type StoredBenchmark,
  setMicrophoneMissing,
  updateSetting,
  useSettings,
} from "@/data/settings";
import { listenToWindowFocus } from "@/features/onboarding/api";
import {
  downloadModel,
  type ModelId,
  redownloadModel,
  removeModel,
  runBenchmark,
  selectModel,
  useSpeechModels,
} from "@/features/speech/api";

import {
  isAbortError,
  runSoundCheck,
  subscribeAudioInputs,
  subscribeInputLevel,
} from "../api";
import type { AudioChannel } from "../backend";
import {
  AudioSettings,
  type InputLevel,
  type MissingMicrophone,
  type SoundCheckState,
  type SpeechModelActions,
  SYSTEM_MICROPHONE,
} from "../screens/audio-settings";
import { useAbortSignal } from "../use-abort-signal";

const MODEL_ACTIONS: SpeechModelActions = {
  onDownload: downloadModel,
  onRedownload: redownloadModel,
  onRemove: removeModel,
};

const SILENT: InputLevel = { level: 0, problem: null };

/**
 * The live level of a channel while the section is open. The capture stops
 * when the source can't be opened or broke (the chosen microphone was
 * unplugged) and when the window was hidden; `retry` subscribes again
 * after such a stop (the devices changed), and so does the window getting
 * the focus back.
 */
function useInputLevel(channel: AudioChannel) {
  const [state, setState] = useState<InputLevel>(SILENT);
  const restart = useRef<() => void>(() => undefined);

  useEffect(() => {
    let stopped = false;
    let unsubscribe: () => void = () => undefined;
    const start = () => {
      stopped = false;
      unsubscribe = subscribeInputLevel(channel, {
        onEnd: () => {
          stopped = true;
          setState(SILENT);
        },
        onLevel: (level) => setState({ level, problem: null }),
        onProblem: (problem) => {
          stopped = true;
          setState({ level: 0, problem });
        },
      });
    };
    start();
    restart.current = () => {
      if (stopped) {
        unsubscribe();
        start();
      }
    };
    const stopFocus = listenToWindowFocus(() => restart.current());
    return () => {
      restart.current = () => undefined;
      stopFocus();
      unsubscribe();
    };
  }, [channel]);

  const retry = useCallback(() => restart.current(), []);
  return { retry, state };
}

/**
 * The computer's microphones while the section is open (Rust polls them
 * only while some window subscribed). `onChange` runs on every report.
 */
function useAudioInputs(onChange: () => void) {
  const [inputs, setInputs] = useState<AudioInputs | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(
    () =>
      subscribeAudioInputs((next) => {
        setInputs(next);
        changed.current();
      }),
    []
  );
  return inputs;
}

/** The chosen microphone when it is not among the devices. */
function missingMicrophone(
  inputs: AudioInputs | null,
  chosen: string
): MissingMicrophone | null {
  if (!inputs || chosen === SYSTEM_MICROPHONE) {
    return null;
  }
  if (inputs.devices.some((device) => device.id === chosen)) {
    return null;
  }
  return { name: chosen, since: inputs.missingSince ?? null };
}

/**
 * Settings → Звук и распознавание in the app. `inCall` locks devices and
 * the model (a live call, or ?demo=in-call); the backend refuses to change
 * the selected model while recording anyway (a toast says so). The models
 * and their downloads come from the speech service.
 */
export function AudioSection({ inCall: forceInCall }: { inCall?: boolean }) {
  const values = useSettings();
  const session = useCallSession();
  const inCall = forceInCall || session.status === "live";
  const microphone = useInputLevel("microphone");
  const system = useInputLevel("system");
  const inputs = useAudioInputs(microphone.retry);
  const { screenAudio } = usePermissionsSetup();
  const nextSignal = useAbortSignal();
  const [soundCheck, setSoundCheck] = useState<SoundCheckState>({
    status: "idle",
  });

  const missing = useMemo(
    () => missingMicrophone(inputs, values.microphone),
    [inputs, values.microphone]
  );
  const isMissing = missing !== null;

  useEffect(() => {
    setMicrophoneMissing(isMissing);
  }, [isMissing]);

  useEffect(() => {
    loadPermissions();
  }, []);

  const takeDefaultMic = useCallback(() => {
    updateSetting("microphone", SYSTEM_MICROPHONE);
  }, []);

  const startSoundCheck = useCallback(async () => {
    setSoundCheck({ status: "running" });
    try {
      const text = await runSoundCheck(nextSignal());
      setSoundCheck({ status: "done", text });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setSoundCheck({
        message:
          error instanceof Error ? error.message : "Проверка звука не удалась",
        status: "failed",
      });
    }
  }, [nextSignal]);

  const models = useSpeechModels();
  const selected = models?.find((model) => model.selected);
  const [checkRunning, setCheckRunning] = useState(false);
  // A check run here shows before the stored one comes back.
  const [checked, setChecked] = useState<
    Partial<Record<ModelId, StoredBenchmark>>
  >({});
  const recheck = useCallback(async () => {
    if (!selected) {
      return;
    }
    setCheckRunning(true);
    const result = await runBenchmark(selected.id);
    setCheckRunning(false);
    if (result) {
      setChecked((current) => ({ ...current, [selected.id]: result }));
    }
  }, [selected]);
  const benchmark = {
    result: selected
      ? (checked[selected.id] ?? values.speechBenchmark[selected.id])
      : undefined,
    running: checkRunning,
  };

  return (
    <AudioSettings
      benchmark={benchmark}
      inCall={inCall}
      levels={{ microphone: microphone.state, system: system.state }}
      microphones={inputs?.devices ?? []}
      missing={missing}
      modelActions={MODEL_ACTIONS}
      models={models ?? []}
      onChange={updateSetting}
      onRecheck={recheck}
      onSelectModel={selectModel}
      onSoundCheck={startSoundCheck}
      onUseDefaultMic={takeDefaultMic}
      soundCheck={soundCheck}
      systemAccess={screenAudio}
      values={values}
    />
  );
}
