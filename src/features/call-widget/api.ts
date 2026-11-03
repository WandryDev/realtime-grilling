"use client";

import { Effect, Stream } from "effect";

import { startCall } from "@/data/call-session";
import type { ClientPerson } from "@/data/people";
import { runCancelable } from "@/effect/runtime";
import {
  beginRecording,
  finishRecordedCall,
  type RecordingStart,
} from "@/features/recording/api";

import {
  type AgentEvent,
  type BriefProgress,
  CallWidgetBackend,
} from "./backend";
import {
  LAST_CALL_PARTICIPANTS,
  NAME_FORMS,
  type Participant,
  PICKER_PROJECTS,
  type PickerProject,
} from "./mock";

/*
 * React-facing side of the floating widgets:
 * - getLastCallParticipantIds / toPickerProject: who was on the project's
 *   last call (mock data until the calls store reads the backend)
 * - startRecording / endCall: start and stop the recorder with the call
 * - buildBrief / subscribeToAgent: run the CallWidgetBackend Effect service
 *   (`./backend.ts`) and return a cancel function; call it on unmount.
 */

/* ---------------------------------------------------------------- People */

/** A person of the client as a widget chip: first name and its cases. */
export function toParticipant(person: ClientPerson): Participant {
  const name = person.name.split(" ")[0] ?? person.name;
  return {
    ...NAME_FORMS[name],
    id: person.id,
    initials: person.initials,
    name,
  };
}

/** Ids of the people preselected for a project: those of its last call. */
export function getLastCallParticipantIds(projectId: string | null): string[] {
  return projectId ? (LAST_CALL_PARTICIPANTS[projectId] ?? []) : [];
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

/* ------------------------------------------------------------- Recording */

/**
 * "Начать": starts recording, then the call with it. A failed start (no
 * microphone access) leaves the call as it was and says why.
 */
export async function startRecording(input: {
  participants: Participant[];
  projectId: string | null;
}): Promise<RecordingStart> {
  const started = await beginRecording({
    participantIds: input.participants.map((person) => person.id),
    projectId: input.projectId,
  });
  if (started.ok) {
    startCall({
      participants: input.participants.map((person) => person.name),
      projectId: input.projectId,
      recordingId: started.id,
    });
  }
  return started;
}

/** "Завершить": recording stops, the agent collects the summary. */
export function endCall() {
  finishRecordedCall();
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
