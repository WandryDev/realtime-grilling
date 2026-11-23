"use client";

import { AppWindow, AppWindowBody, AppWindowPanel } from "@grill/ui/app-window";
import {
  WindowControl,
  WindowControlGroup,
  WindowTitlebar,
} from "@grill/ui/window-titlebar";
import type { ComponentProps, ReactNode } from "react";
import {
  useWindowActions,
  WindowChromeStart,
} from "@/features/shell/window-chrome";
import { useWindowChrome } from "@/lib/platform";
import { cn } from "@/lib/utils";

/*
 * Onboarding window, 960×700 (560×520 at least): the step list in the title
 * bar, a white panel with a 520px column and a footer with the step's
 * actions. The column narrows with the window and scrolls when the window is
 * too short; the footer stays put.
 *
 *   <OnboardingWindow step="integrations">
 *     <OnboardingContent>…</OnboardingContent>
 *     <OnboardingFooter start={<OnboardingBackButton />} end={<OnboardingNextButton />} />
 *   </OnboardingWindow>
 *
 * `platform="windows"` swaps the traffic lights for the Windows chrome; in
 * Tauri on Windows it is always on, and its buttons work.
 *
 *   <OnboardingWindow platform="windows" step="permissions">…
 *   </OnboardingWindow>
 */

export const ONBOARDING_STEPS = [
  { id: "welcome", label: "Знакомство" },
  { id: "permissions", label: "Разрешения" },
  { id: "speech", label: "Речь" },
  { id: "agent", label: "Агент" },
  { id: "integrations", label: "Интеграции" },
  { id: "done", label: "Готово" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

type StepState = "done" | "current" | "pending";

function StepMark({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <svg
        aria-hidden="true"
        className="text-confirmed size-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.6}
        viewBox="0 0 14 14"
      >
        <path d="M3 7.3l2.6 2.5L11 4.4" />
      </svg>
    );
  }
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "current" ? "bg-accent" : "bg-border-strong"
        )}
      />
    </span>
  );
}

/*
 * Below this window width the steps keep their marks and only the current
 * label (the others stay for screen readers). Windows needs more room: its
 * system buttons take 138px on the right.
 */
const COMPACT_STEPS = {
  macos: {
    label: "@max-[48rem]/window:sr-only",
    list: "@max-[48rem]/window:gap-3",
  },
  windows: {
    label: "@max-[52rem]/window:sr-only",
    list: "@max-[52rem]/window:gap-3",
  },
} as const;

export function OnboardingSteps({
  current,
  platform = "macos",
}: {
  current: OnboardingStepId;
  platform?: "macos" | "windows";
}) {
  const compact = COMPACT_STEPS[platform];
  const currentIndex = ONBOARDING_STEPS.findIndex(
    (step) => step.id === current
  );

  return (
    <ol
      aria-label="Шаги настройки"
      className={cn("flex shrink-0 items-center gap-5", compact.list)}
    >
      {ONBOARDING_STEPS.map((step, index) => {
        let state: StepState = "pending";
        if (index < currentIndex) {
          state = "done";
        } else if (index === currentIndex) {
          state = "current";
        }
        return (
          <li
            aria-current={state === "current" ? "step" : undefined}
            className="flex items-center gap-1.5"
            key={step.id}
          >
            <StepMark state={state} />
            <span
              className={cn(
                "text-sm whitespace-nowrap",
                state === "current"
                  ? "text-foreground font-medium"
                  : cn("text-muted-foreground", compact.label)
              )}
            >
              {step.label}
              {state === "done" ? (
                <span className="sr-only">, готово</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/*
 * Side columns of the title bar share the free room equally, so the steps
 * stay centered; on a narrow window they shrink to what they hold.
 */
const TITLEBAR_SIDE = "flex-1 basis-0";

/*
 * Windows chrome: the app tile on the left, the system
 * buttons (46×32) pinned to the top right corner. The steps stay centered
 * between the side columns, as on macOS; the right one keeps room for the
 * system buttons.
 */
function WindowsTitlebarContent({ step }: { step: OnboardingStepId }) {
  const actions = useWindowActions();
  return (
    <>
      <div className={cn(TITLEBAR_SIDE, "flex min-w-8 items-center")}>
        <span
          aria-hidden="true"
          className="bg-foreground size-4 rounded-[5px]"
        />
      </div>
      <OnboardingSteps current={step} platform="windows" />
      <div className={cn(TITLEBAR_SIDE, "min-w-36")} />
      <WindowControlGroup className="absolute top-0 right-0 h-8">
        <WindowControl
          className="h-8"
          control="minimize"
          onClick={actions.minimize}
        />
        <WindowControl
          className="h-8"
          control="maximize"
          onClick={actions.toggleMaximize}
        />
        <WindowControl
          className="h-8"
          control="close"
          onClick={actions.close}
        />
      </WindowControlGroup>
    </>
  );
}

export function OnboardingWindow({
  children,
  className,
  overlay,
  platform = "macos",
  step,
}: {
  children: ReactNode;
  className?: string;
  /** System prompts and dialogs over the window, positioned by the caller. */
  overlay?: ReactNode;
  /** Window chrome: traffic lights on macOS, system buttons on Windows. */
  platform?: "macos" | "windows";
  step: OnboardingStepId;
}) {
  const chrome = useWindowChrome();
  const windows = platform === "windows" || chrome === "windows";
  return (
    <AppWindow className={cn("relative", className)}>
      <WindowTitlebar className="relative has-data-[slot=window-controls]:pr-5">
        {windows ? (
          <WindowsTitlebarContent step={step} />
        ) : (
          <>
            <div className={cn(TITLEBAR_SIDE, "min-w-14")}>
              <WindowChromeStart />
            </div>
            <OnboardingSteps current={step} />
            <div className={TITLEBAR_SIDE} />
          </>
        )}
      </WindowTitlebar>
      <AppWindowBody>
        <AppWindowPanel className="items-center">{children}</AppWindowPanel>
      </AppWindowBody>
      {overlay}
    </AppWindow>
  );
}

/*
 * The 520px column, centered vertically above the footer. The whole panel
 * width scrolls (the scrollbar sits at the panel edge, not by the text);
 * auto margins center the column and drop to zero once it is taller than the
 * room, so its top never ends up out of reach.
 */
export function OnboardingContent({
  className,
  ...props
}: ComponentProps<"main">) {
  return (
    <div className="rounded-t-panel flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-6 py-6">
      <main
        className={cn(
          "mx-auto my-auto flex w-full max-w-[520px] flex-col gap-8",
          className
        )}
        {...props}
      />
    </div>
  );
}

/** 88px footer: secondary action on the left, the main one on the right. */
export function OnboardingFooter({
  className,
  end,
  start,
}: {
  className?: string;
  end?: ReactNode;
  start?: ReactNode;
}) {
  return (
    <footer
      className={cn(
        "flex h-22 w-full max-w-[568px] shrink-0 items-center justify-between gap-3 px-6",
        className
      )}
    >
      <div className="flex items-center gap-2">{start}</div>
      <div className="flex items-center gap-2">{end}</div>
    </footer>
  );
}
