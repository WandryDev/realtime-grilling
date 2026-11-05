"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useCallTranscript } from "@/data/call-records";
import { type CallRecord, useCall } from "@/data/calls";
import { usePeople } from "@/data/people";
import {
  decideProposal,
  undoProposal,
  useCallProposals,
} from "@/data/proposals";
import { inTauri } from "@/effect/runtime";
import { plural } from "@/lib/plural";
import { proposalEdited, proposalText } from "@/lib/proposal-fields";
import { useDemoState } from "@/lib/use-demo-state";

import { usePostCallInfo } from "../components/links";
import type { ProposalAction } from "../components/proposals";
import type { ProposalGroupData, ReviewTotals } from "../mock";
import {
  ProposalsReviewScreen,
  type ReviewOutcome,
} from "../screens/proposals-review-screen";
import { speakerOf } from "./call-data";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";
import { proposalGroups } from "./proposal-data";

/*
 * /calls/proposals?id=…: "04 Ревью предложений" of the call's proposals
 * (`proposals_list`), grouped by the brief and by person. Accept, edit
 * (⌘ Enter saves and accepts, Esc cancels), reject and undo go to Rust,
 * which applies an accepted one to the profile or the project's notes; a
 * refusal (notes over the limit, «Поле изменили после принятия») is a
 * toast with Rust's reason, and the proposal stays as it was. Keys: A
 * accept, E edit, X reject, J/K next and previous waiting proposal.
 * Nothing waits → "Всё разобрано"; none at all → «Предложений нет».
 * `?demo=done` (browser) accepts every waiting proposal at once.
 */

const DEMO_STATES = ["done"] as const;

function totalsOf(groups: ProposalGroupData[]): ReviewTotals {
  const totals = { accepted: 0, pending: 0, rejected: 0 };
  for (const group of groups) {
    for (const proposal of group.proposals) {
      if (proposal.state === "accepted") {
        totals.accepted += 1;
      } else if (proposal.state === "rejected") {
        totals.rejected += 1;
      } else {
        totals.pending += 1;
      }
    }
  }
  return totals;
}

const CHANGE_FORMS: [string, string, string] = [
  "изменение",
  "изменения",
  "изменений",
];

/** «3 изменения». */
function changes(count: number) {
  return `${count} ${plural(count, ...CHANGE_FORMS)}`;
}

function outcomeOf(
  groups: ProposalGroupData[],
  totals: ReviewTotals,
  projectName: string
): ReviewOutcome {
  const targets = groups.map((group) => {
    const accepted = group.proposals.filter(
      (proposal) => proposal.state === "accepted"
    ).length;
    return {
      count: accepted,
      id: group.id,
      initial: group.initial,
      name: group.title,
      note: accepted > 0 ? changes(accepted) : "без изменений",
    };
  });
  const rejected =
    totals.rejected > 0
      ? `, ${totals.rejected} отклонили`
      : ", ничего не отклонили";
  return {
    description: `Внесли ${changes(totals.accepted)}${rejected}. В следующем звонке по проекту «${projectName}» агент опирается на обновлённый бриф и профили.`,
    targets,
  };
}

const NEXT_KEYS = new Set(["j", "о"]);
const PREVIOUS_KEYS = new Set(["k", "л"]);
const ACTION_KEYS: Record<string, ProposalAction> = {
  a: "accept",
  e: "edit",
  x: "reject",
  у: "edit",
  ф: "accept",
  ч: "reject",
};

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA")
  );
}

function ProposalsOfCall({ call }: { call: CallRecord }) {
  const demo = useDemoState(DEMO_STATES);
  const info = usePostCallInfo();
  const { data: proposals, status } = useCallProposals(call.id);
  const people = usePeople(call.projectId);
  const recordings = useCallTranscript(call.id).data;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);

  useEffect(() => {
    if (demo !== "done" || inTauri) {
      return;
    }
    for (const proposal of proposals) {
      if (proposal.decision === "pending") {
        decideProposal(proposal, { decision: "accepted" });
      }
    }
  }, [demo, proposals]);

  const speaker = speakerOf(
    call.participantIds.length === 1 ? [call.participants] : []
  );
  const groups = useMemo(
    () => proposalGroups(proposals, { editingId, people, recordings, speaker }),
    [editingId, people, proposals, recordings, speaker]
  );
  const totals = useMemo(() => totalsOf(groups), [groups]);
  const waiting = useMemo(
    () =>
      groups
        .flatMap((group) => group.proposals)
        .filter((proposal) => proposal.state !== "accepted")
        .filter((proposal) => proposal.state !== "rejected")
        .map((proposal) => proposal.id),
    [groups]
  );
  const activeId =
    currentId && waiting.includes(currentId) ? currentId : waiting[0];

  const onAction = useCallback(
    (proposalId: string, action: ProposalAction, text?: string) => {
      setCurrentId(proposalId);
      const proposal = proposals.find((item) => item.id === proposalId);
      if (!proposal) {
        return;
      }
      switch (action) {
        case "accept":
          decideProposal(proposal, { decision: "accepted" });
          break;
        case "reject":
          decideProposal(proposal, { decision: "rejected" });
          break;
        case "undo":
          undoProposal(proposal);
          break;
        case "edit":
          setEditingId(proposalId);
          return;
        case "save": {
          const edited = text ? proposalEdited(proposal.field, text) : "";
          decideProposal(proposal, {
            decision: "accepted",
            edited:
              edited && edited !== proposalText(proposal) ? edited : undefined,
          });
          break;
        }
        default:
          break;
      }
      setEditingId(null);
    },
    [proposals]
  );

  // A, E, X act on the current proposal; J and K move between them
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const noModifiers = !(event.metaKey || event.ctrlKey || event.altKey);
      if (!noModifiers || isTyping(event.target) || editingId || !activeId) {
        return;
      }
      const key = event.key.toLowerCase();
      const index = waiting.indexOf(activeId);
      if (NEXT_KEYS.has(key) || PREVIOUS_KEYS.has(key)) {
        const step = NEXT_KEYS.has(key) ? 1 : -1;
        const next = waiting[(index + step + waiting.length) % waiting.length];
        setCurrentId(next ?? null);
        document
          .querySelector(`[data-proposal-id="${next}"]`)
          ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        return;
      }
      const action = ACTION_KEYS[key];
      if (action) {
        event.preventDefault();
        onAction(activeId, action);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, editingId, onAction, waiting]);

  let state: "partial" | "done" | "empty" | "loading" = "partial";
  if (status === "loading") {
    state = "loading";
  } else if (proposals.length === 0) {
    state = "empty";
  } else if (totals.pending === 0) {
    state = "done";
  }

  return (
    <ProposalsReviewScreen
      className={APP_WINDOW}
      currentId={activeId}
      emptyNote={
        call.projectId === null
          ? "У звонка без проекта нет брифа и профилей, предлагать нечего."
          : "Агент не нашёл в звонке нового для брифа и профилей."
      }
      groups={groups}
      onAction={onAction}
      outcome={outcomeOf(groups, totals, info.project)}
      state={state}
      totals={totals}
    />
  );
}

export function ProposalsPage() {
  const params = useSearchParams();
  const call = useCall(params.get("id"));

  return (
    <CallPageFrame call={call}>
      {call ? <ProposalsOfCall call={call} /> : null}
    </CallPageFrame>
  );
}
