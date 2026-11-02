import type { ComponentProps, MouseEvent, ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { NavItemLabel } from "@/components/ui/nav-item";
import { SidebarItem } from "@/features/shell/app-sidebar";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { SmallPlusIcon, StepCheckIcon, WorkingRingIcon } from "../icons";

/*
 * New project wizard inside the main panel: the 280px step rail on the
 * left, the step's form (600px column) and a 72px footer with the actions.
 *
 *   <WizardLayout steps={<WizardSteps …/>} footer={<WizardFooter …/>}>
 *     <WizardForm>…</WizardForm>
 *   </WizardLayout>
 */
export function WizardLayout({
  children,
  className,
  footer,
  steps,
}: {
  children: ReactNode;
  className?: string;
  footer: ReactNode;
  steps: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex min-h-0 flex-1">
        {steps}
        {children}
      </div>
      {footer}
    </div>
  );
}

export type WizardStepState = "done" | "current" | "working" | "pending";

export interface WizardStepEntry {
  description: string;
  id: string;
  state: WizardStepState;
  title: string;
}

/**
 * The step rail. Finished steps are buttons that lead back to them;
 * `onStepClick` reads the step id from `data-step`.
 */
export function WizardSteps({
  className,
  label = "Новый проект",
  onStepClick,
  steps,
}: {
  className?: string;
  label?: string;
  onStepClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  steps: WizardStepEntry[];
}) {
  return (
    <nav
      aria-label="Шаги нового проекта"
      className={cn(
        "border-border flex w-70 shrink-0 flex-col gap-1 border-r px-6 py-10",
        className
      )}
    >
      <p className="text-muted-foreground px-3 pb-3 text-xs">{label}</p>
      <ol className="flex flex-col gap-1">
        {steps.map((step, index) => (
          <li key={step.id}>
            <WizardStep
              description={step.description}
              id={step.id}
              number={index + 1}
              onClick={onStepClick}
              state={step.state}
              title={step.title}
            />
          </li>
        ))}
      </ol>
    </nav>
  );
}

const STEP_STATE_LABEL: Record<WizardStepState, string> = {
  current: "текущий шаг",
  done: "готово",
  pending: "впереди",
  working: "идёт",
};

export function WizardStep({
  className,
  description,
  id,
  number,
  onClick,
  state,
  title,
}: {
  className?: string;
  description: string;
  id?: string;
  number: number;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  state: WizardStepState;
  title: string;
}) {
  const isActive = state === "current" || state === "working";
  const content = (
    <>
      <WizardStepMark number={number} state={state} />
      <span className="flex min-w-0 flex-col gap-0.5 text-left">
        <span
          className={cn(
            "text-base",
            isActive && "text-foreground font-medium",
            state === "done" && "text-foreground",
            state === "pending" && "text-muted-foreground"
          )}
        >
          {title}
        </span>
        <span className="text-muted-foreground text-xs">{description}</span>
        <span className="sr-only">, {STEP_STATE_LABEL[state]}</span>
      </span>
    </>
  );
  const rowClassName = cn(
    "flex w-full gap-3 rounded-sm px-3 py-2.5",
    isActive && "bg-surface",
    className
  );

  if (state === "done") {
    return (
      <button
        className={cn(
          rowClassName,
          "hover:bg-surface focus-visible:focus-ring transition-colors"
        )}
        data-step={id}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }
  return (
    <div aria-current={isActive ? "step" : undefined} className={rowClassName}>
      {content}
    </div>
  );
}

function WizardStepMark({
  number,
  state,
}: {
  number: number;
  state: WizardStepState;
}) {
  if (state === "done") {
    return (
      <span className="bg-confirmed-soft text-confirmed flex size-6 shrink-0 items-center justify-center rounded-full">
        <StepCheckIcon className="size-3" />
      </span>
    );
  }
  if (state === "working") {
    return (
      <span className="bg-background flex size-6 shrink-0 items-center justify-center rounded-full">
        <WorkingRingIcon className="size-[18px] motion-safe:animate-spin" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs",
        state === "current"
          ? "bg-foreground text-on-ink"
          : "bg-surface text-muted-foreground"
      )}
    >
      {number}
    </span>
  );
}

/** The form column: 80px sides, 48px top, 28px between blocks. Scrolls when a step is taller than the window. */
export function WizardForm({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col gap-7 overflow-y-auto px-20 pt-12 pb-14 *:w-[600px] *:shrink-0",
        className
      )}
      {...props}
    />
  );
}

export function WizardHeading({
  className,
  description,
  title,
}: {
  className?: string;
  description: ReactNode;
  title: ReactNode;
}) {
  return (
    <header className={cn("flex flex-col gap-2", className)}>
      <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
        {title}
      </h1>
      <p className="text-muted-foreground text-lg">{description}</p>
    </header>
  );
}

/** 72px footer: a text action on the left, the step buttons on the right. */
export function WizardFooter({
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
        "border-border flex h-18 shrink-0 items-center justify-between border-t pr-6 pl-8",
        className
      )}
    >
      <div className="flex items-center">{start}</div>
      <div className="flex items-center gap-2">{end}</div>
    </footer>
  );
}

/** Text action of the footer: "Отмена", "Остановить", "На главную". */
export function WizardTextAction({ className, ...props }: ButtonProps) {
  return (
    <Button
      className={cn("-mx-3 h-9 px-3 text-base font-normal", className)}
      variant="ghost"
      {...props}
    />
  );
}

/** 36px footer button. `hint` is the mono shortcut after the label. */
export function WizardButton({
  children,
  className,
  hint,
  variant = "default",
  ...props
}: ButtonProps & { hint?: string }) {
  return (
    <Button className={cn("h-9 px-4", className)} variant={variant} {...props}>
      {children}
      {hint ? (
        <span
          aria-hidden="true"
          className={cn(
            "font-mono text-xs font-normal",
            variant === "default" ? "text-on-ink/55" : "text-muted-foreground"
          )}
        >
          {hint}
        </span>
      ) : null}
    </Button>
  );
}

/** The draft "Новый проект" in the sidebar while the wizard is open. */
export function DraftProjectNavItem({
  className,
  label = "Новый проект",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <SidebarItem active className={className} href={routes.newProject()}>
      <span
        aria-hidden="true"
        className="border-border-strong text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-xs border border-dashed"
      >
        <SmallPlusIcon className="size-2.5" />
      </span>
      <NavItemLabel>{label}</NavItemLabel>
    </SidebarItem>
  );
}
