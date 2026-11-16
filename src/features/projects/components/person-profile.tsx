import Link from "next/link";
import { type MouseEvent, type ReactNode, useId } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { PencilIcon } from "../icons";
import type { PERSON } from "../mock";
import { LevelMeter } from "./level-meter";
import { PersonAvatar } from "./person-card";

/*
 * Profile of a person of the client. Every block has a view and an edit
 * look with the same geometry, so the layout doesn't jump in edit mode.
 */

type Person = typeof PERSON;

export function ProfileHeader({
  actions,
  className,
  editing = false,
  initials,
  name,
  role,
}: {
  actions: ReactNode;
  className?: string;
  editing?: boolean;
  initials: string;
  name: string;
  role: string;
}) {
  return (
    <header className={cn("flex items-center gap-4", className)}>
      <PersonAvatar initials={initials} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
          {name}
        </h1>
        {editing ? (
          <Input
            aria-label="Роль"
            className="h-9 w-[420px]"
            defaultValue={role}
            name="role"
          />
        ) : (
          <p className="text-muted-foreground text-base">{role}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  );
}

export function ProfileViewActions({ onEdit }: { onEdit?: () => void }) {
  return (
    <Button className="h-9" onClick={onEdit} variant="secondary">
      <PencilIcon className="size-3.5" />
      Изменить
    </Button>
  );
}

/** Cancel and save. With `form` the save button submits that form. */
export function ProfileEditActions({
  form,
  onCancel,
}: {
  form?: string;
  onCancel?: () => void;
}) {
  return (
    <>
      <Button className="h-9 px-4" onClick={onCancel} variant="secondary">
        Отмена
      </Button>
      <Button
        className="h-9 px-4"
        form={form}
        type={form ? "submit" : "button"}
      >
        Сохранить
        <span
          aria-hidden="true"
          className="text-on-ink/55 font-mono text-xs font-normal"
        >
          ⌘S
        </span>
      </Button>
    </>
  );
}

/**
 * Suggested edit after a call, inside the profile: what changes, the quote
 * it comes from (links to the transcript) and accept / edit / decline. With
 * `reviewHref` (the proposals of a call) the decisions are made in the
 * call's review: one link there instead of the buttons.
 */
export function ProfileSuggestion({
  className,
  onAccept,
  onDecline,
  onEditAccept,
  quoteHref = "#transcript-12-14",
  reviewHref,
  suggestion,
}: {
  className?: string;
  onAccept?: () => void;
  onDecline?: () => void;
  /** "Изменить и принять": opens the fields with the edit applied. */
  onEditAccept?: () => void;
  /** The quote leads to its moment in the call transcript. */
  quoteHref?: string;
  /** «Разобрать в звонке»: the review of the call. */
  reviewHref?: string;
  suggestion: Omit<Person["suggestion"], "quote"> & { quote?: string };
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "bg-accent-soft flex flex-col gap-3.5 rounded-md p-5",
        className
      )}
    >
      <h2
        className="text-accent-ink flex items-center gap-2 text-sm font-medium"
        id={titleId}
      >
        <span aria-hidden="true" className="bg-accent size-1.5 rounded-full" />
        {suggestion.title}
      </h2>
      <dl className="flex flex-col gap-2.5">
        {suggestion.changes.map((change) => (
          <div className="flex gap-4" key={change.field}>
            <dt className="text-accent-ink w-35 shrink-0 text-base">
              {change.field}
            </dt>
            <dd className="text-foreground min-w-0 flex-1 text-base">
              {change.text}
            </dd>
          </div>
        ))}
      </dl>
      {suggestion.quote ? (
        <blockquote className="border-accent-ink/25 border-l-2 pl-3 text-sm">
          <Link
            className="text-accent-ink focus-visible:focus-ring rounded-xs hover:underline"
            href={quoteHref}
          >
            {suggestion.quote}
          </Link>
        </blockquote>
      ) : null}
      {reviewHref ? (
        <div className="flex items-center gap-2">
          <Link
            className={cn(buttonVariants(), "h-[34px] px-4")}
            href={reviewHref}
          >
            Разобрать в звонке
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button className="h-[34px] px-4" onClick={onAccept}>
            Принять
          </Button>
          <Button
            className="bg-background hover:bg-background/70 h-[34px] px-4"
            onClick={onEditAccept}
            variant="secondary"
          >
            Изменить и принять
          </Button>
          <Button
            className="text-accent-ink hover:text-accent-ink h-[34px] px-3 hover:bg-transparent"
            onClick={onDecline}
            variant="ghost"
          >
            Отклонить
          </Button>
        </div>
      )}
    </section>
  );
}

