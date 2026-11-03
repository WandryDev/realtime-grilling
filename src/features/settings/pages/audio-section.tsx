"use client";

import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/ui/toast";
import { useCallSession } from "@/data/call-session";
import {
  type StoredBenchmark,
  setMicrophoneMissing,
  updateSetting,
  useMicrophoneMissing,
  useSettings,
} from "@/data/settings";
import {
  downloadModel,
  type ModelId,
  redownloadModel,
  removeModel,
  runBenchmark,
  selectModel,
  useSpeechModels,
} from "@/features/speech/api";

import { isAbortError, runSoundCheck, subscribeInputLevel } from "../api";
import {
  AudioSettings,
  type SoundCheckState,
  type SpeechModelActions,
} from "../screens/audio-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

const BUILT_IN_MICROPHONE = "macbook";

const MODEL_ACTIONS: SpeechModelActions = {
  onDownload: downloadModel,
  onRedownload: redownloadModel,
  onRemove: removeModel,
};

/** Live levels of both channels while the section is open. */
function useInputLevels() {
  const [levels, setLevels] = useState({ microphone: 0, system: 0 });

  useEffect(() => {
    const stopMicrophone = subscribeInputLevel("microphone", (level) =>
      setLevels((current) => ({ ...current, microphone: level }))
    );
    const stopSystem = subscribeInputLevel("system", (level) =>
      setLevels((current) => ({ ...current, system: level }))
    );
    return () => {
      stopMicrophone();
      stopSystem();
    };
  }, []);

  return levels;
}

/**
 * Settings → Звук и распознавание in the app. `inCall` locks devices and
 * the model (a live call, or ?demo=in-call); the backend refuses to change
 * the selected model while recording anyway (a toast says so). The models
 * and their downloads come from the speech service.
 */
export function AudioSection({ inCall: forceInCall }: { inCall?: boolean }) {
  const values = useSettings();
  const micMissing = useMicrophoneMissing();
  const session = useCallSession();
  const inCall = forceInCall || session.status === "live";
  const levels = useInputLevels();
  const nextSignal = useAbortSignal();
  const [soundCheck, setSoundCheck] = useState<SoundCheckState>({
    status: "idle",
  });

  const switchToBuiltInMic = useCallback(() => {
    updateSetting("microphone", BUILT_IN_MICROPHONE);
    setMicrophoneMissing(false);
    toast.add({ title: "Микрофон MacBook подключён", type: "success" });
  }, []);

  const pickMicrophone = useCallback((value: string) => {
    if (value === "missing") {
      return;
    }
    updateSetting("microphone", value);
    setMicrophoneMissing(false);
  }, []);

  const startSoundCheck = useCallback(async () => {
    setSoundCheck({ status: "running" });
    try {
      const result = await runSoundCheck(nextSignal());
      setSoundCheck({ status: "done", ...result });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setSoundCheck({ status: "idle" });
      showErrorToast("Проверка звука не удалась", error);
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
      levels={levels}
      microphone={micMissing ? "disabled" : "ok"}
      modelActions={MODEL_ACTIONS}
      models={models ?? []}
      onChange={updateSetting}
      onPickMicrophone={pickMicrophone}
      onRecheck={recheck}
      onSelectModel={selectModel}
      onSoundCheck={startSoundCheck}
      onUseBuiltInMic={switchToBuiltInMic}
      soundCheck={soundCheck}
      values={values}
    />
  );
}
