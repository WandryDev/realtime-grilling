"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { CheckIcon, CrossIcon, DocumentIcon } from "../icons";
import type { ProposalData, ReviewTotals } from "../mock";
import { SideCard } from "./call-window";
import { StatusDot } from "./status-mark";
import { FactSource } from "./task-cards";

/*
 * "04 Ревью предложений": what the agent wants to change in the brief and
 * the client profiles. A pending proposal shows the old text struck through
 * and the new one on soft orange; accepted and rejected ones fold into a
 * one-line row with an undo.
 */

export function ReviewProgress({
  className,
  reviewed,
  total,
}: {
  className?: string;
  reviewed: number;
  total: number;
}) {
  const caption = `разобрано ${reviewed} из ${total}`;
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Progress
        aria-label={caption}
        className="**:data-[slot=progress-track]:bg-border w-[200px]"
        max={total}
        size="sm"
        value={reviewed}
      />
      <p className="text-muted-foreground text-sm tabular-nums">{caption}</p>
    </div>
  );
}

/** Brief or person the proposals of the group change. */
export function ProposalGroupHeading({
  className,
  count,
  id,
  initial,
  role,
  title,
}: {
  className?: string;
  count?: number;
  id: string;
  initial?: string;
  role?: string;
  title: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 px-1 pb-1", className)}>
      {initial ? (
        <Avatar className="size-7">
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
      ) : (
        <span
          aria-hidden="true"
          className="bg-surface flex size-7 shrink-0 items-center justify-center rounded-xs"
        >
          <DocumentIcon className="size-4" />
        </span>
      )}
      <h2 className="text-xl font-semibold text-balance" id={id}>
        {title}
      </h2>
      {count === undefined ? null : (
        <span className="text-muted-foreground font-mono text-sm">{count}</span>
      )}
      {role ? (
        <span className="text-muted-foreground text-base">{role}</span>
      ) : null}
    </div>
  );
}

function ProposalActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>{children}</div>
  );
}

export type ProposalAction =
  | "accept"
  | "edit"
  | "reject"
  | "undo"
  | "save"
  | "cancel";

/** Decision on a proposal; `save` carries the edited text. */
export type ProposalActionHandler = (
  proposalId: string,
  action: ProposalAction,
  text?: string
) => void;

function useProposalActions(
  proposalId: string,
  onAction: ProposalActionHandler | undefined,
  editor?: { current: HTMLTextAreaElement | null }
) {
  const run = useCallback(
    (action: ProposalAction) => {
      if (!onAction) {
        return;
      }
      if (action === "save") {
        onAction(proposalId, action, editor?.current?.value.trim());
        return;
      }
      onAction(proposalId, action);
    },
    [editor, onAction, proposalId]
  );
  return {
    accept: useCallback(() => run("accept"), [run]),
    cancel: useCallback(() => run("cancel"), [run]),
    edit: useCallback(() => run("edit"), [run]),
    reject: useCallback(() => run("reject"), [run]),
    run,
    save: useCallback(() => run("save"), [run]),
    undo: useCallback(() => run("undo"), [run]),
  };
}

/** A proposal waiting for a decision, or being edited. */
export function ProposalCard({
  className,
  current = false,
  onAction,
  proposal,
}: {
  className?: string;
  /** Keyboard shortcuts act on this card. */
  current?: boolean;
  onAction?: ProposalActionHandler;
  proposal: ProposalData;
}) {
  const editing = proposal.state === "editing";
  const editor = useRef<HTMLTextAreaElement>(null);
  const actions = useProposalActions(proposal.id, onAction, editor);
  const live = onAction !== undefined;

  useEffect(() => {
    if (editing && live) {
      const field = editor.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    }
  }, [editing, live]);

  const onEditorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        actions.save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        actions.cancel();
      }
    },
    [actions]
  );

  return (
    <article
      aria-current={current ? "true" : undefined}
      aria-label={proposal.section}
      className={cn(
        "bg-background shadow-card flex flex-col gap-3.5 rounded-md px-6 py-5",
        "aria-[current=true]:ring-border-strong aria-[current=true]:ring-1",
        className
      )}
      data-proposal-id={proposal.id}
    >
      <header className="flex items-center justify-between gap-4">
        <h3 className="text-muted-foreground text-sm font-medium">
          {proposal.section}
        </h3>
        <FactSource kind={proposal.source.kind} text={proposal.source.text} />
      </header>
      <div className="flex flex-col gap-2">
        {proposal.before === null ? (
          <p className="text-muted-foreground text-base">не заполнено</p>
        ) : (
          <p className="text-muted-foreground text-lg line-through decoration-1">
            <span className="sr-only">Было: </span>
            {proposal.before}
          </p>
        )}
        {editing ? (
          <Textarea
            aria-label="Новый текст"
            className="min-h-0 text-lg"
            data-preview={live ? undefined : "focus"}
            defaultValue={proposal.suggestion}
            onKeyDown={live ? onEditorKeyDown : undefined}
            ref={editor}
          />
        ) : (
          <p className="bg-accent-soft text-accent-ink rounded-sm px-3 py-2 text-lg">
            <span className="sr-only">Станет: </span>
            {proposal.suggestion}
          </p>
        )}
      </div>
      {editing ? (
        <ProposalActions>
          <Button onClick={actions.save}>Сохранить и принять</Button>
          <Button className="px-2.5" onClick={actions.cancel} variant="ghost">
            Отмена
          </Button>
          <kbd className="text-muted-foreground ml-auto font-mono text-xs">
            ⌘ Enter
          </kbd>
        </ProposalActions>
      ) : (
        <ProposalActions className="pt-0.5">
          <Button
            className="gap-1.5"
            onClick={actions.accept}
            variant="secondary"
          >
            <CheckIcon className="size-3.5" />
            Принять
          </Button>
          <Button
            className="text-foreground px-3.5"
            onClick={actions.edit}
            variant="ghost"
          >
            Изменить
          </Button>
          <Button className="px-2.5" onClick={actions.reject} variant="ghost">
            Отклонить
          </Button>
        </ProposalActions>
      )}
    </article>
  );
}

