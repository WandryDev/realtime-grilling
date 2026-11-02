import type { ReactNode } from "react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GrillAppIcon } from "./grill-app-icon";

/*
 * The macOS permission alert as it appears over the Grill window: a 272px
 * gray card with the app icon, the system question, our usage string and
 * two equal buttons. Drawn by the system in the real app; here it is a
 * picture for the "запрос macOS" state, placed by the caller; the app
 * wires `onAllow` / `onDeny` to simulate the answer.
 */
export function MacPermissionPrompt({
  allowLabel = "Разрешить",
  className,
  denyLabel = "Не разрешать",
  description,
  onAllow,
  onDeny,
  title,
}: {
  allowLabel?: string;
  className?: string;
  denyLabel?: string;
  description: ReactNode;
  /** The app simulates the system answer with these. */
  onAllow?: () => void;
  onDeny?: () => void;
  title: ReactNode;
}) {
  const titleId = useId();

  return (
    <div
      aria-labelledby={titleId}
      className={cn(
        "bg-surface shadow-float flex w-[272px] flex-col items-center gap-3 rounded-lg px-4 pt-5 pb-4",
        className
      )}
      role="dialog"
    >
      <GrillAppIcon />
      <div className="flex flex-col items-center gap-1.5 text-center">
        <p className="text-sm font-semibold" id={titleId}>
          {title}
        </p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <div className="flex w-full gap-2 pt-1">
        <Button
          className="bg-border hover:bg-border-strong h-[30px] flex-1"
          onClick={onDeny}
          variant="secondary"
        >
          {denyLabel}
        </Button>
        <Button className="h-[30px] flex-1" onClick={onAllow}>
          {allowLabel}
        </Button>
      </div>
    </div>
  );
}