/** How the agent should word questions for this person, with an example. */
export function AskStyle({
  className,
  editing = false,
  example,
  label,
  text,
}: {
  className?: string;
  editing?: boolean;
  example?: Person["askExample"];
  label: string;
  text: string;
}) {
  const fieldId = useId();
  const hintId = useId();
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {editing ? (
        <label className="text-muted-foreground text-sm" htmlFor={fieldId}>
          {label}
        </label>
      ) : (
        <h2 className="text-muted-foreground text-sm font-normal">{label}</h2>
      )}
      {editing ? (
        <InputGroup className="gap-2 px-3.5 py-3" data-preview="focus">
          <InputGroupTextarea
            aria-describedby={hintId}
            className="min-h-0 py-0 text-[15px]/6"
            defaultValue={text}
            id={fieldId}
            name="askStyle"
          />
          <InputGroupAddon
            align="block-end"
            className="justify-end pb-0 text-xs"
            id={hintId}
          >
            агент использует это дословно
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <p className="text-foreground max-w-[640px] text-lg/[26px]">{text}</p>
      )}
      {example && !editing ? (
        <dl className="bg-surface flex flex-col gap-2 rounded-sm px-4 py-3.5">
          <div className="flex gap-3">
            <dt className="text-muted-foreground w-18 shrink-0 text-sm/5">
              вместо
            </dt>
            <dd className="text-muted-foreground text-base">
              {example.instead}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-confirmed w-18 shrink-0 text-sm/5">спросит</dt>
            <dd className="text-foreground text-base">{example.asks}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

export interface ScaleValue {
  label: string;
  level: number;
  /** Hovered step in edit mode: shown gray, its name after an arrow. */
  next?: { level: number; value: string };
  value: string;
}

/**
 * Card with a 5-step scale. In edit mode the steps are buttons; each carries
 * `data-scale` (the `scaleKey`) and `data-level` for `onStepClick`.
 */
export function ScaleCard({
  className,
  editing = false,
  onStepClick,
  scale,
  scaleKey,
}: {
  className?: string;
  editing?: boolean;
  onStepClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  scale: ScaleValue;
  scaleKey?: string;
}) {
  const preview = editing ? scale.next : undefined;

  return (
    <div
      className={cn(
        "bg-surface flex flex-col gap-2.5 rounded-sm px-4 py-3.5",
        className
      )}
    >
      <div className="flex justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{scale.label}</span>
        <span className="text-foreground font-medium">
          {scale.value}
          {preview ? ` → ${preview.value}` : null}
        </span>
      </div>
      {editing ? (
        <ScaleSteps
          label={scale.label}
          level={scale.level}
          onStepClick={onStepClick}
          preview={preview?.level}
          scaleKey={scaleKey}
        />
      ) : (
        <LevelMeter label={scale.label} level={scale.level} size="md" />
      )}
    </div>
  );
}

/** The clickable steps of a scale in edit mode. */
function ScaleSteps({
  label,
  level,
  max = 5,
  onStepClick,
  preview,
  scaleKey,
}: {
  label: string;
  level: number;
  max?: number;
  onStepClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  preview?: number;
  scaleKey?: string;
}) {
  const steps = Array.from({ length: max }, (_, index) => index + 1);
  return (
    <div className="flex gap-1">
      {steps.map((step) => (
        <button
          aria-label={`${label}: ${step} из ${max}`}
          aria-pressed={step === level}
          className="group/step focus-visible:focus-ring -my-2 flex flex-1 rounded-full py-2"
          data-level={step}
          data-preview={step === preview ? "hover" : undefined}
          data-scale={scaleKey}
          key={step}
          onClick={onStepClick}
          type="button"
        >
          <span
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors",
              step <= level
                ? "bg-foreground"
                : "bg-border group-hover/step:bg-border-strong"
            )}
          />
        </button>
      ))}
    </div>
  );
}

/** Role, temperament, character, expectations: label and value rows. */
export function Portrait({
  className,
  editing = false,
  rows,
}: {
  className?: string;
  editing?: boolean;
  rows: Person["portrait"];
}) {
  const idPrefix = useId();
  if (editing) {
    return (
      <div className={cn("flex flex-col", className)}>
        {rows.map((row, index) => (
          <div className="flex items-center gap-4 py-2" key={row.label}>
            <label
              className="text-muted-foreground w-40 shrink-0 text-sm/5"
              htmlFor={`${idPrefix}-${index}`}
            >
              {row.label}
            </label>
            <Textarea
              className="min-h-0 py-[9px]"
              defaultValue={row.edited ?? row.value}
              id={`${idPrefix}-${index}`}
              name={`portrait:${row.label}`}
            />
          </div>
        ))}
      </div>
    );
  }
  return (
    <dl className={cn("flex flex-col gap-5", className)}>
      {rows.map((row) => (
        <div className="flex gap-4" key={row.label}>
          <dt className="text-muted-foreground w-45 shrink-0 text-sm/5">
            {row.label}
          </dt>
          <dd className="text-foreground min-w-0 flex-1 text-base">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "Что важно знать": the manager's notes about the person. */
export function ManagerNotes({
  className,
  editing = false,
  text,
}: {
  className?: string;
  editing?: boolean;
  text: string;
}) {
  const fieldId = useId();
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {editing ? (
        <label className="text-muted-foreground text-sm" htmlFor={fieldId}>
          Что важно знать
        </label>
      ) : (
        <h2 className="text-muted-foreground text-sm font-normal">
          Что важно знать
        </h2>
      )}
      {editing ? (
        <Textarea
          className="min-h-18"
          defaultValue={text}
          id={fieldId}
          name="notes"
          placeholder="Например: будет на звонках про сценарии оператора"
        />
      ) : (
        <p
          className={cn(
            "max-w-[640px] text-base",
            text ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {text || "Пока ничего"}
        </p>
      )}
    </section>
  );
}

/** Right column: calls with the person and where the profile comes from. */
export function ProfileSide({
  calls,
  className,
  firstName,
  origin,
}: {
  calls: Person["calls"];
  className?: string;
  /** "Звонки с Ольгой"; without it just "Звонки". */
  firstName?: string;
  origin: string;
}) {
  const titleId = useId();
  return (
    <aside
      aria-labelledby={titleId}
      className={cn("flex w-75 shrink-0 flex-col gap-3 pt-2", className)}
    >
      <h2 className="text-muted-foreground text-sm font-normal" id={titleId}>
        {firstName ? `Звонки с ${firstName}` : "Звонки"}
      </h2>
      {calls.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Звонков пока не было. После звонка агент предложит дополнить профиль.
        </p>
      ) : null}
      <ul className="flex flex-col gap-6 pb-3">
        {calls.map((call) => (
          <li key={call.id}>
            <Link
              className="group/call focus-visible:focus-ring flex flex-col gap-1 rounded-xs"
              href={routes.callSummary(call.id)}
            >
              <span className="text-muted-foreground flex justify-between font-mono text-xs">
                <span>{call.when}</span>
                <span>{call.duration}</span>
              </span>
              <span className="text-foreground text-base group-hover/call:underline">
                {call.topic}
              </span>
              <span className="text-muted-foreground text-sm">
                {call.answered}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="bg-surface flex flex-col gap-1.5 rounded-sm px-4 py-3.5">
        <p className="text-muted-foreground text-xs">Откуда профиль</p>
        <p className="text-foreground text-sm">{origin}</p>
      </div>
    </aside>
  );
}
