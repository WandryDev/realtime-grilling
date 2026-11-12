"use client";

import { useCallback, useEffect, useState } from "react";

import type { RecordingsInfo } from "@/bindings";
import { updateSetting, useSettings } from "@/data/settings";
import { useRunsOnWindows } from "@/features/onboarding/platform";

import { isAbortError, readRecordingsInfo, revealInFinder } from "../api";
import { GeneralSettings } from "../screens/general-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/**
 * Settings → Общие in the app: bound controls and the recordings' folder
 * as Rust reports it (`recordings_info`), «Показать в Finder».
 */
export function GeneralSection() {
  const values = useSettings();
  const onWindows = useRunsOnWindows();
  const nextSignal = useAbortSignal();
  const [recordings, setRecordings] = useState<RecordingsInfo | null>(null);

  useEffect(() => {
    readRecordingsInfo(nextSignal()).then(setRecordings, (error: unknown) => {
      if (!isAbortError(error)) {
        showErrorToast("Не получилось прочитать папку записей", error);
      }
    });
  }, [nextSignal]);

  const showInFinder = useCallback(async () => {
    if (!recordings) {
      return;
    }
    try {
      await revealInFinder(recordings.path);
    } catch (error) {
      showErrorToast("Не получилось открыть папку", error);
    }
  }, [recordings]);

  return (
    <GeneralSettings
      onChange={updateSetting}
      onShowInFinder={showInFinder}
      recordings={recordings}
      revealLabel={onWindows ? "Показать в проводнике" : "Показать в Finder"}
      values={values}
    />
  );
}
