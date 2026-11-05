"use client";

import { Effect } from "effect";

import type { Proposal, ProposalDecide } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";

import { ProposalsData } from "./services/proposals";
import {
  createSyncedStores,
  type Synced,
  useSyncedState,
} from "./synced-store";

/*
 * The proposals of the summaries (post-call design.md, decision 8;
 * `knowledge-proposals`): a call's, for its review page, and a person's
 * pending ones from every call, for the person's page. Accepting applies
 * the proposal in Rust (the profile, or a line in the project's notes),
 * so the person and project stores follow by themselves; a refusal
 * (notes over the limit, «Поле изменили после принятия») is a toast with
 * Rust's reason, and nothing changes.
 *
 * A call's list re-reads on the call's `DataChanged` (a decision, a new
 * build); a person's on the person's and on any call's (a build of
 * another call may propose something about them).
 */

const NONE: Synced<Proposal[]> = { data: [], status: "ready" };

const callProposals = createSyncedStores((callId) => ({
  empty: [] as Proposal[],
  live: inTauri,
  onChange: (change) =>
    change.entity === "call" && change.id === callId
      ? {
          update: Effect.map(
            ProposalsData.use((data) => data.list(callId)),
            (list) => () => list
          ),
        }
      : undefined,
  read: ProposalsData.use((data) => data.list(callId)),
  runtime: appRuntime,
  seed: () => [] as Proposal[],
}));

const personProposals = createSyncedStores((personId) => ({
  empty: [] as Proposal[],
  live: inTauri,
  onChange: (change) =>
    change.entity === "call" ||
    (change.entity === "person" && change.id === personId)
      ? {
          update: Effect.map(
            ProposalsData.use((data) => data.forPerson(personId)),
            (list) => () => list
          ),
        }
      : undefined,
  read: ProposalsData.use((data) => data.forPerson(personId)),
  runtime: appRuntime,
  seed: () => [] as Proposal[],
}));

/** The proposals of a call, oldest first, with their decisions. */
export function useCallProposals(
  callId: string | null | undefined
): Synced<Proposal[]> {
  return useSyncedState(callId ? callProposals(callId) : undefined, NONE);
}

/** A person's pending proposals from every call, newest first. */
export function usePersonProposals(
  personId: string | null | undefined
): Synced<Proposal[]> {
  return useSyncedState(personId ? personProposals(personId) : undefined, NONE);
}

/** Proposals still waiting for a decision. */
export function countPending(proposals: readonly Proposal[]) {
  return proposals.filter((proposal) => proposal.decision === "pending").length;
}

/**
 * Accepts (with the manager's text of «Изменить», if any) or rejects a
 * proposal. Resolves to it as stored, or `undefined` when it was refused.
 */
export function decideProposal(proposal: Proposal, input: ProposalDecide) {
  return callProposals(proposal.callId).mutate(
    ProposalsData.use((data) => data.decide(proposal.id, input)),
    {
      error:
        input.decision === "accepted"
          ? "Не удалось принять предложение"
          : "Не удалось отклонить предложение",
    }
  );
}

/** «Отменить» / «Вернуть»: pending again, the field as it was. */
export function undoProposal(proposal: Proposal) {
  return callProposals(proposal.callId).mutate(
    ProposalsData.use((data) => data.undo(proposal.id)),
    { error: "Не удалось отменить решение" }
  );
}
