"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type CallRecord,
  type ProposalDecision,
  setProposalDecision,
  useCall,
} from "@/data/calls";
import { useDemoState } from "@/lib/use-demo-state";
import { plural } from "../api";
import { usePostCallInfo } from "../components/links";
import type { ProposalAction } from "../components/proposals";
import {
  PROPOSAL_GROUPS,
  type ProposalData,
  type ProposalGroupData,
  REVIEW_RESULT,
  type ReviewTotals,
} from "../mock";
import {
  ProposalsReviewScreen,
  type ReviewOutcome,
} from "../screens/proposals-review-screen";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";

/*
 * /calls/proposals?id=…: "04 Ревью предложений". Accept, edit (⌘ Enter
 * saves, Esc cancels), reject and undo; decisions go to the calls slice
 * right away. Keys: A accept, E edit, X reject, J/K next and previous
 * waiting proposal. Nothing waits → "Всё разобрано". `?demo=done` decides
 * every waiting proposal at once.
 */

const DEMO_STATES = ["done"] as const;

function withDecisions(
  call: CallRecord,
  editingId: string | null
): ProposalGroupData[] {
  return PROPOSAL_GROUPS.map((group) => ({
    ...group,
    proposals: group.proposals.map((proposal): ProposalData => {
      const review = call.proposals[proposal.id];
      const decision: ProposalDecision = review?.decision ?? "pending";
      const suggestion = review?.text ?? proposal.suggestion;
      let state: ProposalData["state"] = decision;
      if (decision === "pending" && proposal.id === editingId) {
        state = "editing";
      }
      return {
        ...proposal,
        resolved: review?.text ?? proposal.resolved,
        state,
        suggestion,
      };
    }),
  }));
}

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

function outcomeOf(
  groups: ProposalGroupData[],
  totals: ReviewTotals,
  projectName: string
): ReviewOutcome {
  const targets = REVIEW_RESULT.map((target) => {
    const group = groups.find((item) => item.id === target.id);
    const accepted =
      group?.proposals.filter((proposal) => proposal.state === "accepted")
        .length ?? 0;
    return {
      ...target,
      count: accepted,
      note: accepted > 0 ? plural(accepted, CHANGE_FORMS) : "без изменений",
    };
  });
  const rejected =
    totals.rejected > 0
      ? `, ${totals.rejected} отклонили`
      : ", ничего не отклонили";
  return {
    description: `Внесли ${plural(totals.accepted, CHANGE_FORMS)}${rejected}. В следующем звонке по проекту «${projectName}» агент опирается на обновлённый бриф и профили.`,
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);

  useEffect(() => {
    if (demo !== "done") {
      return;
    }
    for (const [proposalId, review] of Object.entries(call.proposals)) {
      if (review.decision === "pending") {
        setProposalDecision(call.id, proposalId, { decision: "accepted" });
      }
    }
  }, [call.id, call.proposals, demo]);

  const groups = useMemo(
    () => withDecisions(call, editingId),
    [call, editingId]
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
      switch (action) {
        case "accept":
          setProposalDecision(call.id, proposalId, {
            ...call.proposals[proposalId],
            decision: "accepted",
          });
          break;
        case "reject":
          setProposalDecision(call.id, proposalId, {
            ...call.proposals[proposalId],
            decision: "rejected",
          });
          break;
        case "undo":
          setProposalDecision(call.id, proposalId, {
            ...call.proposals[proposalId],
            decision: "pending",
          });
          break;
        case "edit":
          setEditingId(proposalId);
          return;
        case "save":
          setProposalDecision(call.id, proposalId, {
            decision: "accepted",
            text: text || call.proposals[proposalId]?.text,
          });
          break;
        default:
          break;
      }
      setEditingId(null);
    },
    [call.id, call.proposals]
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

  const done = totals.pending === 0;

  return (
    <ProposalsReviewScreen
      className={APP_WINDOW}
      currentId={activeId}
      groups={groups}
      onAction={onAction}
      outcome={outcomeOf(groups, totals, info.project)}
      state={done ? "done" : "partial"}
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
