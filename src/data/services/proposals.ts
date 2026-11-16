import { Context, Effect, Layer } from "effect";

import {
  commands,
  type DataChanged,
  type Person,
  type Proposal,
  type ProposalApplied,
  type ProposalDecide,
  type Value,
} from "@/bindings";
import { charCount, NOTES_MAX_CHARS } from "@/data/project-limits";
import { type BackendError, call } from "@/effect/tauri";

import { compareIds, invalid, MockDatabase, notFound } from "./mock-database";
import { notesDate, notesLine } from "./mock-records";

/*
 * What the summary proposes to change in the brief and the client's
 * profiles (post-call design.md, decision 8; `knowledge-proposals`).
 * Nothing changes until the manager accepts: `decide` with `accepted`
 * applies the proposal (the profile field, or a line under «## Из звонков»
 * in the project's notes) and the decision in one write; `rejected`
 * changes nothing else. `undo` makes it pending again and puts the field
 * back, unless the field changed since («Поле изменили после принятия»).
 *
 * Each write sends the `DataChanged` Rust sends: the person's and the
 * project's (its brief depends on its people) or the project's, then the
 * call's (its counters of pending proposals).
 */
export class ProposalsData extends Context.Service<
  ProposalsData,
  {
    /** A call's proposals, oldest first. */
    readonly list: (callId: string) => Effect.Effect<Proposal[], BackendError>;
    /** A person's pending proposals from every call, newest first. */
    readonly forPerson: (
      personId: string
    ) => Effect.Effect<Proposal[], BackendError>;
    readonly decide: (
      id: string,
      input: ProposalDecide
    ) => Effect.Effect<Proposal, BackendError>;
    readonly undo: (id: string) => Effect.Effect<Proposal, BackendError>;
  }
