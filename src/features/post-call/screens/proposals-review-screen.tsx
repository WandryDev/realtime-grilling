"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";

import {
  CallPageHeader,
  CallWindow,
  PanelPage,
  SideColumn,
  SideHeading,
} from "../components/call-window";
import {
  CenteredState,
  StateList,
  StateRow,
  StateRowNote,
} from "../components/centered-state";
import { LinkButton } from "../components/link-button";
import { usePostCallInfo, usePostCallLinks } from "../components/links";
import {
  Proposal,
  type ProposalActionHandler,
  ProposalGroupHeading,
  ReviewProgress,
  ReviewTally,
  ShortcutList,
} from "../components/proposals";
import { CheckIcon, DocumentIcon } from "../icons";
import {
  type KnowledgeTarget,
  PROPOSAL_GROUPS,
  type ProposalGroupData,
  REVIEW_RESULT,
  REVIEW_SHORTCUTS,
  REVIEW_TOTALS,
  type ReviewTotals,
} from "../mock";

/*
 * "04 Ревью предложений": `partial` with accepted, rejected, pending and
 * edited proposals; `done` once nothing waits for a decision; `empty`
 * when the call has none («Предложений нет»); `loading` until they are
 * read.
 */

export interface ReviewOutcome {
  description: string;
  targets: (KnowledgeTarget & { note: string })[];
}

const REVIEW_OUTCOME: ReviewOutcome = {
  description:
    "Внесли 5 изменений, 2 отклонили. В следующем звонке по Телемедиа агент опирается на обновлённый бриф и профили.",
  targets: REVIEW_RESULT,
};

function ReviewDone({ outcome }: { outcome: ReviewOutcome }) {
  const links = usePostCallLinks();
  return (
    <CenteredState
      className="flex-1"
      description={outcome.description}
      media={<CheckIcon className="size-7" strokeWidth={0.75} />}
      mediaClassName="bg-confirmed-soft text-confirmed size-16 rounded-full"
      title="Всё разобрано"
    >
      <StateList label="Что изменилось">
        {outcome.targets.map((target) => (
          <StateRow
            key={target.id}
            media={
              target.initial ? (
                <Avatar className="size-6" size="sm">
                  <AvatarFallback>{target.initial}</AvatarFallback>
                </Avatar>
              ) : (
                <DocumentIcon className="text-muted-foreground mx-1 size-4 shrink-0" />
              )
            }
            trailing={<StateRowNote>{target.note}</StateRowNote>}
          >
            {target.name}
          </StateRow>
        ))}
      </StateList>
      <div className="flex items-center gap-2 pt-1">
        <LinkButton href={links.summary} size="lg">
          К итогам звонка
        </LinkButton>
        <LinkButton href={links.project} size="lg" variant="secondary">
          Открыть бриф
        </LinkButton>
      </div>
    </CenteredState>
  );
}

function NoProposals({ note }: { note: string }) {
  const links = usePostCallLinks();
  return (
    <CenteredState
      className="flex-1"
      description={note}
      media={<DocumentIcon className="size-7" strokeWidth={0.75} />}
      mediaClassName="bg-surface text-muted-foreground size-16 rounded-full"
      title="Предложений нет"
    >
      <div className="flex items-center gap-2 pt-1">
        <LinkButton href={links.summary} size="lg">
          К итогам звонка
        </LinkButton>
      </div>
    </CenteredState>
  );
}

export function ProposalsReviewScreen({
  className,
  currentId,
  emptyNote = "Агент не нашёл в звонке нового для брифа и профилей.",
  groups = PROPOSAL_GROUPS,
  onAction,
  outcome = REVIEW_OUTCOME,
  state = "partial",
  totals: totalsProp,
}: {
  className?: string;
  /** Proposal the keyboard shortcuts act on (app). */
  currentId?: string;
  /** Why there are none, under «Предложений нет». */
  emptyNote?: string;
  /** Proposals with their states; the Paper review by default. */
  groups?: ProposalGroupData[];
  onAction?: ProposalActionHandler;
  /** What "Всё разобрано" reports. */
  outcome?: ReviewOutcome;
  state?: "partial" | "done" | "empty" | "loading";
  totals?: ReviewTotals;
}) {
  const info = usePostCallInfo();
  const links = usePostCallLinks();
  const totals =
    totalsProp ?? REVIEW_TOTALS[state === "done" ? "done" : "partial"];
  const reviewed = totals.accepted + totals.rejected;
  const total = reviewed + totals.pending;
  const breadcrumb = [
    { href: links.project, label: info.project },
    { href: links.summary, label: info.callLabel },
  ];

  return (
    <CallWindow
      active="proposals"
      aside={
        <SideColumn label="Решения">
          <SideHeading note="сохраняются сразу">Решения</SideHeading>
          <ReviewTally totals={totals} />
          {state === "partial" ? (
            <>
              <p className="text-muted-foreground px-2 pt-3.5 text-sm">
                Бриф и профили хранятся на этом компьютере. Любое решение можно
                отменить, пока открыт этот звонок.
              </p>
              <ShortcutList shortcuts={REVIEW_SHORTCUTS} />
            </>
          ) : null}
        </SideColumn>
      }
      className={className}
      pendingProposals={totals.pending}
    >
      <PanelPage className="flex-1">
        <CallPageHeader breadcrumb={breadcrumb} title="Предложения">
          {state === "partial" ? (
            <div className="flex flex-col gap-4">
              <p className="text-muted-foreground max-w-[600px] text-lg">
                Агент заметил в звонке новое о проекте и людях. В бриф и профили
                попадёт только то, что вы примете.
              </p>
              <ReviewProgress reviewed={reviewed} total={total} />
            </div>
          ) : null}
        </CallPageHeader>
        {state === "empty" ? <NoProposals note={emptyNote} /> : null}
        {state === "done" ? <ReviewDone outcome={outcome} /> : null}
        {state === "partial"
          ? groups.map((group) => (
              <section
                aria-labelledby={`proposals-${group.id}`}
                className="flex flex-col gap-3"
                key={group.id}
              >
                <ProposalGroupHeading
                  count={group.count}
                  id={`proposals-${group.id}`}
                  initial={group.initial}
                  role={group.role}
                  title={group.title}
                />
                {group.proposals.map((proposal) => (
                  <Proposal
                    current={proposal.id === currentId}
                    key={proposal.id}
                    onAction={onAction}
                    proposal={proposal}
                  />
                ))}
              </section>
            ))
          : null}
      </PanelPage>
    </CallWindow>
  );
}
