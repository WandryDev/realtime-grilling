import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, type Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { DataChanged, SummaryProgress } from "@/bindings";
import {
  charCount,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_TOO_LONG,
  NOTES_MAX_CHARS,
  NOTES_TOO_LONG,
} from "@/data/project-limits";
import { CallRecordsData } from "@/data/services/call-records";
import { CallsData } from "@/data/services/calls";
import { DataEvents } from "@/data/services/data-events";
import { DataLayerMock } from "@/data/services/layers";
import { MockDatabase } from "@/data/services/mock-database";
import { DEMO_CALL_ID } from "@/data/services/mock-seed";
import { PeopleData } from "@/data/services/people";
import { ProjectsData } from "@/data/services/projects";
import { CHANGED_SINCE, ProposalsData } from "@/data/services/proposals";
import { SettingsData } from "@/data/services/settings";
import { ProjectSourcesData } from "@/data/services/sources";
import { MOCK_STAGE_MS, SummaryData } from "@/data/services/summaries";
import type { BackendError, BackendErrorKind } from "@/effect/tauri";

/*
 * The contract of the data services: what the Rust commands promise
 * (`src-tauri/src/storage`, covered there by `cargo test`) and what the
 * mock has to keep, so screens behave the same in the browser and in the
 * app. `dataContract` takes any layer of the services; it runs on
 * `DataLayerMock` here. Each test builds a fresh layer and works on the
 * records it creates.
 */

type DataServices =
  | CallRecordsData
  | CallsData
  | DataEvents
  | PeopleData
  | ProjectsData
  | ProjectSourcesData
  | ProposalsData
  | SettingsData
  | SummaryData;

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The error kind of a failed effect. */
const failureKind = <A>(
  effect: Effect.Effect<A, BackendError, DataServices>
): Effect.Effect<BackendErrorKind | undefined, never, DataServices> =>
  Effect.map(Effect.exit(effect), (exit) =>
    Exit.isFailure(exit)
      ? Option.getOrUndefined(
          Option.map(Exit.findErrorOption(exit), (error) => error.kind)
        )
      : undefined
  );

/** Starts recording `DataChanged`; the returned effect reads them so far. */
const recordChanges = Effect.gen(function* () {
  const seen: DataChanged[] = [];
  const events = yield* DataEvents;
  yield* Effect.forkChild(
    Stream.runForEach(events.changes, (change) =>
      Effect.sync(() => seen.push(change))
    ),
    { startImmediately: true }
  );
  return Effect.as(Effect.yieldNow, seen);
});

