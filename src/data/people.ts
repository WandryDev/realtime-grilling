"use client";

import { createStore } from "./store";

/*
 * People of the client, per project. The project page lists them, the person
 * page shows one, the wizard and "Новый человек" add them. When the backend
 * arrives the actions turn into Tauri commands, the hooks stay.
 */

export interface ClientPerson {
  /** Full "как формулировать вопросы" text; the card shows `howToAsk`. */
  askStyle?: string;
  howToAsk: string;
  id: string;
  initials: string;
  name: string;
  /** Free notes from "Что важно знать". */
  notes?: string;
  /** Portrait rows edited by the manager: label → value. */
  portrait?: Record<string, string>;
  /** Understanding of the project, 1–5. */
  project: number;
  projectId: string;
  role: string;
  /**
   * Edit the agent suggested after the last call: `pending` waits for the
   * manager, `accepted` is applied, `declined` is dropped.
   */
  suggestion?: "pending" | "accepted" | "declined";
  /** Technical level, 1–5. */
  tech: number;
}

const INITIAL: ClientPerson[] = [
  {
    howToAsk:
      "Спрашивать через последствия для бизнеса: деньги, пациенты, сроки. Без терминов.",
    id: "olga",
    initials: "ОД",
    name: "Ольга Демченко",
    project: 3,
    projectId: "telemedia",
    role: "CEO, решает по срокам и бюджету",
    suggestion: "pending",
    tech: 1,
  },
  {
    howToAsk:
      "Можно сразу про API, поля и форматы. Любит конкретику, не любит «потом решим».",
    id: "igor",
    initials: "ИС",
    name: "Игорь Савчук",
    project: 4,
    projectId: "telemedia",
    role: "Техлид, amoCRM и телефония",
    tech: 5,
  },
];

const peopleStore = createStore<ClientPerson[]>(INITIAL);

const WHITESPACE = /\s+/u;

export function usePeople(projectId: string | null | undefined) {
  const people = peopleStore.use();
  return people.filter((person) => person.projectId === projectId);
}

export function usePerson(
  projectId: string | null | undefined,
  personId: string | null | undefined
) {
  const people = peopleStore.use();
  return people.find(
    (person) => person.projectId === projectId && person.id === personId
  );
}

/** "Ольга Демченко" → "ОД". */
export function initialsOf(name: string) {
  const letters = name
    .trim()
    .split(WHITESPACE)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  return letters || "?";
}

function slugify(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return base || "person";
}

/** Adds a person to a project and returns the id. */
export function addPerson(
  input: Omit<ClientPerson, "id" | "initials"> & { initials?: string }
): string {
  const existing = new Set(
    peopleStore
      .get()
      .filter((item) => item.projectId === input.projectId)
      .map((item) => item.id)
  );
  const base = slugify(input.name);
  let id = base;
  let suffix = 2;
  while (existing.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  const person: ClientPerson = {
    ...input,
    id,
    initials: input.initials ?? initialsOf(input.name),
  };
  peopleStore.set((people) => [...people, person]);
  return id;
}

export function updatePerson(
  projectId: string,
  personId: string,
  patch: Partial<Omit<ClientPerson, "id" | "projectId">>
) {
  peopleStore.set((people) =>
    people.map((person) =>
      person.projectId === projectId && person.id === personId
        ? { ...person, ...patch }
        : person
    )
  );
}

/** Removes everything of a deleted project. */
export function removeProjectPeople(projectId: string) {
  peopleStore.set((people) =>
    people.filter((person) => person.projectId !== projectId)
  );
}
