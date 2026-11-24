"use client";

import { toast } from "@grill/ui/toast";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { DataSummary } from "@/bindings";
import { discardCall } from "@/data/call-session";
import { deleteCallsWithoutProject } from "@/data/calls";
import { resetIntegrations } from "@/data/integrations";
import { resetOnboarding } from "@/data/onboarding";
import { deleteProject, getProjects } from "@/data/projects";
import { updateSetting, useSettings } from "@/data/settings";
import { inTauri } from "@/effect/runtime";
import { routes } from "@/lib/routes";

import { isAbortError, readDataSummary } from "../api";
import { DeleteAllDataDialog } from "../dialogs/privacy-dialogs";
import { dataSummaryText } from "../format";
import { PrivacySettings } from "../screens/privacy-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/*
 * MOCK: the browser demo has no Rust to delete everything, so the stores
 * do it: a call in progress goes first, without a summary, then the data.
 * In the app `data_delete_all` did all of it and shows onboarding itself.
 */
async function wipeDemoData() {
  await discardCall();
  for (const project of getProjects()) {
    deleteProject(project.id);
  }
  deleteCallsWithoutProject();
  resetIntegrations();
  resetOnboarding();
}

/**
 * Settings → Приватность и хранение in the app: the retention periods Rust
 * enforces, and «Очистить всё» with the real summary (`data_summary`),
 * which deletes everything and starts the setup again.
 */
export function PrivacySection() {
  const router = useRouter();
  const values = useSettings();
  const nextSignal = useAbortSignal();
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const openDelete = useCallback(() => setDeleteOpen(true), []);

  useEffect(() => {
    readDataSummary(nextSignal()).then(setSummary, (error: unknown) => {
      if (!isAbortError(error)) {
        showErrorToast("Не получилось посчитать данные", error);
      }
    });
  }, [nextSignal]);

  const handleDeleted = useCallback(
    async (warning?: string) => {
      if (!inTauri) {
        await wipeDemoData();
      }
      setDeleteOpen(false);
      toast.add(
        warning
          ? {
              description: warning,
              title: "Всё удалено, но не до конца",
              type: "warning",
            }
          : {
              description: "Grill начнёт с первой настройки",
              title: "Всё удалено",
              type: "success",
            }
      );
      // In the app Rust hid this window and opened onboarding.
      router.push(inTauri ? routes.home() : routes.onboarding());
    },
    [router]
  );

  return (
    <>
      <PrivacySettings
        onChange={updateSetting}
        onDeleteAll={openDelete}
        summary={summary}
        values={values}
      />
      <DeleteAllDataDialog
        onDeleted={handleDeleted}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        summary={summary ? dataSummaryText(summary) : "Все проекты и звонки"}
      />
    </>
  );
}
