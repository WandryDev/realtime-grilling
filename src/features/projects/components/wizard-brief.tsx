import type { ChangeEvent, MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription } from "@/components/ui/field";
import { Progress, ProgressCaption } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { charCount, NOTES_MAX_CHARS } from "@/data/project-limits";
import { cn } from "@/lib/utils";

import { StepCheckIcon, WorkingRingIcon } from "../icons";
import type { BRIEF_READY, BRIEF_TASKS, BriefTaskState } from "../mock";
import { SourceMark } from "./source-mark";

/* ---------------------------------------------- Step 4, заметки менеджера */

const COUNT = new Intl.NumberFormat("ru-RU");

/**
 * The notes, at most `limit` characters (Rust refuses longer ones). With
 * `onChange` the field is controlled by `value`.
 */
export function ManagerNotesField({
  className,
  limit = NOTES_MAX_CHARS,
  onChange,
  value,
}: {
  className?: string;
  limit?: number;
  onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  value: string;
}) {
  return (
    <Field className={cn("gap-2", className)}>
      <Textarea
        aria-label="Заметки менеджера"
        className="min-h-[260px] px-4 py-3.5 leading-[22px]"
        data-preview={onChange ? undefined : "focus"}
        defaultValue={onChange ? undefined : value}
        maxLength={limit}
        onChange={onChange}
        placeholder="Например: решения по бюджету принимает только CEO"
        value={onChange ? value : undefined}
      />
      <div className="flex justify-between gap-4">
        <FieldDescription>
          Видно только вам. Клиенту не показывается.
        </FieldDescription>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {COUNT.format(charCount(value))} / {COUNT.format(limit)}
        </span>
      </div>
    </Field>
  );
}

/** Chips that append a heading line to the notes (`data-hint`). */
export function NoteHints({
  className,
  hints,
  onHint,
}: {
  className?: string;
  hints: string[];
  onHint?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <p className="text-muted-foreground text-sm">
        Подсказки, что ещё полезно записать
      </p>
      <div className="flex flex-wrap gap-2">
        {hints.map((hint) => (
          <Button
            className="h-[30px] font-normal"
            data-hint={hint}
            key={hint}
            onClick={onHint}
            size="sm"
            variant="secondary"
          >
            + {hint}
          </Button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------- Собираю бриф проекта */

export function BriefBuildProgress({
  className,
  eta,
  stage,
  stages,
}: {
  className?: string;
  eta: string;
  stage: number;
  stages: number;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <ProgressCaption aria-hidden="true">
        <span>
          Этап {stage} из {stages}
        </span>
        <span className="font-mono text-xs">{eta}</span>
      </ProgressCaption>
      <Progress
        aria-label={`Сбор брифа, этап ${stage} из ${stages}`}
        className="[&_[data-slot=progress-track]]:bg-border"
        size="sm"
        tone="active"
        value={(stage / stages) * 100}
      />
    </div>
  );
}

const TASK_STATE_LABEL: Record<BriefTaskState, string> = {
  done: "готово",
  pending: "в очереди",
  working: "сейчас",
};

/** What the agent reads, live: done, working (with the path), pending. */
export function BriefTaskList({
  className,
  tasks,
}: {
  className?: string;
  tasks: typeof BRIEF_TASKS;
}) {
  return (
    <ol className={cn("flex flex-col", className)}>
      {tasks.map((task) => (
        <li
          aria-current={task.state === "working" ? "step" : undefined}
          className="flex items-start gap-3.5 py-3"
          key={task.title}
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <BriefTaskMark state={task.state} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cn(
                "text-base",
                task.state === "pending"
                  ? "text-muted-foreground"
                  : "text-foreground",
                task.state === "working" && "font-medium"
              )}
            >
              {task.title}
              <span className="sr-only">, {TASK_STATE_LABEL[task.state]}</span>
            </span>
            <span
              className={cn(
                "text-muted-foreground",
                task.mono ? "font-mono text-xs" : "text-sm"
              )}
            >
              {task.detail}
            </span>
          </span>
          {task.source ? (
            <SourceMark
              className={cn("size-4", task.state !== "working" && "opacity-50")}
              kind={task.source}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function BriefTaskMark({ state }: { state: BriefTaskState }) {
  if (state === "done") {
    return <StepCheckIcon className="text-confirmed size-3.5" />;
  }
  if (state === "working") {
    return <WorkingRingIcon className="size-4 motion-safe:animate-spin" />;
  }
  return (
    <span
      aria-hidden="true"
      className="bg-border-strong size-1.5 rounded-full"
    />
  );
}

/* ------------------------------------------------------------ Бриф готов */

export function BriefStats({
  className,
  stats,
}: {
  className?: string;
  stats: typeof BRIEF_READY.stats;
}) {
  return (
    <dl className={cn("flex flex-wrap gap-x-10 gap-y-4 pb-4", className)}>
      {stats.map((stat) => (
        <div className="flex flex-col-reverse gap-0.5" key={stat.label}>
          <dt className="text-muted-foreground text-sm">{stat.label}</dt>
          <dd className="text-foreground text-2xl font-semibold tracking-tight tabular-nums">
            {stat.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Label and value rows: "Продукт", "Стек", "Сроки". */
export function BriefFacts({
  className,
  facts,
}: {
  className?: string;
  facts: typeof BRIEF_READY.facts;
}) {
  return (
    <dl className={cn("flex flex-col gap-3.5", className)}>
      {facts.map((fact) => (
        <div className="flex gap-4" key={fact.label}>
          <dt className="text-muted-foreground w-24 shrink-0 text-sm/5">
            {fact.label}
          </dt>
          <dd className="text-foreground min-w-0 flex-1 text-base">
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A blue note: the agent found a mismatch between sources and picked one
 * option, it will ask on the next call.
 */
export function AssumptionNote({
  className,
  detail,
  title,
}: {
  className?: string;
  detail: string;
  title: string;
}) {
  return (
    <div
      className={cn(
        "bg-assumption-soft flex gap-3 rounded-md px-4 py-3.5",
        className
      )}
    >
      <span className="flex h-5 shrink-0 items-center">
        <span
          aria-hidden="true"
          className="bg-assumption size-1.5 rounded-full"
        />
      </span>
      <div className="flex flex-col gap-0.5">
        <p className="text-foreground text-base">{title}</p>
        <p className="text-assumption text-sm">{detail}</p>
      </div>
    </div>
  );
}
