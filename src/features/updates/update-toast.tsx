"use client";

import { useEffect, useRef } from "react";

import { toast } from "@/components/ui/toast";

import { installUpdate, useUpdateStatus } from "./api";

/** «Перезапустить» in the toast and in Settings → Общие. */
export async function restartToUpdate() {
  try {
    await installUpdate();
  } catch (error) {
    toast.add({
      description: error instanceof Error ? error.message : undefined,
      title: "Не получилось обновить Grill",
      type: "error",
    });
  }
}

/**
 * The main window's note that an update is downloaded: once per version,
 * until it is closed. Nothing installs without «Перезапустить».
 */
export function UpdateToast() {
  const status = useUpdateStatus();
  const shown = useRef<string | null>(null);
  const ready = status?.state.status === "ready" ? status.state.version : null;

  useEffect(() => {
    if (!ready || shown.current === ready) {
      return;
    }
    shown.current = ready;
    toast.add({
      actionProps: { children: "Перезапустить", onClick: restartToUpdate },
      description: "Перезапустите Grill, чтобы установить её",
      timeout: 0,
      title: `Готова версия ${ready}`,
      type: "info",
    });
  }, [ready]);

  return null;
}
