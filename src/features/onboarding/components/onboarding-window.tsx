"use client";

import type { ComponentProps, ReactNode } from "react";

import {
  AppWindow,
  AppWindowBody,
  AppWindowPanel,
} from "@/components/ui/app-window";
import {
  WindowControl,
  WindowControlGroup,
  WindowTitlebar,
} from "@/components/ui/window-titlebar";
import {
  useWindowActions,
  WindowChromeStart,
} from "@/features/shell/window-chrome";
import { useWindowChrome } from "@/lib/platform";
import { cn } from "@/lib/utils";

/*
 * Onboarding window, 1080×720: the step list in the title bar, a white panel
 * with a 520px column and a footer with the step's actions.
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

export function OnboardingSteps({ current }: { current: OnboardingStepId }) {
  const currentIndex = ONBOARDING_STEPS.findIndex(
    (step) => step.id === current
  );

  return (
    <ol aria-label="Шаги настройки" className="flex items-center gap-5">
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
                "text-sm",
                state === "current"
                  ? "text-foreground font-medium"
                  : "text-muted-foreground"
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
 * Windows chrome: the app tile and the window name on the left, the system
 * buttons (46×32) pinned to the top right corner. The steps stay centered
 * between two 160px columns, as on macOS.
 */
function WindowsTitlebarContent({ step }: { step: OnboardingStepId }) {
  const actions = useWindowActions();
  return (
    <>
      <p className="text-muted-foreground flex w-40 shrink-0 items-center gap-2 text-sm">
        <span
          aria-hidden="true"
          className="bg-foreground size-4 rounded-[5px]"
        />
        Настройка Grill
      </p>
      <OnboardingSteps current={step} />
      <div className="w-40 shrink-0" />
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
            <div className="w-40 shrink-0">
              <WindowChromeStart />
            </div>
            <OnboardingSteps current={step} />
            <p className="text-muted-foreground w-40 shrink-0 text-right text-sm">
              Настройка Grill
            </p>
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

/** The 520px column, centered vertically above the footer. */
export function OnboardingContent({
  className,
  ...props
}: ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "flex min-h-0 w-[520px] flex-1 flex-col justify-center gap-8",
        className
      )}
      {...props}
    />
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
        "flex h-22 w-[520px] shrink-0 items-center justify-between",
        className
      )}
    >
      <div className="flex items-center gap-2">{start}</div>
      <div className="flex items-center gap-2">{end}</div>
    </footer>
  );
}
