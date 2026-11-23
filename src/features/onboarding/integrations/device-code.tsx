import { Button } from "@grill/ui/button";
import type { ReactNode } from "react";
import { CheckIcon } from "@/features/onboarding/components/icons";
import { cn } from "@/lib/utils";

import { CopyIcon } from "./icons";

/*
 * GitHub device code on a gray card: one white 36×48 tile per character in
 * mono 28/500, the dash between the halves in subtle gray, a white copy pill
 * on the right and a caption line under it.
 * - copied: the pill reads "Скопировано" with a green check
 * - idle: the pill offers "Скопировать" again
 * - expired: the characters fade, no pill, the caption turns red
 */
export type DeviceCodeStatus = "copied" | "idle" | "expired";

export function DeviceCodeCard({
  caption,
  className,
  code,
  onCopy,
  status,
  timer,
}: {
  caption: ReactNode;
  className?: string;
  code: string;
  /** The copy pill: puts the code on the clipboard again. */
  onCopy?: () => void;
  status: DeviceCodeStatus;
  /** Right side of the caption line: time left or how long ago it expired. */
  timer: ReactNode;
}) {
  const expired = status === "expired";

  return (
    <section
      aria-label="Код устройства"
      className={cn(
        "bg-surface flex flex-col gap-3.5 rounded-md p-5",
        className
      )}
    >
      {/* The copy pill drops under the code on a narrow window; no column gap, it fits in 520px only flush */}
      <div className="flex flex-wrap items-center justify-between gap-y-3">
        <p className={cn("flex items-center gap-1", expired && "opacity-35")}>
          <span className="sr-only">{code}</span>
          {[...code].map((char, index) =>
            char === "-" ? (
              <span
                aria-hidden="true"
                className="text-subtle w-4 shrink-0 text-center font-mono text-2xl"
                // biome-ignore lint/suspicious/noArrayIndexKey: characters repeat, the position is the identity
                key={index}
              >
                -
              </span>
            ) : (
              <span
                aria-hidden="true"
                className="bg-background flex h-12 w-9 shrink-0 items-center justify-center rounded-xs font-mono text-2xl font-medium"
                // biome-ignore lint/suspicious/noArrayIndexKey: characters repeat, the position is the identity
                key={index}
              >
                {char}
              </span>
            )
          )}
        </p>
        {expired ? null : (
          <Button
            className="bg-background hover:bg-background/70 active:bg-background/50 h-9 gap-1.5"
            onClick={onCopy}
            variant="secondary"
          >
            {status === "copied" ? (
              <CheckIcon
                className="text-confirmed size-3.5"
                strokeWidth={1.75}
              />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
            {status === "copied" ? "Скопировано" : "Скопировать"}
          </Button>
        )}
      </div>
      <div className="flex justify-between gap-4 text-sm">
        <p
          className={cn(
            expired ? "text-contradiction font-medium" : "text-muted-foreground"
          )}
        >
          {caption}
        </p>
        <p className="text-muted-foreground flex shrink-0 items-baseline gap-1">
          {timer}
        </p>
      </div>
    </section>
  );
}

/** "действует ещё 14:52", the time in mono. */
export function DeviceCodeTimer({ remaining }: { remaining: string }) {
  return (
    <>
      действует ещё{" "}
      <span className="font-mono text-xs tabular-nums">{remaining}</span>
    </>
  );
}