/** Accepted or rejected proposal, folded into a 52px row with an undo. */
export function ProposalResolvedRow({
  className,
  onAction,
  proposal,
}: {
  className?: string;
  onAction?: ProposalActionHandler;
  proposal: ProposalData;
}) {
  const accepted = proposal.state === "accepted";
  const { undo } = useProposalActions(proposal.id, onAction);

  return (
    <div
      className={cn(
        "flex h-[52px] shrink-0 items-center gap-3 rounded-md px-6",
        accepted && "bg-surface",
        className
      )}
    >
      {accepted ? (
        <CheckIcon className="text-confirmed size-4 shrink-0" />
      ) : (
        <CrossIcon className="text-subtle size-3.5 shrink-0" />
      )}
      <p
        className={cn(
          "min-w-0 flex-1 text-base",
          accepted ? null : "text-muted-foreground line-through decoration-1"
        )}
      >
        {proposal.resolved ?? proposal.suggestion}
      </p>
      <p
        className={cn(
          "text-sm",
          accepted ? "text-confirmed" : "text-muted-foreground"
        )}
      >
        {accepted ? "принято" : "отклонено"}
      </p>
      <Button
        className={cn(accepted && "bg-background hover:bg-border")}
        onClick={undo}
        size="sm"
        variant="secondary"
      >
        {accepted ? "Отменить" : "Вернуть"}
      </Button>
    </div>
  );
}

export function Proposal({
  current,
  onAction,
  proposal,
}: {
  current?: boolean;
  onAction?: ProposalActionHandler;
  proposal: ProposalData;
}) {
  if (proposal.state === "accepted" || proposal.state === "rejected") {
    return <ProposalResolvedRow onAction={onAction} proposal={proposal} />;
  }
  return (
    <ProposalCard current={current} onAction={onAction} proposal={proposal} />
  );
}

/** Accepted, rejected, waiting: the review tally in the right column. */
export function ReviewTally({
  className,
  totals,
}: {
  className?: string;
  totals: ReviewTotals;
}) {
  const rows = [
    {
      count: totals.accepted,
      id: "accepted",
      label: "Принято",
      tone: "confirmed" as const,
    },
    {
      count: totals.rejected,
      id: "rejected",
      label: "Отклонено",
      tone: "subtle" as const,
    },
    {
      count: totals.pending,
      id: "pending",
      label: "Ждут решения",
      tone: totals.pending > 0 ? ("accent" as const) : ("idle" as const),
    },
  ];

  return (
    <SideCard className={cn("gap-0 px-4 py-3.5", className)}>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const waiting = row.id === "pending";
          return (
            <li className="flex items-center gap-2.5" key={row.id}>
              <StatusDot tone={row.tone} />
              <span
                className={cn(
                  "flex-1 text-base",
                  waiting && row.count === 0 && "text-muted-foreground"
                )}
              >
                {row.label}
              </span>
              <span
                className={cn(
                  "font-mono text-xs tabular-nums",
                  waiting && row.count > 0
                    ? "text-accent-ink"
                    : "text-muted-foreground"
                )}
              >
                {row.count}
              </span>
            </li>
          );
        })}
      </ul>
    </SideCard>
  );
}

export function ShortcutList({
  className,
  shortcuts,
}: {
  className?: string;
  shortcuts: { key: string; label: string }[];
}) {
  return (
    <dl className={cn("flex flex-col gap-2 px-2 pt-3.5", className)}>
      {shortcuts.map((shortcut) => (
        <div
          className="text-muted-foreground flex items-center justify-between text-sm"
          key={shortcut.key}
        >
          <dt>{shortcut.label}</dt>
          <dd>
            <kbd className="font-mono text-xs">{shortcut.key}</kbd>
          </dd>
        </div>
      ))}
    </dl>
  );
}
