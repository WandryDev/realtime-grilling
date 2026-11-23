import { Button, type ButtonProps } from "@grill/ui/button";
import { NavItemLabel } from "@grill/ui/nav-item";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { SidebarItem } from "@/features/shell/app-sidebar";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { SmallPlusIcon, StepCheckIcon, WorkingRingIcon } from "../icons";

/*
 * New project wizard inside the main panel: the 280px step rail on the
 * left, the step's form (600px column) and a 72px footer with the actions.
 * On a narrower panel (`@4xl/panel`) the rail turns into a one-line step
 * indicator above the form, and the form takes the panel's width.
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
      <div className="flex min-h-0 flex-1 flex-col @4xl/panel:flex-row">
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
 * `onStepClick` reads the step id from `data-step`. In the narrow indicator
 * the steps line up in a row (scrolling sideways if they don't fit) and
 * their descriptions stay for screen readers only: the form's heading says
 * what the current step is about.
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
        "border-border flex shrink-0 flex-col gap-1 border-b px-3 py-2 @3xl/panel:px-9",
        "@4xl/panel:w-70 @4xl/panel:border-r @4xl/panel:border-b-0 @4xl/panel:px-6 @4xl/panel:py-10",
        className
      )}
    >
      <p className="text-muted-foreground px-3 pb-3 text-xs @max-4xl/panel:sr-only">
        {label}
      </p>
      <ol className="flex gap-1 overflow-x-auto @4xl/panel:flex-col @4xl/panel:overflow-visible">
        {steps.map((step, index) => (
          <li className="shrink-0" key={step.id}>
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
            "text-base whitespace-nowrap @4xl/panel:whitespace-normal",
            // The narrowest indicator names only the current step.
            !isActive && "@max-2xl/panel:sr-only",
            isActive && "text-foreground font-medium",
            state === "done" && "text-foreground",
            state === "pending" && "text-muted-foreground"
          )}
        >
          {title}
        </span>
        <span className="text-muted-foreground text-xs @max-4xl/panel:sr-only">
          {description}
        </span>
        <span className="sr-only">, {STEP_STATE_LABEL[state]}</span>
      </span>
    </>
  );
  const rowClassName = cn(
    "flex w-full items-center gap-2.5 rounded-sm px-3 py-2 @4xl/panel:items-start @4xl/panel:gap-3 @4xl/panel:py-2.5",
    isActive && "bg-surface",
    !isActive && "@max-2xl/panel:gap-0",
    className
  );
  // The step's name on hover where the narrow indicator shows only its mark.
  const hint = isActive ? undefined : title;

  if (state === "done") {
    return (
      <button
        className={cn(
          rowClassName,
          "hover:bg-surface focus-visible:focus-ring transition-colors"
        )}
        data-step={id}
        onClick={onClick}
        title={hint}
        type="button"
      >
        {content}
      </button>
    );
  }
  return (
    <div
      aria-current={isActive ? "step" : undefined}
      className={rowClassName}
      title={hint}
    >
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

/**
 * The form column: 80px sides, 48px top, 28px between blocks. Scrolls when
 * a step is taller than the window. Its blocks are 600 wide, or the
 * column's width on a narrow panel.
 */
export function WizardForm({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col gap-7 overflow-y-auto px-6 pt-12 pb-14 *:w-full *:max-w-[600px] *:shrink-0 @3xl/panel:px-12 @4xl/panel:pr-14 @4xl/panel:pl-20",
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
