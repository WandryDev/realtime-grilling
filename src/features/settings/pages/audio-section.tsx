"use client";

import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/ui/toast";
import { useCallSession } from "@/data/call-session";
import {
  getSettings,
  setMicrophoneMissing,
  updateSetting,
  updateSettings,
  useMicrophoneMissing,
  useSettings,
} from "@/data/settings";

import {
  downloadSpeechModel,
  isAbortError,
  runSoundCheck,
  subscribeInputLevel,
} from "../api";
import { SPEECH_MODELS } from "../mock";
import { AudioSettings, type SoundCheckState } from "../screens/audio-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

const BUILT_IN_MICROPHONE = "macbook";

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
 * the model (a live call, or ?demo=in-call).
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
  const [modelProgress, setModelProgress] = useState<Record<string, number>>(
    {}
  );

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

  const downloadModel = useCallback(
    async (id: string) => {
      const model = SPEECH_MODELS.find((item) => item.id === id);
      if (!model) {
        return;
      }
      const updating = getSettings().installedModels.includes(id);
      setModelProgress((current) => ({ ...current, [id]: 0 }));
      const clearProgress = () =>
        setModelProgress(({ [id]: _done, ...rest }) => rest);
      try {
        await downloadSpeechModel(
          id,
          (percent) =>
            setModelProgress((current) => ({ ...current, [id]: percent })),
          nextSignal()
        );
        const settings = getSettings();
        updateSettings({
          installedModels: [
            ...settings.installedModels.filter((item) => item !== id),
            id,
          ],
          modelUpdates: settings.modelUpdates.filter((item) => item !== id),
        });
        clearProgress();
        toast.add({
          description: updating ? undefined : "Её можно выбрать для звонков",
          title: updating ? `${model.name} обновлена` : `${model.name} скачана`,
          type: "success",
        });
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        clearProgress();
        showErrorToast(`Не получилось скачать ${model.name}`, error);
      }
    },
    [nextSignal]
  );

  return (
    <AudioSettings
      inCall={inCall}
      levels={levels}
      microphone={micMissing ? "disabled" : "ok"}
      modelProgress={modelProgress}
      onChange={updateSetting}
      onDownloadModel={downloadModel}
      onPickMicrophone={pickMicrophone}
      onSoundCheck={startSoundCheck}
      onUseBuiltInMic={switchToBuiltInMic}
      soundCheck={soundCheck}
      values={values}
    />
  );
}
