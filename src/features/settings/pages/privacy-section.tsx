"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { toast } from "@/components/ui/toast";
import { discardCall } from "@/data/call-session";
import { deleteCallsWithoutProject } from "@/data/calls";
import { resetIntegrations } from "@/data/integrations";
import { resetOnboarding } from "@/data/onboarding";
import { deleteProject, getProjects } from "@/data/projects";
import { updateSetting, useSettings } from "@/data/settings";
import { routes } from "@/lib/routes";

import {
  DeleteAllDataDialog,
  ExportDataDialog,
} from "../dialogs/privacy-dialogs";
import { PrivacySettings } from "../screens/privacy-settings";

/**
 * Settings → Приватность и хранение in the app: retention selects, export,
 * and "Очистить всё", which ends the call in progress, wipes the data and
 * starts the setup again.
 */
export function PrivacySection() {
  const router = useRouter();
  const values = useSettings();
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const openExport = useCallback(() => setExportOpen(true), []);
  const openDelete = useCallback(() => setDeleteOpen(true), []);

  const handleDeleted = useCallback(async () => {
    // A call in progress goes first, without a summary: its recording
    // stops before its data goes, and no window keeps showing it.
    await discardCall();
    for (const project of getProjects()) {
      deleteProject(project.id);
    }
    deleteCallsWithoutProject();
    resetIntegrations();
    resetOnboarding();
    setDeleteOpen(false);
    toast.add({
      description: "Grill начнёт с первой настройки",
      title: "Всё удалено",
      type: "success",
    });
    router.push(routes.onboarding());
  }, [router]);

  return (
    <>
      <PrivacySettings
        onChange={updateSetting}
        onDeleteAll={openDelete}
        onExport={openExport}
        values={values}
      />
      <ExportDataDialog onOpenChange={setExportOpen} open={exportOpen} />
      <DeleteAllDataDialog
        onDeleted={handleDeleted}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
      />
    </>
  );
}
