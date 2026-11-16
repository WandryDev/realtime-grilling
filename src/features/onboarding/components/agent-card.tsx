import type { ComponentProps, ReactNode } from "react";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CheckIcon, CrossIcon, PendingCircleIcon } from "./icons";

/*
 * The agent card of the "Агент" step: a white card (radius 18, card shadow)
 * with the agent's header and, under a hairline, its checks, install steps
 * or the install error.
 *
 *   <AgentCard>
 *     <AgentCardHeader name="Claude Code" description="Агент от Anthropic"
 *       status={<AgentStatusBadge tone="confirmed">Готов к работе</AgentStatusBadge>} />
 *     <AgentCardSection>
 *       <AgentCheck mark="done" meta={<AgentCheckMeta mono>версия 2.1.4</AgentCheckMeta>}>
 *         Установлен на компьютере
 *       </AgentCheck>
 *     </AgentCardSection>
 *   </AgentCard>
 */
export function AgentCard({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "bg-background shadow-card flex flex-col rounded-md px-[18px] py-1.5",
        className
      )}
      {...props}
    />
  );
}

export function AgentCardHeader({
  className,
  description,
  logo = <ClaudeIcon className="size-[22px]" />,
  name,
  status,
}: {
  className?: string;
  description: ReactNode;
  logo?: ReactNode;
  name: ReactNode;
  status?: ReactNode;
}) {
  return (
    <header className={cn("flex items-center gap-3.5 py-3", className)}>
      <span
        aria-hidden="true"
        className="bg-surface flex size-10 shrink-0 items-center justify-center rounded-sm"
      >
        {logo}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-lg font-semibold">{name}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {status}
    </header>
  );
}

type AgentStatusTone = "neutral" | "confirmed" | "attention" | "error";

const STATUS_BADGE: Record<
  AgentStatusTone,
  { dot: string; variant: BadgeVariant }
> = {
  attention: { dot: "bg-accent", variant: "waiting" },
  confirmed: { dot: "bg-confirmed", variant: "confirmed" },
  error: { dot: "bg-contradiction", variant: "contradiction" },
  neutral: { dot: "bg-empty", variant: "empty" },
};

/** Status pill in the card header, with a dot of the same hue. */
export function AgentStatusBadge({
  children,
  className,
  dot = true,
  tone,
}: {
  children: ReactNode;
  className?: string;
  dot?: boolean;
  tone: AgentStatusTone;
}) {
  const { dot: dotColor, variant } = STATUS_BADGE[tone];
  return (
    <Badge
      className={cn("font-medium", className)}
      indicator={false}
      variant={variant}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", dotColor)}
        />
      ) : null}
      {children}
    </Badge>
  );
}

/** Part of the card under the header, set apart by space. */
export function AgentCardSection({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col pt-4 pb-1.5", className)} {...props} />
  );
}

export type AgentCheckMark =
  | "done"
  | "progress"
  | "pending"
  | "attention"
  | "failed";

const MARK_LABEL: Record<AgentCheckMark, string> = {
  attention: "нужно действие",
  done: "готово",
  failed: "ошибка",
  pending: "ещё не проверяли",
  progress: "идёт проверка",
};

/** 20px status mark at the start of a check or step row. */
export function AgentCheckMarkIcon({ mark }: { mark: AgentCheckMark }) {
  let icon: ReactNode;
  switch (mark) {
    case "done":
      icon = <CheckIcon className="text-confirmed size-3.5" />;
      break;
    case "progress":
      icon = (
        <span aria-hidden="true" className="flex">
          <Spinner />
        </span>
      );
      break;
    case "attention":
      icon = <span className="bg-accent size-2 rounded-full" />;
      break;
    case "failed":
      icon = <CrossIcon className="text-contradiction size-3.5" />;
      break;
    default:
      icon = <PendingCircleIcon className="text-border-strong size-3.5" />;
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {icon}
      <span className="sr-only">{MARK_LABEL[mark]}: </span>
    </span>
  );
}

/** Number in a gray circle, for the install plan. */
export function AgentStepNumber({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="bg-surface text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-xs"
    >
      {value}
    </span>
  );
}

/*
 * One row of the card: a 20px mark (AgentCheckMarkIcon or AgentStepNumber),
 * the label and, on the right, a meta value or an action. Pending rows and
 * finished install steps are muted, the running install step is medium.
 */
export function AgentCheck({
  children,
  className,
  emphasis = "default",
  mark,
  trailing,
}: {
  children: ReactNode;
  className?: string;
  emphasis?: "default" | "muted" | "strong";
  mark: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <li className={cn("flex items-center gap-3 py-2", className)}>
      {mark}
      <span
        className={cn(
          "min-w-0 flex-1 text-base",
          emphasis === "muted" && "text-muted-foreground",
          emphasis === "strong" && "font-medium"
        )}
      >
        {children}
      </span>
      {trailing}
    </li>
  );
}

/**
 * A row that holds more than a label: the mark, the label and, under the
 * label, the content (a form, a hint). The mark stays on the label's line.
 */
export function AgentCheckDetails({
  children,
  className,
  label,
  mark,
}: {
  children: ReactNode;
  className?: string;
  label: ReactNode;
  mark: ReactNode;
}) {
  return (
    <li className={cn("flex items-start gap-3 py-2", className)}>
      <span className="flex h-6 items-center">{mark}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-base">{label}</span>
        {children}
      </div>
    </li>
  );
}

/** Value on the right of a row: mono for versions and sizes. */
export function AgentCheckMeta({
  children,
  className,
  mono = false,
}: {
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "text-muted-foreground shrink-0",
        mono ? "font-mono text-xs" : "text-sm",
        className
      )}
    >
      {children}
    </span>
  );
}

/** List of AgentCheck rows. */
export function AgentCheckList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("flex flex-col", className)} {...props} />;
}

/** Technical reason of a failure, mono on gray, line by line. */
export function AgentErrorLog({
  className,
  lines,
}: {
  className?: string;
  lines: readonly string[];
}) {
  return (
    <pre
      className={cn(
        "bg-surface text-muted-foreground overflow-x-auto rounded-sm px-3 py-2.5 font-mono text-xs/[18px]",
        className
      )}
    >
      {lines.join("\n")}
    </pre>
  );
}
