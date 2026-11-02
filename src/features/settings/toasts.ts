"use client";

import { toast } from "@/components/ui/toast";

/** How long an undo toast stays: the token is still there until it goes. */
const UNDO_TIMEOUT_MS = 8000;

/** Success toast with "Вернуть", e.g. after disconnecting a service. */
export function showUndoToast(title: string, onUndo: () => void) {
  const id = toast.add({
    actionProps: {
      children: "Вернуть",
      onClick: () => {
        onUndo();
        toast.close(id);
      },
    },
    timeout: UNDO_TIMEOUT_MS,
    title,
    type: "success",
  });
  return id;
}

/** Error toast with the reason as the description. */
export function showErrorToast(title: string, error: unknown) {
  toast.add({
    description: error instanceof Error ? error.message : undefined,
    title,
    type: "error",
  });
}
