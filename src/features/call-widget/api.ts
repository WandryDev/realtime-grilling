"use client";

import { Effect, Stream } from "effect";

import type { CallRecord } from "@/data/calls";
import type { ClientPerson } from "@/data/people";
import { inTauri, runCancelable } from "@/effect/runtime";
import {
  levelLabel,
  TECH_LEVEL_LABELS,
} from "@/features/projects/project-data";

import {
  type AgentEvent,
  type BriefProgress,
  CallWidgetBackend,
} from "./backend";
import {
  LAST_CALL_PARTICIPANTS,
  LAST_CALL_PROJECT_ID,
  NAME_FORMS,
  type Participant,
  PICKER_PROJECTS,
  type PickerProject,
} from "./mock";

/*
 * React-facing side of the floating widgets:
 * - lastCallProjectId / lastCallParticipantIds: what the start widget
 *   offers, from the last call (in the browser, the demo's)
 * - toPickerProject: the project rows of the picker
 * - buildBrief / subscribeToAgent: run the CallWidgetBackend Effect service
 *   (`./backend.ts`) and return a cancel function; call it on unmount.
 */

/* ---------------------------------------------------------------- People */

/**
 * A person of the client as a widget chip: first name and its cases, and
 * the tech level from the profile as the hint.
 */
export function toParticipant(person: ClientPerson): Participant {
  const name = person.name.split(" ")[0] ?? person.name;
  return {
    ...NAME_FORMS[name],
    detail: `${person.name}, в технике: ${levelLabel(TECH_LEVEL_LABELS, person.tech)}`,
    id: person.id,
    initials: person.initials,
    name,
  };
}

/** The newest of `calls` by start (its creation without a start). */
function newestCall(calls: readonly CallRecord[]): CallRecord | undefined {
  let newest: CallRecord | undefined;
  for (const call of calls) {
    if (!newest || call.startedAt > newest.startedAt) {
      newest = call;
    }
  }
  return newest;
}

/**
 * The project the start widget offers (spec «Виджет по последнему
 * звонку»): the last call's while it exists (none for a call without a
 * project), else the first project. The browser offers the demo's.
 */
export function lastCallProjectId(
  calls: readonly CallRecord[],
  projects: readonly { id: string }[]
): string | null {
  const first = projects[0]?.id ?? null;
  if (!inTauri) {
    const demo = projects.find(
      (project) => project.id === LAST_CALL_PROJECT_ID
    );
    return demo?.id ?? first;
  }
  const last = newestCall(calls);
  if (!last) {
    return first;
  }
  if (last.projectId === null) {
    return null;
  }
  const known = projects.some((project) => project.id === last.projectId);
  return known ? last.projectId : first;
}

/**
 * Ids of the people preselected for a project: those of its last call.
 * People deleted since then drop out where the ids meet the project's
 * people.
 */
export function lastCallParticipantIds(
  calls: readonly CallRecord[],
  projectId: string | null
): string[] {
  if (projectId === null) {
    return [];
  }
  if (!inTauri) {
    return LAST_CALL_PARTICIPANTS[projectId] ?? [];
  }
  const last = newestCall(calls.filter((call) => call.projectId === projectId));
  return last?.participantIds ?? [];
}

/**
 * The picker row of a project: who was on the last call and when. Projects
 * created in the app have no calls yet.
 */
export function toPickerProject(project: {
  id: string;
  name: string;
}): PickerProject {
  const known = PICKER_PROJECTS.find((item) => item.id === project.id);
  return {
    detail: known?.detail ?? "Ещё не звонили",
    id: project.id,
    lastCall: known?.lastCall,
    name: project.name,
  };
}

/* ----------------------------------------------------------------- Brief */

/**
 * Refreshes the brief step by step and reports after every step. Calls
 * `onProgress` right away with the first step running.
 */
export function buildBrief(
  participants: Participant[],
  onProgress: (progress: BriefProgress) => void
): () => void {
  return runCancelable(
    CallWidgetBackend.use((backend) =>
      Stream.runForEach(backend.buildBrief(participants), (progress) =>
        Effect.sync(() => onProgress(progress))
      )
    )
  );
}

/* ------------------------------------------------------------ Agent feed */

/**
 * The agent's live feed: it thinks for a moment, then a new question
 * arrives. First one a few seconds after the overlay opens, then every
 * 20 seconds, cycling through the demo questions.
 */
export function subscribeToAgent(
  onEvent: (event: AgentEvent) => void
): () => void {
  return runCancelable(
    CallWidgetBackend.use((backend) =>
      Stream.runForEach(backend.agentFeed, (event) =>
        Effect.sync(() => onEvent(event))
      )
    )
  );
}
