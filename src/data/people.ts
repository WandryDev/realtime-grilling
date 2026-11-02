"use client";

import { Effect, Option, Schema } from "effect";

import type { Person, Value } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";

import { mockSeed } from "./services/mock-seed";
import { PeopleData } from "./services/people";
import { ProjectsData } from "./services/projects";
import { createSyncedStore } from "./synced-store";

/*
 * People of the client, per project. The project page lists them, the person
 * page shows one, the wizard and "Новый человек" add them. What the screens
 * know about a person beyond name and role is the `profile` JSON of the
 * stored record; the adapter below is the one place that maps it.
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

const WHITESPACE = /\s+/u;

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

/* ------------------------------------------------------------- Adapter */

const Profile = Schema.Struct({
  askStyle: Schema.optionalKey(Schema.String),
  howToAsk: Schema.optionalKey(Schema.String),
  initials: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.String),
  portrait: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  project: Schema.optionalKey(Schema.Number),
  suggestion: Schema.optionalKey(
    Schema.Literals(["pending", "accepted", "declined"])
  ),
  tech: Schema.optionalKey(Schema.Number),
});
const decodeProfile = Schema.decodeUnknownOption(Profile);

type ProfileFields = Omit<ClientPerson, "id" | "name" | "projectId" | "role">;

/** Levels of a person nobody described yet. */
const DEFAULT_LEVEL = 3;

/** A stored person as the screens draw it. */
export function toClientPerson(person: Person): ClientPerson {
  const profile: typeof Profile.Type = Option.getOrElse(
    decodeProfile(person.profile),
    () => ({})
  );
  return {
    ...profile,
    howToAsk: profile.howToAsk ?? "",
    id: person.id,
    initials: profile.initials ?? initialsOf(person.name),
    name: person.name,
    portrait: profile.portrait ? { ...profile.portrait } : undefined,
    project: profile.project ?? DEFAULT_LEVEL,
    projectId: person.projectId,
    role: person.role,
    tech: profile.tech ?? DEFAULT_LEVEL,
  };
}

/** The `profile` JSON of a person: the fields the record has no column for. */
function toProfile(fields: ProfileFields): { [key: string]: Value } {
  const profile: { [key: string]: Value } = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      profile[key] = value as Value;
    }
  }
  return profile;
}

function profileOf(person: Partial<ClientPerson>): ProfileFields {
  const {
    id: _id,
    name: _name,
    projectId: _project,
    role: _role,
    ...rest
  } = person;
  return rest as ProfileFields;
}

/* --------------------------------------------------------------- Store */

/** Everyone: the people of every project. */
const readPeople = Effect.gen(function* () {
  const projects = yield* ProjectsData;
  const people = yield* PeopleData;
  const list = yield* projects.list;
  const perProject = yield* Effect.forEach(
    list,
    (project) => people.list(project.id),
    { concurrency: "unbounded" }
  );
  return perProject.flat().map(toClientPerson);
});

/** The people of one project replace what the store had for it. */
const rereadProject = (projectId: string) =>
  PeopleData.use((people) => people.list(projectId)).pipe(
    Effect.map(
      (list) => (current: ClientPerson[]) =>
        current
          .filter((person) => person.projectId !== projectId)
          .concat(list.map(toClientPerson))
    )
  );

const peopleStore = createSyncedStore({
  empty: [] as ClientPerson[],
  live: inTauri,
  // A person changed, or their project (deleted with its people).
  onChange: (change) =>
    (change.entity === "person" || change.entity === "project") &&
    change.projectId
      ? { scope: change.projectId, update: rereadProject(change.projectId) }
      : undefined,
  read: readPeople,
  runtime: appRuntime,
  seed: () => mockSeed().people.map(toClientPerson),
});

export function usePeople(projectId: string | null | undefined) {
  const people = peopleStore.use();
  return people.filter((person) => person.projectId === projectId);
}

export function usePeopleState() {
  return peopleStore.useState();
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

/**
 * Adds a person to a project. Resolves to the id the backend gave them,
 * or `undefined` when it failed (a toast says why).
 */
export function addPerson(
  input: Omit<ClientPerson, "id" | "initials"> & { initials?: string }
): Promise<string | undefined> {
  const { name, projectId, role } = input;
  return peopleStore
    .mutate(
      PeopleData.use((people) =>
        people.create({
          name,
          profile: toProfile({
            ...profileOf(input),
            initials: input.initials ?? initialsOf(name),
          }),
          projectId,
          role,
        })
      ),
      { error: `Не удалось добавить ${name.trim() || "человека"}` }
    )
    .then((person) => person?.id);
}

export function updatePerson(
  projectId: string,
  personId: string,
  patch: Partial<Omit<ClientPerson, "id" | "projectId">>
) {
  const current = peopleStore
    .get()
    .find((person) => person.projectId === projectId && person.id === personId);
  const fields = profileOf(patch);
  const hasProfile = Object.keys(fields).length > 0;
  return peopleStore.mutate(
    PeopleData.use((people) =>
      people.update(personId, {
        name: patch.name,
        // The backend replaces the whole profile.
        profile:
          hasProfile && current
            ? toProfile({ ...profileOf(current), ...fields })
            : undefined,
        role: patch.role,
      })
    ),
    { error: "Не удалось сохранить профиль" }
  );
}

/**
 * The people of a deleted project. The backend deletes them with the
 * project; this only makes sure the store has caught up.
 */
export function removeProjectPeople(_projectId: string) {
  return peopleStore.refresh();
}

/** Reads the people again (the storage error screen's "Повторить"). */
export function refreshPeople() {
  return peopleStore.refresh();
}
