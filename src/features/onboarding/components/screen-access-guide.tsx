import { ZoomIcon } from "@grill/ui/brand-icons";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * "Как включить за минуту": what to do after macOS denied screen and system
 * audio recording. Numbered steps and the actions on the left, a small
 * picture of the macOS settings list on the right with Grill's switch
 * highlighted.
 */
export function ScreenAccessGuide({
  actions,
  className,
  steps,
  title = "Как включить за минуту",
}: {
  actions: ReactNode;
  className?: string;
  steps: readonly string[];
  title?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("bg-surface flex gap-4 rounded-md p-4", className)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <ol className="flex flex-col gap-2.5">
          {steps.map((step, index) => (
            <li className="flex gap-2 text-sm" key={step}>
              <span className="text-muted-foreground w-4 shrink-0 text-xs/[18px]">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <div className="flex gap-2 pt-1.5">{actions}</div>
      </div>
      <SettingsPreview />
    </section>
  );
}

function PreviewSwitch({
  on,
  highlight,
}: {
  highlight?: boolean;
  on: boolean;
}) {
  return (
    <span
      className={cn(
        "flex h-4 w-[26px] shrink-0 rounded-full p-0.5",
        on ? "bg-foreground justify-end" : "bg-border-strong",
        highlight && "shadow-[0_0_0_2px_var(--color-accent)]"
      )}
    >
      <span className="bg-background size-3 rounded-full" />
    </span>
  );
}

/* Decorative: the macOS "Запись экрана и звука" list, Grill still off. */
function SettingsPreview() {
  return (
    <div
      aria-hidden="true"
      className="bg-background shadow-card flex w-[180px] shrink-0 flex-col gap-0.5 self-start rounded-sm p-2.5"
    >
      <p className="px-1 pt-0.5 pb-1.5 text-xs font-semibold">
        Запись экрана и звука
      </p>
      <div className="flex items-center gap-2 px-1 py-1.5">
        <span className="bg-background ring-foreground/6 flex size-3.5 shrink-0 items-center justify-center rounded-[4px] ring-1">
          <ZoomIcon className="size-3" />
        </span>
        <span className="text-muted-foreground flex-1 text-xs">zoom.us</span>
        <PreviewSwitch on />
      </div>
      <div className="bg-accent-soft flex items-center gap-2 rounded-xs px-1 py-1.5">
        <span className="bg-foreground size-3.5 shrink-0 rounded-[4px]" />
        <span className="flex-1 text-xs font-medium">Grill</span>
        <PreviewSwitch highlight on={false} />
      </div>
    </div>
  );
}
