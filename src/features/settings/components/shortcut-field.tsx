"use client";

import { useCallback } from "react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/*
 * Global shortcut field: a 200x36 bordered box with the keys as 24px gray
 * caps. Clicking it starts recording: the field takes the focus look, held
 * modifiers show at once and an orange caret waits for the main key.
 */
export function ShortcutField({
  className,
  keys,
  label,
  onClick,
  recording = false,
}: {
  className?: string;
  keys: string[];
  /** Action name, for the accessible label. */
  label: string;
  onClick?: () => void;
  recording?: boolean;
}) {
  const empty = keys.length === 0 && !recording;
  return (
    <button
      aria-label={`${label}: ${empty ? "не задано" : keys.join(" ")}. Изменить сочетание`}
      aria-pressed={recording}
      className={cn(
        "bg-background focus-visible:field-focus flex h-9 w-50 items-center gap-1 rounded-sm border px-2 transition-[border-color,box-shadow]",
        recording
          ? "field-focus border-foreground"
          : "border-border-strong hover:border-subtle",
        className
      )}
      onClick={onClick}
      type="button"
    >
      {empty ? (
        <span className="text-muted-foreground px-1 text-sm">Не задано</span>
      ) : null}
      <KbdGroup>
        {keys.map((key) => (
          <Kbd
            className="text-foreground h-6 min-w-6 px-1.5 shadow-none"
            key={key}
          >
            {key}
          </Kbd>
        ))}
      </KbdGroup>
      {recording ? (
        <>
          <span
            aria-hidden="true"
            className="bg-accent h-4 w-[1.5px] shrink-0 rounded-[1px]"
          />
          <span className="text-muted-foreground pl-0.5 text-sm">клавиша…</span>
        </>
      ) : null}
    </button>
  );
}

/** Action name left, its ShortcutField right; the hint shows while recording. */
export function ShortcutRow({
  className,
  id,
  keys,
  label,
  onRecord,
  recording = false,
}: {
  className?: string;
  /** Action id, passed to `onRecord`. */
  id?: string;
  keys: string[];
  label: string;
  /** Click on the field: start (or stop) recording this shortcut. */
  onRecord?: (id: string) => void;
  recording?: boolean;
}) {
  const handleClick = useCallback(() => {
    if (id) {
      onRecord?.(id);
    }
  }, [id, onRecord]);
  return (
    <div
      className={cn(
        "border-border flex gap-6 border-b py-3 last:border-b-0",
        recording ? "items-start" : "items-center",
        className
      )}
    >
      <p className={cn("min-w-0 flex-1 text-base", recording && "pt-2")}>
        {label}
      </p>
      <div className="flex w-50 shrink-0 flex-col items-end gap-1.5">
        <ShortcutField
          keys={keys}
          label={label}
          onClick={onRecord ? handleClick : undefined}
          recording={recording}
        />
        {recording ? (
          <p aria-live="polite" className="text-muted-foreground text-xs">
            Нажмите сочетание, Esc отменит
          </p>
        ) : null}
      </div>
    </div>
  );
}