function dataContract(
  name: string,
  layer: Layer.Layer<DataServices, never, never>
) {
  const run = <A, E>(effect: Effect.Effect<A, E, DataServices>) =>
    effect.pipe(Effect.provide(layer));

  describe(`${name}: projects`, () => {
    it.effect("gives every new project a UUID v7 and timestamps", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const project = yield* projects.create({
            description: "  Сеть клиник  ",
            name: "  Ромашка ",
          });
          assert.match(project.id, UUID_V7);
          assert.strictEqual(project.name, "Ромашка");
          assert.strictEqual(project.description, "Сеть клиник");
          assert.strictEqual(project.createdAt, project.updatedAt);
          assert.deepStrictEqual(yield* projects.get(project.id), project);
        })
      )
    );

    it.effect("keeps two projects with the same name apart", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const first = yield* projects.create({ name: "Телемедиа" });
          const second = yield* projects.create({ name: "Телемедиа" });
          assert.notStrictEqual(first.id, second.id);
          const listed = (yield* projects.list).map((project) => project.id);
          assert.isTrue(listed.indexOf(first.id) < listed.indexOf(second.id));
          assert.strictEqual((yield* projects.get(second.id)).id, second.id);
        })
      )
    );

    it.effect("refuses an empty name and creates nothing", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const before = (yield* projects.list).length;
          const readChanges = yield* recordChanges;
          assert.strictEqual(
            yield* failureKind(projects.create({ name: "   " })),
            "Invalid"
          );
          assert.strictEqual((yield* projects.list).length, before);
          assert.deepStrictEqual(yield* readChanges, []);
        })
      )
    );

    it.effect("answers NotFound for an unknown id", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          assert.strictEqual(
            yield* failureKind(projects.get("nope")),
            "NotFound"
          );
          assert.strictEqual(
            yield* failureKind(projects.update("nope", { name: "Х" })),
            "NotFound"
          );
          assert.strictEqual(
            yield* failureKind(projects.remove("nope")),
            "NotFound"
          );
        })
      )
    );

    it.effect("moves the change mark, not the creation mark", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const created = yield* projects.create({ name: "Ромашка" });
          yield* TestClock.adjust("1 minute");
          const updated = yield* projects.update(created.id, {
            description: "Новое описание",
          });
          assert.strictEqual(updated.createdAt, created.createdAt);
          assert.isTrue(updated.updatedAt > created.updatedAt);
          assert.strictEqual(updated.name, "Ромашка");
          assert.strictEqual(
            yield* failureKind(projects.update(created.id, { name: "" })),
            "Invalid"
          );
        })
      )
    );

    it.effect("deletes a project with its people and calls only", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const people = yield* PeopleData;
          const calls = yield* CallsData;
          const doomed = yield* projects.create({ name: "Удаляемый" });
          const kept = yield* projects.create({ name: "Остаётся" });
          const person = yield* people.create({
            name: "Анна",
            projectId: doomed.id,
          });
          const keptPerson = yield* people.create({
            name: "Борис",
            projectId: kept.id,
          });
          const doomedCall = yield* calls.create({
            participantIds: [person.id],
            projectId: doomed.id,
          });
          const keptCall = yield* calls.create({ projectId: kept.id });

          const readChanges = yield* recordChanges;
          yield* projects.remove(doomed.id);

          assert.deepStrictEqual(yield* readChanges, [
            {
              change: "deleted",
              entity: "project",
              id: doomed.id,
              projectId: doomed.id,
            },
          ]);
          assert.strictEqual(
            yield* failureKind(people.get(person.id)),
            "NotFound"
          );
          assert.strictEqual(
            yield* failureKind(calls.get(doomedCall.id)),
            "NotFound"
          );
          assert.deepStrictEqual(yield* people.list(doomed.id), []);
          assert.deepStrictEqual(yield* people.list(kept.id), [keptPerson]);
          assert.strictEqual((yield* calls.get(keptCall.id)).id, keptCall.id);
        })
      )
    );
  });

  describe(`${name}: people and calls`, () => {
    it.effect("adds people to existing projects only", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const people = yield* PeopleData;
          const project = yield* projects.create({ name: "Ромашка" });
          assert.strictEqual(
            yield* failureKind(people.create({ name: "Анна", projectId: "x" })),
            "NotFound"
          );
          assert.strictEqual(
            yield* failureKind(
              people.create({ name: " ", projectId: project.id })
            ),
            "Invalid"
          );
          const person = yield* people.create({
            name: "Анна Петрова",
            profile: { tech: 2 },
            projectId: project.id,
            role: "Директор",
          });
          assert.match(person.id, UUID_V7);
          assert.deepStrictEqual(person.profile, { tech: 2 });
          const renamed = yield* people.update(person.id, { role: "CEO" });
          assert.strictEqual(renamed.name, "Анна Петрова");
          assert.strictEqual(renamed.role, "CEO");
        })
      )
    );

    it.effect("refuses a participant from another project", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const people = yield* PeopleData;
          const calls = yield* CallsData;
          const ours = yield* projects.create({ name: "Наш" });
          const theirs = yield* projects.create({ name: "Чужой" });
          const stranger = yield* people.create({
            name: "Чужой человек",
            projectId: theirs.id,
          });
          const created = yield* calls.create({ projectId: ours.id });

          assert.strictEqual(
            yield* failureKind(calls.addParticipant(created.id, stranger.id)),
            "Invalid"
          );
          assert.strictEqual(
            yield* failureKind(
              calls.create({
                participantIds: [stranger.id],
                projectId: ours.id,
              })
            ),
            "Invalid"
          );
          assert.deepStrictEqual(yield* calls.participants(created.id), []);
        })
      )
    );

    it.effect("keeps a call without a project, without participants", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const people = yield* PeopleData;
          const calls = yield* CallsData;
          const project = yield* projects.create({ name: "Любой" });
          const anna = yield* people.create({
            name: "Анна",
            projectId: project.id,
          });
          const readChanges = yield* recordChanges;
          const alone = yield* calls.create({});

          assert.match(alone.id, UUID_V7);
          assert.isNull(alone.projectId);
          assert.deepStrictEqual(yield* readChanges, [
            {
              change: "created",
              entity: "call",
              id: alone.id,
              projectId: null,
            },
          ]);
          // Nobody of a project can be on it.
          assert.strictEqual(
            yield* failureKind(
              calls.create({ participantIds: [anna.id], projectId: null })
            ),
            "Invalid"
          );
          assert.strictEqual(
            yield* failureKind(calls.addParticipant(alone.id, anna.id)),
            "Invalid"
          );
          assert.deepStrictEqual(yield* calls.participants(alone.id), []);
          // Every call lists it; deleting any project leaves it
          // (local-storage, «Звонок без проекта»).
          assert.include(
            (yield* calls.list(null)).map((item) => item.id),
            alone.id
          );
          yield* projects.remove(project.id);
          assert.strictEqual((yield* calls.get(alone.id)).id, alone.id);
        })
      )
    );

    it.effect("shows one person on two calls, stored once", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const people = yield* PeopleData;
          const calls = yield* CallsData;
          const project = yield* projects.create({ name: "Ромашка" });
          const anna = yield* people.create({
            name: "Анна",
            projectId: project.id,
          });
          const first = yield* calls.create({ projectId: project.id });
          yield* TestClock.adjust("1 hour");
          const second = yield* calls.create({ projectId: project.id });
          yield* calls.addParticipant(first.id, anna.id);
          const updated = yield* calls.addParticipant(second.id, anna.id);

          assert.deepStrictEqual(updated.participantIds, [anna.id]);
          assert.deepStrictEqual(yield* calls.participants(first.id), [anna]);
          assert.deepStrictEqual(yield* calls.participants(second.id), [anna]);
          // Newest first.
          assert.deepStrictEqual(
            (yield* calls.list(project.id)).map((item) => item.id),
            [second.id, first.id]
          );

          yield* calls.removeParticipant(first.id, anna.id);
          assert.deepStrictEqual(yield* calls.participants(first.id), []);
          assert.strictEqual(
            yield* failureKind(calls.removeParticipant(first.id, anna.id)),
            "NotFound"
          );
        })
      )
    );

    it.effect("keeps the summary until a patch replaces it", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const calls = yield* CallsData;
          const project = yield* projects.create({ name: "Ромашка" });
          const created = yield* calls.create({
            projectId: project.id,
            summary: { summary: "processing" },
          });
          assert.strictEqual(created.status, "live");
          const renamed = yield* calls.update(created.id, { title: "Созвон" });
          assert.deepStrictEqual(renamed.summary, { summary: "processing" });
          const finished = yield* calls.update(created.id, {
            endedAt: (created.startedAt ?? 0) + 1000,
            status: "finished",
            summary: { summary: "ready" },
          });
          assert.deepStrictEqual(finished.summary, { summary: "ready" });
          assert.strictEqual(
            yield* failureKind(
              calls.update(created.id, {
                endedAt: (created.startedAt ?? 0) - 1,
              })
            ),
            "Invalid"
          );
        })
      )
    );
  });

  describe(`${name}: patches`, () => {
    it.effect("clears a nullable field with null and keeps an absent one", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const calls = yield* CallsData;
          const project = yield* projects.create({
            brief: { goal: "запись к врачу" },
            name: "Ромашка",
          });
          const renamed = yield* projects.update(project.id, { name: "Р" });
          assert.deepStrictEqual(renamed.brief, { goal: "запись к врачу" });
          const cleared = yield* projects.update(project.id, { brief: null });
          assert.strictEqual(cleared.brief, null);

          const created = yield* calls.create({ projectId: project.id });
          const ended = yield* calls.update(created.id, {
            endedAt: (created.startedAt ?? 0) + 1000,
            summary: { summary: "ready" },
          });
          const titled = yield* calls.update(created.id, { title: "Созвон" });
          assert.strictEqual(titled.endedAt, ended.endedAt);
          assert.deepStrictEqual(titled.summary, { summary: "ready" });
          // "Отменить завершение"
          const resumed = yield* calls.update(created.id, {
            endedAt: null,
            summary: null,
          });
          assert.strictEqual(resumed.endedAt, null);
          assert.strictEqual(resumed.summary, null);
          assert.strictEqual(resumed.startedAt, created.startedAt);
        })
      )
    );

    it.effect("merges summary patches key by key (RFC 7386)", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const calls = yield* CallsData;
          const readChanges = yield* recordChanges;
          const project = yield* projects.create({ name: "Ромашка" });
          const created = yield* calls.create({ projectId: project.id });

          // Patches made from the same stale copy keep each other's keys.
          yield* calls.patchSummary(created.id, {
            participants: "Ольга, Игорь",
            summary: "processing",
          });
          yield* calls.patchSummary(created.id, { summary: "processing" });
          yield* calls.patchSummary(created.id, {
            proposals: { p1: { decision: "accepted" } },
          });
          yield* calls.patchSummary(created.id, {
            proposals: { p2: { decision: "rejected", text: "нет" } },
          });
          const patched = yield* calls.patchSummary(created.id, {
            proposals: { p2: { text: null } },
            summary: "ready",
          });
          assert.deepStrictEqual(patched.summary, {
            participants: "Ольга, Игорь",
            proposals: {
              p1: { decision: "accepted" },
              p2: { decision: "rejected" },
            },
            summary: "ready",
          });
          assert.deepStrictEqual(yield* calls.get(created.id), patched);
          const changes = yield* readChanges;
          assert.deepStrictEqual(changes.at(-1), {
            change: "updated",
            entity: "call",
            id: created.id,
            projectId: project.id,
          });

          const cleared = yield* calls.patchSummary(created.id, null);
          assert.strictEqual(cleared.summary, null);
          assert.strictEqual(
            yield* failureKind(calls.patchSummary("missing", { a: 1 })),
            "NotFound"
          );
        })
      )
    );

    it.effect("changes only the shortcuts a patch names", () =>
      run(
        Effect.gen(function* () {
          const settings = yield* SettingsData;
          const before = (yield* settings.get).shortcuts as {
            [action: string]: string[];
          };
          // Two windows each change one shortcut.
          yield* settings.update({ shortcuts: { "mark-asked": ["⌃", "M"] } });
          const result = yield* settings.update({
            shortcuts: { "hide-question": ["⌃", "H"] },
          });
          assert.deepStrictEqual(result.settings.shortcuts, {
            ...before,
            "hide-question": ["⌃", "H"],
            "mark-asked": ["⌃", "M"],
          });
        })
      )
    );
  });

  describe(`${name}: notes, documents and the brief state`, () => {
    it.effect("keeps the notes and starts without a brief", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const project = yield* projects.create({
            name: "Ромашка",
            notes: "  Решает CEO  ",
          });
          assert.strictEqual(project.notes, "Решает CEO");
          assert.strictEqual(project.briefState, "none");
          assert.strictEqual(project.briefBuiltAt, null);
          assert.isFalse(project.briefTruncated);
          const updated = yield* projects.update(project.id, {
            notes: "Бюджет отдельно",
          });
          assert.strictEqual(updated.notes, "Бюджет отдельно");
          assert.strictEqual(
            (yield* projects.update(project.id, { name: "Р" })).notes,
            "Бюджет отдельно"
          );
        })
      )
    );

    it.effect("caps the notes and the description, and writes nothing", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const readChanges = yield* recordChanges;
          // Exactly at the limit, counted after trimming, in characters.
          const project = yield* projects.create({
            description: ` ${"д".repeat(DESCRIPTION_MAX_CHARS)} `,
            name: "Ромашка",
            notes: `${"🙂".repeat(NOTES_MAX_CHARS)}\n`,
          });
          assert.strictEqual(
            charCount(project.description),
            DESCRIPTION_MAX_CHARS
          );
          assert.strictEqual(charCount(project.notes), NOTES_MAX_CHARS);
          const before = (yield* readChanges).length;

          const failure = (effect: Effect.Effect<unknown, BackendError>) =>
            Effect.map(Effect.flip(effect), (error) => [
              error.kind,
              error.message,
            ]);
          const longNotes = "з".repeat(NOTES_MAX_CHARS + 1);
          const longDescription = "о".repeat(DESCRIPTION_MAX_CHARS + 1);
          assert.deepStrictEqual(
            yield* failure(projects.update(project.id, { notes: longNotes })),
            ["Invalid", NOTES_TOO_LONG]
          );
          assert.deepStrictEqual(
            yield* failure(
              projects.update(project.id, { description: longDescription })
            ),
            ["Invalid", DESCRIPTION_TOO_LONG]
          );
          const count = (yield* projects.list).length;
          assert.deepStrictEqual(
            yield* failure(
              projects.create({ name: "Длинный", notes: longNotes })
            ),
            ["Invalid", NOTES_TOO_LONG]
          );
          assert.deepStrictEqual(
            yield* failure(
              projects.create({
                description: longDescription,
                name: "Длинный",
              })
            ),
            ["Invalid", DESCRIPTION_TOO_LONG]
          );
          assert.strictEqual((yield* projects.list).length, count);
          assert.strictEqual((yield* readChanges).length, before);
          assert.strictEqual(
            charCount((yield* projects.get(project.id)).notes),
            NOTES_MAX_CHARS
          );
        })
      )
    );

    it.effect("reads a brief given by hand as outdated", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const project = yield* projects.create({
            brief: { product: "Запись" },
            name: "Ромашка",
          });
          assert.strictEqual(project.briefState, "outdated");
          assert.isNumber(project.briefBuiltAt);
          const cleared = yield* projects.update(project.id, { brief: null });
          assert.strictEqual(cleared.briefState, "none");
          assert.strictEqual(cleared.briefBuiltAt, null);
        })
      )
    );

    it.effect(
      "adds documents once, turns away other types, tells the project",
      () =>
        run(
          Effect.gen(function* () {
            const projects = yield* ProjectsData;
            const sources = yield* ProjectSourcesData;
            const project = yield* projects.create({ name: "Ромашка" });
            const readChanges = yield* recordChanges;

            const results = yield* sources.add(project.id, [
              "/Users/dima/ТЗ.docx",
              "/Users/dima/смета.xlsx",
              "/Users/dima/скан договора.pdf",
            ]);
            assert.deepStrictEqual(
              results.map((item) => [item.name, item.result.outcome]),
              [
                ["ТЗ.docx", "added"],
                ["смета.xlsx", "rejected"],
                ["скан договора.pdf", "added"],
              ]
            );
            const [added, rejected, scan] = results.map((item) => item.result);
            assert.deepStrictEqual(rejected, {
              message: "Поддерживаются .md, .txt, .pdf и .docx",
              outcome: "rejected",
              reason: "unsupportedType",
            });
            assert.strictEqual(
              scan?.outcome === "added" ? scan.source.status : undefined,
              "noText"
            );
            const again = yield* sources.add(project.id, ["/tmp/ТЗ.docx"]);
            assert.strictEqual(again[0]?.result.outcome, "duplicate");
            assert.deepStrictEqual(
              (yield* sources.list(project.id)).map((source) => source.name),
              ["ТЗ.docx", "скан договора.pdf"]
            );
            assert.deepStrictEqual(
              (yield* readChanges).map(({ change, entity }) => [
                entity,
                change,
              ]),
              [
                ["project", "updated"],
                ["project", "updated"],
              ]
            );

            assert.strictEqual(added?.outcome, "added");
            const docId = added?.outcome === "added" ? added.source.id : "";
            yield* sources.remove(docId);
            assert.strictEqual(
              yield* failureKind(sources.remove(docId)),
              "NotFound"
            );
            assert.strictEqual(
              yield* failureKind(sources.add("nope", ["/a.md"])),
              "NotFound"
            );

            yield* projects.remove(project.id);
            assert.strictEqual(
              yield* failureKind(sources.list(project.id)),
              "NotFound"
            );
          })
        )
    );
  });

  describe(`${name}: changes and settings`, () => {
    it.effect("tells about every write, with its project", () =>
      run(
        Effect.gen(function* () {
          const projects = yield* ProjectsData;
          const people = yield* PeopleData;
          const calls = yield* CallsData;
          const readChanges = yield* recordChanges;

          const project = yield* projects.create({ name: "Ромашка" });
          const person = yield* people.create({
            name: "Анна",
            projectId: project.id,
          });
          const created = yield* calls.create({ projectId: project.id });
          yield* calls.addParticipant(created.id, person.id);
          yield* people.update(person.id, { role: "CEO" });
          yield* people.remove(person.id);

          const changes = yield* readChanges;
          assert.deepStrictEqual(
            changes.map(({ change, entity, id, projectId }) => [
              entity,
              change,
              id,
              projectId,
            ]),
            [
              ["project", "created", project.id, project.id],
              // A person's write tells about the project too: its brief
              // is built from its people.
              ["person", "created", person.id, project.id],
              ["project", "updated", project.id, project.id],
              ["call", "created", created.id, project.id],
              ["call", "updated", created.id, project.id],
              ["person", "updated", person.id, project.id],
              ["project", "updated", project.id, project.id],
              ["person", "deleted", person.id, project.id],
              ["project", "updated", project.id, project.id],
            ]
          );
          // The person left the call with their record.
          assert.deepStrictEqual(
            (yield* calls.get(created.id)).participantIds,
            []
          );
        })
      )
    );

    it.effect("merges stored settings over the defaults Rust acts on", () =>
      run(
        Effect.gen(function* () {
          const settings = yield* SettingsData;
          const defaults = yield* settings.get;
          assert.strictEqual(defaults.onboardingCompleted, false);
          assert.strictEqual(defaults.launchAtLogin, true);

          const result = yield* settings.update({
            launchAtLogin: false,
            theme: "dark",
          });
          assert.strictEqual(result.settings.launchAtLogin, false);
          assert.strictEqual(result.settings.theme, "dark");
          assert.deepStrictEqual(result.shortcutErrors, []);
          assert.deepStrictEqual(yield* settings.get, result.settings);

          assert.strictEqual(
            yield* failureKind(settings.update({ hideOnShare: "yes" })),
            "Invalid"
          );
          yield* settings.completeOnboarding;
          assert.strictEqual((yield* settings.get).onboardingCompleted, true);
        })
      )
    );
  });
}