>()("grill/data/services/ProposalsData") {
  static readonly layerTauri = Layer.succeed(ProposalsData, {
    decide: (id, input) => call(() => commands.proposalDecide(id, input)),
    forPerson: (personId) => call(() => commands.proposalsForPerson(personId)),
    list: (callId) => call(() => commands.proposalsList(callId)),
    undo: (id) => call(() => commands.proposalUndo(id)),
  });

  static readonly layerMock = Layer.effect(
    ProposalsData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const get = Effect.fnUntraced(function* (id: string) {
        const found = tables.proposals.get(id);
        if (!found) {
          return yield* notFound(`Предложение ${id} не найдено`);
        }
        return found;
      });

      const callOf = Effect.fnUntraced(function* (proposal: Proposal) {
        const found = tables.calls.get(proposal.callId);
        if (!found) {
          return yield* notFound(`Звонок ${proposal.callId} не найден`);
        }
        return found;
      });

      const personOf = Effect.fnUntraced(function* (proposal: Proposal) {
        if (proposal.personId === null) {
          return yield* invalid("Предложение по профилю без человека");
        }
        const person = tables.people.get(proposal.personId);
        if (!person) {
          return yield* notFound(`Человек ${proposal.personId} не найден`);
        }
        return person;
      });

      const projectOf = Effect.fnUntraced(function* (proposal: Proposal) {
        const found = yield* callOf(proposal);
        if (found.projectId === null) {
          return yield* invalid("У звонка без проекта нет брифа");
        }
        const project = tables.projects.get(found.projectId);
        if (!project) {
          return yield* notFound(`Проект ${found.projectId} не найден`);
        }
        return { call: found, project };
      });

      /** Writes a profile field (`undefined` unsets it): its events. */
      const writeField = Effect.fnUntraced(function* (
        person: Person,
        field: ProfileField,
        value: Value | undefined
      ) {
        const next = withField(person, field, value);
        tables.people.set(person.id, {
          ...next,
          updatedAt: yield* database.touch(person.updatedAt),
        });
        return [
          change("person", person.id, person.projectId),
          change("project", person.projectId, person.projectId),
        ];
      });

      const writeNotes = Effect.fnUntraced(function* (
        projectId: string,
        notes: string
      ) {
        const trimmed = notes.trim();
        if (charCount(trimmed) > NOTES_MAX_CHARS) {
          return yield* invalid(NOTES_OVER_LIMIT);
        }
        const project = tables.projects.get(projectId);
        if (!project) {
          return yield* notFound(`Проект ${projectId} не найден`);
        }
        tables.projects.set(projectId, {
          ...project,
          notes: trimmed,
          updatedAt: yield* database.touch(project.updatedAt),
        });
        return [change("project", projectId, projectId)];
      });

      /** Applies the accepted `text`: what was written, and the events. */
      const apply = Effect.fnUntraced(function* (
        proposal: Proposal,
        text: string
      ) {
        if (proposal.target === "person") {
          const field = yield* profileField(proposal.field);
          const person = yield* personOf(proposal);
          const written = yield* profileValue(field, text);
          const previous = currentValue(person, field) ?? null;
          const events = yield* writeField(person, field, written);
          const applied: ProposalApplied = { previous, written };
          return { applied, events };
        }
        const { call: found, project } = yield* projectOf(proposal);
        const line = notesLine(
          notesDate(found.startedAt ?? found.createdAt),
          text
        );
        const events = yield* writeNotes(
          project.id,
          withLine(project.notes, line)
        );
        const applied: ProposalApplied = { previous: null, written: line };
        return { applied, events };
      });

      const revert = Effect.fnUntraced(function* (
        proposal: Proposal,
        applied: ProposalApplied
      ) {
        if (proposal.target === "person") {
          const field = yield* profileField(proposal.field);
          const person = yield* personOf(proposal);
          const current = currentValue(person, field);
          if (JSON.stringify(current) !== JSON.stringify(applied.written)) {
            return yield* invalid(CHANGED_SINCE);
          }
          return yield* writeField(
            person,
            field,
            applied.previous ?? undefined
          );
        }
        const { project } = yield* projectOf(proposal);
        const notes =
          typeof applied.written === "string"
            ? withoutLine(project.notes, applied.written)
            : undefined;
        if (notes === undefined) {
          return yield* invalid(CHANGED_SINCE);
        }
        return yield* writeNotes(project.id, notes);
      });

      /** Stores the decision, then sends the events of the write. */
      const commit = Effect.fnUntraced(function* (
        proposal: Proposal,
        patch: Pick<Proposal, "applied" | "decision" | "edited">,
        events: DataChanged[]
      ) {
        const found = yield* callOf(proposal);
        const updatedAt = yield* database.touch(proposal.updatedAt);
        const decided: Proposal = {
          ...proposal,
          ...patch,
          decidedAt: patch.decision === "pending" ? null : updatedAt,
          updatedAt,
        };
        tables.proposals.set(proposal.id, decided);
        for (const item of [
          ...events,
          change("call", found.id, found.projectId),
        ]) {
          yield* database.emit(
            item.entity,
            item.id,
            item.projectId,
            item.change
          );
        }
        return decided;
      });

      const decide = Effect.fnUntraced(function* (
        id: string,
        input: ProposalDecide
      ) {
        const proposal = yield* get(id);
        if (proposal.decision !== "pending") {
          return yield* invalid(
            "Предложение уже разобрано: сначала отмените решение"
          );
        }
        if (input.decision === "pending") {
          return yield* invalid("Предложение можно принять или отклонить");
        }
        if (input.decision === "rejected") {
          return yield* commit(
            proposal,
            { applied: null, decision: "rejected", edited: null },
            []
          );
        }
        const edited = input.edited ?? null;
        const text = (edited ?? proposal.after).trim();
        if (!text) {
          return yield* invalid("Принятое значение не может быть пустым");
        }
        const { applied, events } = yield* apply(proposal, text);
        return yield* commit(
          proposal,
          {
            applied,
            decision: "accepted",
            edited: edited === null ? null : text,
          },
          events
        );
      });

      const undo = Effect.fnUntraced(function* (id: string) {
        const proposal = yield* get(id);
        if (proposal.decision === "pending") {
          return yield* invalid("Предложение ещё не разобрано");
        }
        let events: DataChanged[] = [];
        if (proposal.decision === "accepted") {
          if (!proposal.applied) {
            return yield* invalid(CHANGED_SINCE);
          }
          events = yield* revert(proposal, proposal.applied);
        }
        return yield* commit(
          proposal,
          { applied: null, decision: "pending", edited: null },
          events
        );
      });

      const list = Effect.fnUntraced(function* (callId: string) {
        if (!tables.calls.has(callId)) {
          return yield* notFound(`Звонок ${callId} не найден`);
        }
        return [...tables.proposals.values()]
          .filter((item) => item.callId === callId)
          .sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
      });

      const forPerson = Effect.fnUntraced(function* (personId: string) {
        if (!tables.people.has(personId)) {
          return yield* notFound(`Человек ${personId} не найден`);
        }
        return [...tables.proposals.values()]
          .filter(
            (item) => item.personId === personId && item.decision === "pending"
          )
          .sort((a, b) => b.createdAt - a.createdAt || compareIds(b.id, a.id));
      });

      return ProposalsData.of({ decide, forPerson, list, undo });
    })
  );
}

/** The heading of the notes' section accepted brief proposals go to. */
export const NOTES_SECTION = "## Из звонков";
export const CHANGED_SINCE = "Поле изменили после принятия";
const NOTES_OVER_LIMIT =
  "Заметки проекта будут длиннее 50 000 символов: сократите их, чтобы принять предложение";
