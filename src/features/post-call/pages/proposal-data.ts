import type { CallRecording, Proposal } from "@/bindings";
import type { ClientPerson } from "@/data/people";
import {
  proposalSection,
  proposalText,
  proposalValue,
} from "@/lib/proposal-fields";

import type { KnowledgeTarget, ProposalData, ProposalGroupData } from "../mock";
import { wallClock } from "./call-data";

/*
 * The proposals of a call (`proposals_list`) as the review and the
 * summary's right column draw them: one group for the brief, one per
 * person of the client, in the order the agent proposed them.
 */

const BRIEF = "brief";

interface Target {
  id: string;
  initial?: string;
  name: string;
  proposals: Proposal[];
  role?: string;
}

/** The brief, then each person, with their proposals. */
function targetsOf(
  proposals: readonly Proposal[],
  people: readonly ClientPerson[]
): Target[] {
  const targets = new Map<string, Target>();
  for (const proposal of proposals) {
    const id = proposal.personId ?? BRIEF;
    let target = targets.get(id);
    if (!target) {
      const person = people.find((item) => item.id === proposal.personId);
      const name = person?.name ?? "Человек клиента";
      target =
        id === BRIEF
          ? { id, name: "Бриф проекта", proposals: [] }
          : {
              id,
              initial: name.charAt(0).toUpperCase(),
              name,
              proposals: [],
              role: person?.role || undefined,
            };
      targets.set(id, target);
    }
    target.proposals.push(proposal);
  }
  const brief = targets.get(BRIEF);
  targets.delete(BRIEF);
  return brief ? [brief, ...targets.values()] : [...targets.values()];
}

/** «Предложения обновить знания»: what they update, pending ones counted. */
export function knowledgeTargets(
  proposals: readonly Proposal[],
  people: readonly ClientPerson[]
): KnowledgeTarget[] {
  return targetsOf(proposals, people).map((target) => ({
    count: target.proposals.filter((item) => item.decision === "pending")
      .length,
    id: target.id,
    initial: target.initial,
    name: target.name,
  }));
}

/** «сказал клиент, 12:24», «вывод агента по 12:06 и 12:11». */
function sourceOf(
  proposal: Proposal,
  recordings: readonly CallRecording[],
  speaker: string
): ProposalData["source"] {
  const times = proposal.evidence
    .map((item) => wallClock(recordings, item))
    .filter(Boolean);
  if (proposal.kind === "said") {
    const said =
      speaker === "клиент" ? "сказал клиент" : `сказал(а) ${speaker}`;
    return { kind: "said", text: times[0] ? `${said}, ${times[0]}` : said };
  }
  return {
    kind: "agent",
    text:
      times.length > 0
        ? `вывод агента по ${times.join(" и ")}`
        : "вывод агента",
  };
}

/** The review's groups; `editingId` is the one open in «Изменить». */
export function proposalGroups(
  proposals: readonly Proposal[],
  {
    editingId,
    people,
    recordings,
    speaker,
  }: {
    editingId: string | null;
    people: readonly ClientPerson[];
    recordings: readonly CallRecording[];
    speaker: string;
  }
): ProposalGroupData[] {
  return targetsOf(proposals, people).map((target) => ({
    count: target.id === BRIEF ? target.proposals.length : undefined,
    id: target.id,
    initial: target.initial,
    proposals: target.proposals.map((proposal): ProposalData => {
      const section = proposalSection(proposal);
      const suggestion = proposalValue(proposal.field, proposalText(proposal));
      let state: ProposalData["state"] = proposal.decision;
      if (proposal.decision === "pending" && proposal.id === editingId) {
        state = "editing";
      }
      return {
        before: proposalValue(proposal.field, proposal.before),
        id: proposal.id,
        resolved: `${section}: ${suggestion}`,
        section,
        source: sourceOf(proposal, recordings, speaker),
        state,
        suggestion,
      };
    }),
    role: target.role,
    title: target.name,
  }));
}
