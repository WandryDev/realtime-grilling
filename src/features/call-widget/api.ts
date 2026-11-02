"use client";

import { finishCall, startCall } from "@/data/call-session";
import type { ClientPerson } from "@/data/people";

import {
  type BriefStepItem,
  INCOMING_QUESTIONS,
  LAST_CALL_PARTICIPANTS,
  NAME_FORMS,
  type Participant,
  PICKER_PROJECTS,
  type PickerProject,
} from "./mock";

/*
 * Everything the floating widgets would ask the backend for, faked with
 * timers. Each function is what a Tauri command or event replaces later:
 * - getLastCallParticipantIds: who was on the project's last call
 * - startRecording / endCall: start and stop the recorder
 * - buildBrief: the agent refreshing the brief (progress events)
 * - subscribeToAgent: the agent's live feed (status, new questions)
 * Every async op returns a cancel function; call it on unmount.
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

export function startRecording(input: {
  participants: Participant[];
  projectId: string | null;
}) {
  startCall({
    participants: input.participants.map((person) => person.name),
    projectId: input.projectId,
  });
}

/** "Завершить": recording stops, the agent collects the summary. */
export function endCall() {
  finishCall();
}

/* ----------------------------------------------------------------- Brief */

export interface BriefProgress {
  done: boolean;
  /** Percent of the brief prepared. */
  progress: number;
  steps: BriefStepItem[];
}

/** "Ольги и Игоря", "Натальи", "Сергея, Анны и Елены". */
export function joinNames(names: string[]) {
  if (names.length <= 1) {
    return names.join("");
  }
  return `${names.slice(0, -1).join(", ")} и ${names.at(-1)}`;
}

function briefPlan(participants: Participant[]) {
  const names = participants.map((person) => person.genitive ?? person.name);
  return [
    { id: "agent", label: "Claude Code на связи" },
    {
      id: "profiles",
      label: names.length > 0 ? `Профили ${joinNames(names)}` : "Профили",
    },
    { id: "outline", label: "Освежаю бриф по Outline", meta: "12 док." },
    { id: "clickup", label: "Ищу вопросы в ClickUp" },
  ];
}

const BRIEF_STEP_MS = [700, 900, 1600, 1200];

/**
 * Refreshes the brief step by step and reports after every step. Calls
 * `onProgress` right away with the first step running.
 */
export function buildBrief(
  participants: Participant[],
  onProgress: (progress: BriefProgress) => void
): () => void {
  const plan = briefPlan(participants);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const report = (active: number) => {
    const done = active >= plan.length;
    onProgress({
      done,
      progress: done ? 100 : Math.round(((active + 0.5) / plan.length) * 100),
      steps: plan.map((step, index) => {
        let status: BriefStepItem["status"] = "pending";
        if (index < active) {
          status = "done";
        } else if (index === active) {
          status = "active";
        }
        return { ...step, status };
      }),
    });
    if (!done) {
      timer = setTimeout(() => report(active + 1), BRIEF_STEP_MS[active]);
    }
  };

  report(0);
  return () => clearTimeout(timer);
}

/* ------------------------------------------------------------ Agent feed */

export type AgentEvent =
  | { type: "thinking" }
  | { question: string; type: "question" };

const FIRST_QUESTION_MS = 4000;
const NEXT_QUESTION_MS = 20_000;
const THINKING_MS = 1500;

/**
 * The agent's live feed: it thinks for a moment, then a new question
 * arrives. First one a few seconds after the overlay opens, then every
 * 20 seconds, cycling through the demo questions.
 */
export function subscribeToAgent(
  onEvent: (event: AgentEvent) => void
): () => void {
  let index = 0;
  let timer: ReturnType<typeof setTimeout>;

  const think = (delay: number) => {
    timer = setTimeout(() => {
      onEvent({ type: "thinking" });
      timer = setTimeout(() => {
        const question = INCOMING_QUESTIONS[index % INCOMING_QUESTIONS.length];
        index += 1;
        onEvent({ question, type: "question" });
        think(NEXT_QUESTION_MS);
      }, THINKING_MS);
    }, delay - THINKING_MS);
  };

  think(FIRST_QUESTION_MS);
  return () => clearTimeout(timer);
}
