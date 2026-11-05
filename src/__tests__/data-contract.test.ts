import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, type Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { DataChanged } from "@/bindings";
import {
  charCount,
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_TOO_LONG,
  NOTES_MAX_CHARS,
  NOTES_TOO_LONG,
} from "@/data/project-limits";
import { CallsData } from "@/data/services/calls";
import { DataEvents } from "@/data/services/data-events";
import { DataLayerMock } from "@/data/services/layers";
import { PeopleData } from "@/data/services/people";
import { ProjectsData } from "@/data/services/projects";
import { SettingsData } from "@/data/services/settings";
import { ProjectSourcesData } from "@/data/services/sources";
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
  | CallsData
  | DataEvents
  | PeopleData
  | ProjectsData
  | ProjectSourcesData
  | SettingsData;

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

dataContract("DataLayerMock", DataLayerMock);

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