const DIGITS = /^\d+$/u;
const LEVEL_MIN = 1;
const LEVEL_MAX = 5;

const change = (
  entity: DataChanged["entity"],
  id: string,
  projectId: string | null
): DataChanged => ({ change: "updated", entity, id, projectId });

/** A field of a profile a proposal may change. */
type ProfileField =
  | { kind: "role" }
  | { key: string; kind: "level" | "text" }
  | { kind: "portrait"; label: string };

const profileField = Effect.fnUntraced(function* (field: string) {
  if (field === "role") {
    return { kind: "role" } as ProfileField;
  }
  if (field === "tech" || field === "project") {
    return { key: field, kind: "level" } as ProfileField;
  }
  if (field === "howToAsk" || field === "notes") {
    return { key: field, kind: "text" } as ProfileField;
  }
  const label = field.startsWith("portrait:")
    ? field.slice("portrait:".length).trim()
    : "";
  if (!label) {
    return yield* invalid(`Поля профиля «${field}» нет`);
  }
  return { kind: "portrait", label } as ProfileField;
});

const profileValue = Effect.fnUntraced(function* (
  field: ProfileField,
  text: string
) {
  if (field.kind !== "level") {
    return text as Value;
  }
  const level = DIGITS.test(text) ? Number(text) : Number.NaN;
  if (!(level >= LEVEL_MIN && level <= LEVEL_MAX)) {
    return yield* invalid("Уровень — число от 1 до 5");
  }
  return level as Value;
});

function profileOf(person: Person): { [key: string]: Value } {
  const { profile } = person;
  return profile && typeof profile === "object" && !Array.isArray(profile)
    ? { ...profile }
    : {};
}

function portraitOf(profile: { [key: string]: Value }): {
  [key: string]: Value;
} {
  const { portrait } = profile;
  return portrait && typeof portrait === "object" && !Array.isArray(portrait)
    ? { ...portrait }
    : {};
}

/** The field's value now; `undefined` when it is not set. */
function currentValue(person: Person, field: ProfileField): Value | undefined {
  if (field.kind === "role") {
    return person.role ? person.role : undefined;
  }
  const profile = profileOf(person);
  const value =
    field.kind === "portrait"
      ? portraitOf(profile)[field.label]
      : profile[field.key];
  return value === null ? undefined : value;
}

function withField(
  person: Person,
  field: ProfileField,
  value: Value | undefined
): Person {
  if (field.kind === "role") {
    return { ...person, role: typeof value === "string" ? value : "" };
  }
  const profile = profileOf(person);
  if (field.kind === "portrait") {
    const portrait = portraitOf(profile);
    if (value === undefined) {
      delete portrait[field.label];
    } else {
      portrait[field.label] = value;
    }
    return { ...person, profile: { ...profile, portrait } };
  }
  if (value === undefined) {
    delete profile[field.key];
  } else {
    profile[field.key] = value;
  }
  return { ...person, profile };
}

const isHeading = (line: string) => line.trimStart().startsWith("#");

/** The `## Из звонков` heading's index and the end of its section. */
function section(lines: string[]) {
  const heading = lines.findIndex((line) => line.trim() === NOTES_SECTION);
  if (heading < 0) {
    return;
  }
  const after = lines.slice(heading + 1).findIndex(isHeading);
  return { end: after < 0 ? lines.length : heading + 1 + after, heading };
}

/** `notes` with `line` at the end of the section (added when missing). */
export function withLine(notes: string, line: string) {
  const lines = notes.split("\n");
  const found = section(lines);
  if (!found) {
    const kept = notes.trimEnd();
    return kept.trim()
      ? `${kept}\n\n${NOTES_SECTION}\n${line}`
      : `${NOTES_SECTION}\n${line}`;
  }
  let last = found.heading;
  for (let index = found.end - 1; index > found.heading; index -= 1) {
    if (lines[index]?.trim()) {
      last = index;
      break;
    }
  }
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}

/** `notes` without the last `line`; `undefined` without it. */
export function withoutLine(notes: string, line: string) {
  const lines = notes.split("\n");
  const index = lines.findLastIndex((known) => known.trimEnd() === line);
  if (index < 0) {
    return;
  }
  lines.splice(index, 1);
  const found = section(lines);
  if (
    found &&
    lines.slice(found.heading + 1, found.end).every((known) => !known.trim())
  ) {
    lines.splice(found.heading, found.end - found.heading);
    const { heading } = found;
    if (
      heading > 0 &&
      heading === lines.length &&
      !lines[heading - 1]?.trim()
    ) {
      lines.pop();
    }
  }
  return lines.join("\n");
}
