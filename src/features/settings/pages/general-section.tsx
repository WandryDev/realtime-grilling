"use client";

import { useCallback, useEffect, useState } from "react";

import type { RecordingsInfo } from "@/bindings";
import { updateSetting, useSettings } from "@/data/settings";
import { useRunsOnWindows } from "@/features/onboarding/platform";
import { checkForUpdates, useUpdateStatus } from "@/features/updates/api";
import { restartToUpdate } from "@/features/updates/update-toast";

import { isAbortError, readRecordingsInfo, revealInFinder } from "../api";
import { GeneralSettings } from "../screens/general-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/**
 * Settings → Общие in the app: bound controls and the recordings' folder
 * as Rust reports it (`recordings_info`), «Показать в Finder», the app's
 * version and its updates.
 */
export function GeneralSection() {
  const values = useSettings();
  const onWindows = useRunsOnWindows();
  const nextSignal = useAbortSignal();
  const [recordings, setRecordings] = useState<RecordingsInfo | null>(null);
  const updates = useUpdateStatus();

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

  const checkUpdates = useCallback(async () => {
    try {
      await checkForUpdates();
    } catch (error) {
      showErrorToast("Не получилось проверить обновления", error);
    }
  }, []);

  return (
    <GeneralSettings
      onChange={updateSetting}
      onCheckUpdates={checkUpdates}
      onRestartToUpdate={restartToUpdate}
      onShowInFinder={showInFinder}
      recordings={recordings}
      revealLabel={onWindows ? "Показать в проводнике" : "Показать в Finder"}
      updates={updates}
      values={values}
    />
  );
}
