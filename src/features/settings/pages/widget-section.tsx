"use client";

import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/ui/toast";
import {
  getSettings,
  resetShortcuts,
  setShortcut,
  updateSetting,
  useSettings,
} from "@/data/settings";

import { SHORTCUTS } from "../mock";
import { WidgetSettings } from "../screens/widget-settings";
import {
  heldModifiers,
  isModifierKey,
  mainKeyLabel,
  sameKeys,
} from "../shortcut-keys";
import { showUndoToast } from "../toasts";

/*
 * Recording a global shortcut: a click on a field starts it, held modifiers
 * show at once, the first other key with at least one modifier saves the
 * shortcut. Esc or a click elsewhere cancels, Backspace without modifiers
 * clears the shortcut. A combination taken by another action is refused.
 */
function useShortcutRecorder(initial?: string) {
  const [recording, setRecording] = useState(initial);
  const [held, setHeld] = useState<string[]>([]);

  const stop = useCallback(() => {
    setRecording(undefined);
    setHeld([]);
  }, []);

  const toggle = useCallback((id: string) => {
    setHeld([]);
    setRecording((current) => (current === id ? undefined : id));
  }, []);

  useEffect(() => {
    if (!recording) {
      return;
    }

    const save = (keys: string[]) => {
      const taken = SHORTCUTS.find(
        (shortcut) =>
          shortcut.id !== recording &&
          sameKeys(getSettings().shortcuts[shortcut.id] ?? [], keys)
      );
      if (taken) {
        setHeld([]);
        toast.add({
          description: `Уже стоит на «${taken.label}»`,
          title: `${keys.join(" ")} занято`,
          type: "error",
        });
        return;
      }
      setShortcut(recording, keys);
      stop();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const modifiers = heldModifiers(event);
      if (event.key === "Escape") {
        stop();
        return;
      }
      if (isModifierKey(event)) {
        setHeld(modifiers);
        return;
      }
      if (modifiers.length === 0) {
        if (event.key === "Backspace") {
          setShortcut(recording, []);
          stop();
        }
        // A global shortcut needs a modifier: keep waiting.
        return;
      }
      save([...modifiers, mainKeyLabel(event)]);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      setHeld(heldModifiers(event));
    };

    const onPointerDown = (event: PointerEvent) => {
      const field =
        event.target instanceof Element
          ? event.target.closest("[aria-pressed='true']")
          : null;
      if (!field) {
        stop();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [recording, stop]);

  return { held, recording, toggle };
}

/**
 * Settings → Виджет и клавиши in the app. `recordingDemo` starts with that
 * shortcut being recorded (?demo=recording).
 */
export function WidgetSection({ recordingDemo }: { recordingDemo?: string }) {
  const values = useSettings();
  const { held, recording, toggle } = useShortcutRecorder(recordingDemo);

  const resetAll = useCallback(() => {
    const previous = resetShortcuts();
    showUndoToast("Сочетания сброшены", () => {
      updateSetting("shortcuts", previous);
    });
  }, []);

  return (
    <WidgetSettings
      heldKeys={held}
      onChange={updateSetting}
      onRecord={toggle}
      onResetShortcuts={resetAll}
      recording={recording}
      values={values}
    />
  );
}