/*
 * The contract of the post-call records (post-call design.md, decisions
 * 5–12; `src-tauri/src/storage/{summaries,proposals,call_records,
 * call_search}.rs`). Rust has no commands that write a transcript or a
 * proposal from a window, so these run on the demo records the mock
 * starts with: the Телемедиа call of 19 October (`DEMO_CALL_ID`).
 */
function postCallContract(
  name: string,
  layer: Layer.Layer<DataServices | MockDatabase, never, never>
) {
  const run = <A, E>(
    effect: Effect.Effect<A, E, DataServices | MockDatabase>
  ) => effect.pipe(Effect.provide(layer));

  /** A finished call of a new project, without any records. */
  const finishedCall = Effect.gen(function* () {
    const projects = yield* ProjectsData;
    const calls = yield* CallsData;
    const project = yield* projects.create({ name: "Ромашка" });
    const created = yield* calls.create({ projectId: project.id });
    const finished = yield* calls.update(created.id, {
      endedAt: (created.startedAt ?? 0) + 60_000,
      status: "finished",
    });
    return { call: finished, project };
  });

  /** Starts recording `SummaryProgress`; the effect reads them so far. */
  const recordProgress = Effect.gen(function* () {
    const seen: SummaryProgress[] = [];
    const summaries = yield* SummaryData;
    yield* Effect.forkChild(
      Stream.runForEach(summaries.progress, (item) =>
        Effect.sync(() => seen.push(item))
      ),
      { startImmediately: true }
    );
    return Effect.as(Effect.yieldNow, seen);
  });

  describe(`${name}: summaries`, () => {
    it.effect("reads the demo summary, saved and ready", () =>
      run(
        Effect.gen(function* () {
          const summaries = yield* SummaryData;
          const view = yield* summaries.get(DEMO_CALL_ID);
          assert.strictEqual(view.building, null);
          assert.strictEqual(view.summary?.state, "ready");
          assert.strictEqual(view.summary?.transcriptPass, "refined");
          const content = view.summary?.content;
          assert.deepStrictEqual(
            content?.topics.map((topic) => topic.title),
            ["Приём звонков", "Интеграция с CRM"]
          );
          assert.strictEqual(content?.cards.length, 2);
          // Every quote says where it is: the windows need not look it up.
          const [first] = content?.topics[0]?.points[0]?.evidence ?? [];
          assert.isDefined(first);
          assert.isTrue((first?.startMs ?? -1) >= 0);
          assert.strictEqual(
            yield* failureKind(summaries.get("nope")),
            "NotFound"
          );
        })
      )
    );

    it.effect(
      "reads a live call as none and a finished one as interrupted",
      () =>
        run(
          Effect.gen(function* () {
            const summaries = yield* SummaryData;
            const calls = yield* CallsData;
            const { call: finished, project } = yield* finishedCall;
            const live = yield* calls.create({ projectId: project.id });
            assert.strictEqual((yield* summaries.get(live.id)).summary, null);
            const failed = (yield* summaries.get(finished.id)).summary;
            assert.strictEqual(failed?.state, "failed");
            assert.strictEqual(failed?.error, "interrupted");
            assert.strictEqual(failed?.content, null);
            assert.strictEqual(
              yield* failureKind(summaries.build(live.id)),
              "Invalid"
            );
          })
        )
    );

    it.effect("builds through the stages of Rust and saves at the end", () =>
      run(
        Effect.gen(function* () {
          const summaries = yield* SummaryData;
          const calls = yield* CallsData;
          const proposals = yield* ProposalsData;
          const records = yield* CallRecordsData;
          const { call: finished, project } = yield* finishedCall;
          const readProgress = yield* recordProgress;
          const readChanges = yield* recordChanges;

          yield* summaries.build(finished.id);
          // A second start while it runs does nothing.
          yield* summaries.build(finished.id);
          const building = yield* summaries.get(finished.id);
          assert.strictEqual(building.summary?.state, "building");
          assert.strictEqual(building.building?.stage, "transcript");

          yield* TestClock.adjust(MOCK_STAGE_MS * 5);
          const progress = yield* readProgress;
          assert.deepStrictEqual(
            progress.map((item) => [item.stage, item.state.status]),
            [
              ["transcript", "running"],
              ["transcript", "done"],
              ["summary", "running"],
              ["summary", "done"],
              ["proposals", "running"],
              ["proposals", "done"],
              ["saving", "running"],
              ["saving", "done"],
            ]
          );
          assert.strictEqual(progress[0]?.counts, null);
          const last = progress.at(-1);
          assert.isTrue((last?.counts?.segments ?? 0) > 0);
          assert.strictEqual(last?.counts?.proposals, 7);

          const view = yield* summaries.get(finished.id);
          assert.strictEqual(view.building, null);
          assert.strictEqual(view.summary?.state, "ready");
          // The call without a title is named after its summary.
          assert.strictEqual(
            (yield* calls.get(finished.id)).title,
            view.summary?.title
          );
          const listed = yield* proposals.list(finished.id);
          assert.strictEqual(listed.length, 7);
          assert.isTrue(listed.every((item) => item.decision === "pending"));
          assert.strictEqual(
            (yield* records.cards(finished.id)).source,
            "summary"
          );
          const recorded = yield* records.transcript(finished.id);
          assert.strictEqual(recorded.length, 1);
          // The saved moments point at that recording, so they have times.
          const recordingIds = new Set(
            (view.summary?.content?.topics ?? []).flatMap((topic) => [
              topic.from.recordingId,
              topic.to.recordingId,
              ...topic.points.flatMap((point) =>
                point.evidence.map((item) => item.recordingId)
              ),
            ])
          );
          assert.deepStrictEqual([...recordingIds], [recorded[0]?.id]);
          // `building`, then the saved summary: the call's writes.
          assert.deepStrictEqual(
            (yield* readChanges).map((change) => [change.entity, change.id]),
            [
              ["call", finished.id],
              ["call", finished.id],
            ]
          );
          assert.strictEqual(project.id, finished.projectId);
        })
      )
    );

    it.effect("keeps the decided proposals and the summary on a rebuild", () =>
      run(
        Effect.gen(function* () {
          const summaries = yield* SummaryData;
          const proposals = yield* ProposalsData;
          const before = yield* proposals.list(DEMO_CALL_ID);
          const decided = before.filter((item) => item.decision !== "pending");
          yield* summaries.build(DEMO_CALL_ID);
          // A rebuild keeps the saved summary while it runs.
          const running = yield* summaries.get(DEMO_CALL_ID);
          assert.strictEqual(running.summary?.state, "building");
          assert.isNotNull(running.summary?.content ?? null);
          yield* TestClock.adjust(MOCK_STAGE_MS * 5);
          const after = yield* proposals.list(DEMO_CALL_ID);
          for (const item of decided) {
            assert.deepStrictEqual(
              after.find((known) => known.id === item.id),
              item
            );
          }
          // The pending ones are new, the decided ones not proposed again.
          const pending = after.filter((item) => item.decision === "pending");
          assert.strictEqual(pending.length, before.length - decided.length);
          assert.isTrue(
            pending.every((item) => !before.some((old) => old.id === item.id))
          );
        })
      )
    );

    it.effect("stops a build: cancelled, failed, the old summary stays", () =>
      run(
        Effect.gen(function* () {
          const summaries = yield* SummaryData;
          const readProgress = yield* recordProgress;
          const saved = (yield* summaries.get(DEMO_CALL_ID)).summary;
          yield* summaries.build(DEMO_CALL_ID);
          yield* TestClock.adjust(MOCK_STAGE_MS);
          yield* summaries.cancel(DEMO_CALL_ID);
          yield* TestClock.adjust(MOCK_STAGE_MS * 5);
          const last = (yield* readProgress).at(-1);
          assert.strictEqual(last?.stage, "summary");
          assert.strictEqual(last?.state.status, "cancelled");
          const view = yield* summaries.get(DEMO_CALL_ID);
          assert.strictEqual(view.building, null);
          assert.strictEqual(view.summary?.state, "failed");
          assert.strictEqual(view.summary?.error, "cancelled");
          assert.deepStrictEqual(view.summary?.content, saved?.content);
        })
      )
    );
  });

  describe(`${name}: proposals`, () => {
    it.effect("lists a call's proposals and a person's pending ones", () =>
      run(
        Effect.gen(function* () {
          const proposals = yield* ProposalsData;
          const listed = yield* proposals.list(DEMO_CALL_ID);
          assert.deepStrictEqual(
            listed.map((item) => [item.id, item.decision]),
            [
              ["operators", "accepted"],
              ["channels", "pending"],
              ["crm", "pending"],
              ["understanding", "pending"],
              ["temper", "rejected"],
              ["role", "accepted"],
              ["tech", "pending"],
            ]
          );
          assert.deepStrictEqual(
            (yield* proposals.forPerson("igor")).map((item) => item.id),
            ["tech"]
          );
          assert.strictEqual(
            yield* failureKind(proposals.list("nope")),
            "NotFound"
          );
          assert.strictEqual(
            yield* failureKind(proposals.forPerson("nope")),
            "NotFound"
          );
        })
      )
    );

    it.effect("applies an accepted profile proposal and undoes it", () =>
      run(
        Effect.gen(function* () {
          const proposals = yield* ProposalsData;
          const people = yield* PeopleData;
          const before = yield* people.get("igor");
          const readChanges = yield* recordChanges;

          const accepted = yield* proposals.decide("tech", {
            decision: "accepted",
            edited: "  Сразу про API  ",
          });
          assert.strictEqual(accepted.decision, "accepted");
          assert.strictEqual(accepted.edited, "Сразу про API");
          assert.isNotNull(accepted.decidedAt);
          assert.deepStrictEqual(accepted.applied, {
            previous: (before.profile as { howToAsk: string }).howToAsk,
            written: "Сразу про API",
          });
          const changed = yield* people.get("igor");
          assert.strictEqual(
            (changed.profile as { howToAsk: string }).howToAsk,
            "Сразу про API"
          );
          assert.deepStrictEqual(
            (yield* readChanges).map((change) => [change.entity, change.id]),
            [
              ["person", "igor"],
              ["project", "telemedia"],
              ["call", DEMO_CALL_ID],
            ]
          );
          assert.strictEqual(
            yield* failureKind(
              proposals.decide("tech", { decision: "rejected" })
            ),
            "Invalid"
          );

          const pending = yield* proposals.undo("tech");
          assert.strictEqual(pending.decision, "pending");
          assert.strictEqual(pending.applied, null);
          assert.strictEqual(pending.decidedAt, null);
          assert.deepStrictEqual(
            (yield* people.get("igor")).profile,
            before.profile
          );
        })
      )
    );

    it.effect("refuses to undo a field changed after it was accepted", () =>
      run(
        Effect.gen(function* () {
          const proposals = yield* ProposalsData;
          const people = yield* PeopleData;
          yield* proposals.decide("tech", { decision: "accepted" });
          const igor = yield* people.get("igor");
          yield* people.update("igor", {
            profile: { ...(igor.profile as object), howToAsk: "По-другому" },
          });
          const exit = yield* Effect.exit(proposals.undo("tech"));
          assert.isTrue(Exit.isFailure(exit));
          assert.include(JSON.stringify(exit), CHANGED_SINCE);
          assert.strictEqual(
            (yield* proposals.list(DEMO_CALL_ID)).find(
              (item) => item.id === "tech"
            )?.decision,
            "accepted"
          );
          assert.strictEqual(
            ((yield* people.get("igor")).profile as { howToAsk: string })
              .howToAsk,
            "По-другому"
          );
        })
      )
    );

    it.effect("writes an accepted brief proposal into the notes", () =>
      run(
        Effect.gen(function* () {
          const proposals = yield* ProposalsData;
          const projects = yield* ProjectsData;
          const before = yield* projects.get("telemedia");
          assert.strictEqual(before.briefState, "fresh");
          const accepted = yield* proposals.decide("channels", {
            decision: "accepted",
          });
          const after = yield* projects.get("telemedia");
          const line = accepted.applied?.written;
          assert.strictEqual(line, `- 19.10.2026: ${accepted.after}`);
          assert.strictEqual(after.notes, `${before.notes}\n${line}`);
          // The notes are an input of the brief.
          assert.strictEqual(after.briefState, "outdated");

          yield* proposals.undo("channels");
          assert.strictEqual(
            (yield* projects.get("telemedia")).notes,
            before.notes
          );
          // The seeded accepted one removes its own line and the section.
          yield* proposals.undo("operators");
          assert.strictEqual((yield* projects.get("telemedia")).notes, "");
        })
      )
    );

    it.effect(
      "refuses notes over the limit, a bad level and changes nothing",
      () =>
        run(
          Effect.gen(function* () {
            const proposals = yield* ProposalsData;
            const projects = yield* ProjectsData;
            const { tables } = yield* MockDatabase;
            yield* projects.update("telemedia", {
              notes: "я".repeat(NOTES_MAX_CHARS - 10),
            });
            const readChanges = yield* recordChanges;
            assert.strictEqual(
              yield* failureKind(
                proposals.decide("channels", { decision: "accepted" })
              ),
              "Invalid"
            );
            const tech = tables.proposals.get("tech");
            assert.isDefined(tech);
            if (tech) {
              tables.proposals.set("tech", { ...tech, field: "tech" });
            }
            assert.strictEqual(
              yield* failureKind(
                proposals.decide("tech", { decision: "accepted", edited: "7" })
              ),
              "Invalid"
            );
            assert.strictEqual(
              yield* failureKind(
                proposals.decide("tech", {
                  decision: "accepted",
                  edited: "   ",
                })
              ),
              "Invalid"
            );
            const level = yield* proposals.decide("tech", {
              decision: "accepted",
              edited: "4",
            });
            assert.deepStrictEqual(level.applied?.written, 4);
            // Only the last decision wrote anything.
            assert.deepStrictEqual(
              (yield* readChanges).map((change) => change.entity),
              ["person", "project", "call"]
            );
            const listed = yield* proposals.list(DEMO_CALL_ID);
            assert.strictEqual(
              listed.find((item) => item.id === "channels")?.decision,
              "pending"
            );
          })
        )
    );

    it.effect("rejects without changing anything else", () =>
      run(
        Effect.gen(function* () {
          const proposals = yield* ProposalsData;
          const people = yield* PeopleData;
          const olga = yield* people.get("olga");
          const rejected = yield* proposals.decide("understanding", {
            decision: "rejected",
          });
          assert.strictEqual(rejected.decision, "rejected");
          assert.strictEqual(rejected.applied, null);
          assert.deepStrictEqual(yield* people.get("olga"), olga);
          assert.strictEqual(
            yield* failureKind(
              proposals.decide("understanding", { decision: "pending" })
            ),
            "Invalid"
          );
          assert.strictEqual(
            (yield* proposals.undo("understanding")).decision,
            "pending"
          );
          assert.strictEqual(
            yield* failureKind(proposals.undo("understanding")),
            "Invalid"
          );
          assert.strictEqual(
            yield* failureKind(proposals.undo("nope")),
            "NotFound"
          );
        })
      )
    );
  });

  describe(`${name}: call records`, () => {
    it.effect("reads the recordings, questions and cards of a call", () =>
      run(
        Effect.gen(function* () {
          const records = yield* CallRecordsData;
          const [recording, ...others] =
            yield* records.transcript(DEMO_CALL_ID);
          assert.deepStrictEqual(others, []);
          assert.strictEqual(recording?.pass, "refined");
          assert.strictEqual(recording?.audioDeleted, false);
          const starts = recording?.segments.map((item) => item.startMs) ?? [];
          assert.deepStrictEqual(
            starts,
            [...starts].sort((a, b) => a - b)
          );

          const questions = yield* records.questions(DEMO_CALL_ID);
          const answered = questions.find((item) => item.id === "operators");
          assert.strictEqual(answered?.status, "answered");
          assert.strictEqual(answered?.answer?.segmentId, "t-120415");
          assert.strictEqual(answered?.moment?.recordingId, recording?.id);

          const cards = yield* records.cards(DEMO_CALL_ID);
          assert.strictEqual(cards.source, "summary");
          assert.strictEqual(cards.next.length, 3);

          const { call: fresh } = yield* finishedCall;
          assert.deepStrictEqual(yield* records.cards(fresh.id), {
            cards: [],
            next: [],
            source: "live",
          });
          assert.deepStrictEqual(yield* records.transcript(fresh.id), []);
          const unknown: Effect.Effect<unknown, BackendError>[] = [
            records.transcript("nope"),
            records.questions("nope"),
            records.cards("nope"),
          ];
          for (const read of unknown) {
            assert.strictEqual(yield* failureKind(read), "NotFound");
          }
        })
      )
    );

    it.effect("accepts and renames a card of the summary", () =>
      run(
        Effect.gen(function* () {
          const records = yield* CallRecordsData;
          const readChanges = yield* recordChanges;
          const accepted = yield* records.updateCard(DEMO_CALL_ID, "calls", {
            decision: "accepted",
          });
          assert.strictEqual(accepted.decision, "accepted");
          assert.strictEqual(accepted.title, "Приём звонков");
          const renamed = yield* records.updateCard(DEMO_CALL_ID, "calls", {
            title: "  Очередь звонков ",
          });
          assert.strictEqual(renamed.title, "Очередь звонков");
          assert.strictEqual(renamed.decision, "accepted");
          const [card] = (yield* records.cards(DEMO_CALL_ID)).cards;
          assert.deepStrictEqual(card, renamed);
          assert.strictEqual((yield* readChanges).length, 2);
          assert.strictEqual(
            yield* failureKind(
              records.updateCard(DEMO_CALL_ID, "calls", { title: " " })
            ),
            "Invalid"
          );
          assert.strictEqual(
            yield* failureKind(
              records.updateCard(DEMO_CALL_ID, "nope", { decision: "accepted" })
            ),
            "NotFound"
          );
        })
      )
    );

    it.effect("deletes the audio and keeps the transcript", () =>
      run(
        Effect.gen(function* () {
          const records = yield* CallRecordsData;
          const calls = yield* CallsData;
          const { project } = yield* finishedCall;
          const live = yield* calls.create({ projectId: project.id });
          assert.strictEqual(
            yield* failureKind(records.deleteAudio(live.id)),
            "Invalid"
          );
          const [recording] = yield* records.transcript(DEMO_CALL_ID);
          const id = recording?.id ?? "";
          assert.strictEqual((yield* records.peaks(id, 100)).me.length, 100);
          assert.strictEqual(
            yield* failureKind(records.peaks(id, 0)),
            "Invalid"
          );
          assert.strictEqual(
            yield* failureKind(records.peaks(id, 2001)),
            "Invalid"
          );

          const readChanges = yield* recordChanges;
          yield* records.deleteAudio(DEMO_CALL_ID);
          yield* records.deleteAudio(DEMO_CALL_ID);
          const [deleted] = yield* records.transcript(DEMO_CALL_ID);
          assert.strictEqual(deleted?.audioDeleted, true);
          assert.strictEqual(deleted?.meBytes, null);
          assert.deepStrictEqual(deleted?.segments, recording?.segments);
          assert.strictEqual(
            yield* failureKind(records.peaks(id, 100)),
            "NotFound"
          );
          // Only the first one deleted anything.
          assert.strictEqual((yield* readChanges).length, 1);
        })
      )
    );

    it.effect("reads the history's row of every call in one overview", () =>
      run(
        Effect.gen(function* () {
          const calls = yield* CallsData;
          const records = yield* CallRecordsData;
          const proposals = yield* ProposalsData;
          const summaries = yield* SummaryData;
          const { call: fresh, project } = yield* finishedCall;

          const everyCall = yield* calls.overview(null);
          assert.deepStrictEqual(
            everyCall.map((row) => row.callId),
            (yield* calls.list(null)).map((item) => item.id)
          );
          assert.deepStrictEqual(yield* calls.overview(project.id), [
            {
              audioDeleted: false,
              callId: fresh.id,
              openQuestions: 0,
              pendingProposals: 0,
              projectId: project.id,
              title: "",
            },
          ]);
          assert.deepStrictEqual(yield* calls.overview("nope"), []);

          // The same counts as the call's proposals and questions.
          const demo = everyCall.find((row) => row.callId === DEMO_CALL_ID);
          const pending = (yield* proposals.list(DEMO_CALL_ID)).filter(
            (item) => item.decision === "pending"
          );
          assert.isAbove(pending.length, 0);
          assert.strictEqual(demo?.pendingProposals, pending.length);
          const notClosed = (yield* records.questions(DEMO_CALL_ID)).filter(
            (item) => item.status === "open" || item.status === "asked"
          );
          assert.strictEqual(demo?.openQuestions, notClosed.length);
          assert.strictEqual(demo?.audioDeleted, false);

          yield* proposals.decide(pending[0]?.id ?? "", {
            decision: "rejected",
          });
          yield* records.deleteAudio(DEMO_CALL_ID);
          // Without its own title, the call is named after its summary.
          yield* calls.update(DEMO_CALL_ID, { title: "" });
          const { summary } = yield* summaries.get(DEMO_CALL_ID);
          const after = (yield* calls.overview(null)).find(
            (row) => row.callId === DEMO_CALL_ID
          );
          assert.strictEqual(after?.pendingProposals, pending.length - 1);
          assert.strictEqual(after?.audioDeleted, true);
          assert.isNotEmpty(summary?.title ?? "");
          assert.strictEqual(after?.title, summary?.title);
        })
      )
    );

    it.effect(
      "deletes a call's records with it, a person's proposals with them",
      () =>
        run(
          Effect.gen(function* () {
            const calls = yield* CallsData;
            const people = yield* PeopleData;
            const proposals = yield* ProposalsData;
            const summaries = yield* SummaryData;
            const { tables } = yield* MockDatabase;
            yield* people.remove("igor");
            assert.isFalse(
              [...tables.proposals.values()].some(
                (item) => item.personId === "igor"
              )
            );
            yield* calls.remove(DEMO_CALL_ID);
            assert.strictEqual(
              yield* failureKind(summaries.get(DEMO_CALL_ID)),
              "NotFound"
            );
            assert.strictEqual(
              yield* failureKind(proposals.list(DEMO_CALL_ID)),
              "NotFound"
            );
            assert.isFalse(
              [...tables.recordings.values()].some(
                (item) => item.callId === DEMO_CALL_ID
              )
            );
            assert.strictEqual(tables.summaries.has(DEMO_CALL_ID), false);
          })
        )
    );
  });

  describe(`${name}: search`, () => {
    it.effect("finds a term in titles, transcripts and summaries", () =>
      run(
        Effect.gen(function* () {
          const calls = yield* CallsData;
          const found = yield* calls.search("AMOCRM", null);
          const demo = found.matches.filter(
            (item) => item.callId === DEMO_CALL_ID
          );
          const segment = demo.find((item) => item.source === "segment");
          assert.strictEqual(segment?.text, "amoCRM");
          assert.strictEqual(segment?.channel, "others");
          assert.strictEqual(segment?.moment?.segmentId, "t-122108");
          assert.isNotNull(segment?.at ?? null);
          assert.isTrue(demo.some((item) => item.source === "tldr"));
          assert.isTrue(demo.some((item) => item.source === "fact"));
          // Newest call first; within it the title, transcript, summary.
          const order = ["title", "segment", "tldr", "point", "fact"];
          const ranks = demo.map((item) => order.indexOf(item.source));
          assert.deepStrictEqual(
            ranks,
            [...ranks].sort((a, b) => a - b)
          );
          assert.strictEqual(found.total, found.matches.length);
          assert.deepStrictEqual(
            found.projects.map((item) => [item.projectId, item.calls]),
            [
              ["lapa", 1],
              ["telemedia", 3],
            ]
          );
        })
      )
    );

    it.effect(
      "ignores case and «ё», and keeps the counts of every project",
      () =>
        run(
          Effect.gen(function* () {
            const calls = yield* CallsData;
            const yo = yield* calls.search("ВСЁ  операторы", null);
            assert.strictEqual(yo.matches[0]?.text, "все операторы");
            assert.strictEqual(yo.matches[0]?.source, "segment");
            const said = yield* calls.search("пятеро.", null);
            assert.strictEqual(said.matches[0]?.text, "Пятеро");
            const lapa = yield* calls.search("amocrm", "lapa");
            assert.isTrue(
              lapa.matches.every((item) => item.projectId === "lapa")
            );
            assert.strictEqual(lapa.total, 1);
            assert.strictEqual(lapa.projects.length, 2);
            assert.deepStrictEqual(yield* calls.search("  —  ", null), {
              matches: [],
              projects: [],
              total: 0,
            });
          })
        )
    );
  });
}

dataContract("DataLayerMock", DataLayerMock);
postCallContract("DataLayerMock", DataLayerMock);

describe("SettingsData.layerMock", () => {
  it.effect("refuses ⌘ Space like a shortcut another app holds", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsData;
      const before = (yield* settings.get).shortcuts as {
        [action: string]: string[];
      };
      const result = yield* settings.update({
        shortcuts: {
          ...before,
          "toggle-call": ["⌘", "Space"],
          "toggle-overlay": ["⌥", "⌘", "K"],
        },
      });
      const after = result.settings.shortcuts as {
        [action: string]: string[];
      };
      assert.deepStrictEqual(after["toggle-call"], before["toggle-call"]);
      assert.deepStrictEqual(after["toggle-overlay"], ["⌥", "⌘", "K"]);
      assert.deepStrictEqual(
        result.shortcutErrors.map((error) => error.action),
        ["toggle-call"]
      );
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect("starts from the demo records", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectsData;
      const listed = yield* projects.list;
      assert.deepStrictEqual(
        listed.map((project) => project.id),
        ["telemedia", "lapa", "logistic-pro", "rhythm"]
      );
    }).pipe(Effect.provide(DataLayerMock))
  );
});
