"use client";

import { useCallback, useState } from "react";

import { toast } from "@/components/ui/toast";
import { updateSetting, useSettings } from "@/data/settings";

import { revealInFinder } from "../api";
import { RecordingsFolderDialog } from "../dialogs/recordings-folder-dialog";
import { GeneralSettings } from "../screens/general-settings";

/** Settings → Общие in the app: bound controls and the folder dialog. */
export function GeneralSection() {
  const values = useSettings();
  const [folderOpen, setFolderOpen] = useState(false);
  const openFolderDialog = useCallback(() => setFolderOpen(true), []);

  const showInFinder = useCallback(async () => {
    await revealInFinder(values.recordingsFolder);
    toast.add({
      description: values.recordingsFolder,
      title: "Папка открыта в Finder",
      type: "info",
    });
  }, [values.recordingsFolder]);

  return (
    <>
      <GeneralSettings
        onChange={updateSetting}
        onChangeFolder={openFolderDialog}
        onShowInFinder={showInFinder}
        values={values}
      />
      <RecordingsFolderDialog
        current={values.recordingsFolder}
        onOpenChange={setFolderOpen}
        open={folderOpen}
      />
    </>
  );
}
