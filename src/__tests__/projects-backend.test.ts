import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import { MockDatabase } from "@/data/services/mock-database";
import { PeopleData } from "@/data/services/people";
import { ProjectsData } from "@/data/services/projects";
import {
  BRIEF_BUILD_STAGES,
  ProjectsBackend,
} from "@/features/projects/backend";

const BackendMock = ProjectsBackend.layerMock.pipe(
  Layer.provideMerge(MockDatabase.layer)
);

describe("ProjectsBackend.layerMock", () => {
  it.effect("emits every brief build stage in order", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(backend.buildBrief("telemedia"))
      );
      yield* TestClock.adjust("5 seconds");
      const stages = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        Array.from(stages),
        Array.from({ length: BRIEF_BUILD_STAGES }, (_, index) => index + 1)
      );
    }).pipe(Effect.provide(BackendMock))
  );

  it.effect("exports markdown into the Grill folder", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const fiber = yield* Effect.forkChild(
        backend.exportMarkdown("brief", { id: "telemedia", name: "Телемедиа" })
      );
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(fiber), "Документы / Grill");
    }).pipe(Effect.provide(BackendMock))
  );
});

describe("ProjectsBackend.layerMock over the mock database", () => {
  const MockServices = Layer.mergeAll(
    ProjectsBackend.layerMock,
    PeopleData.layerMock,
    ProjectsData.layerMock
  ).pipe(Layer.provideMerge(MockDatabase.layer));

  it.effect("writes a fresh brief; a person added makes it outdated", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const projects = yield* ProjectsData;
      const people = yield* PeopleData;
      const project = yield* projects.create({
        description: "Запись к врачу",
        name: "Ромашка",
      });
      const fiber = yield* Effect.forkChild(backend.refreshBrief(project.id));
      yield* TestClock.adjust("1 second");
      assert.strictEqual(
        (yield* projects.get(project.id)).briefState,
        "building"
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);

      const built = yield* projects.get(project.id);
      assert.strictEqual(built.briefState, "fresh");
      assert.include(
        (built.brief as { product: string }).product,
        "собран без агента: описание"
      );
      // The name is not what the brief is built from.
      yield* projects.update(project.id, { name: "Ромашка Плюс" });
      assert.strictEqual((yield* projects.get(project.id)).briefState, "fresh");

      const person = yield* people.create({
        name: "Ольга",
        projectId: project.id,
      });
      assert.strictEqual(
        (yield* projects.get(project.id)).briefState,
        "outdated"
      );
      // Back as it was: fresh again.
      yield* people.remove(person.id);
      assert.strictEqual((yield* projects.get(project.id)).briefState, "fresh");
    }).pipe(Effect.provide(MockServices))
  );

  it.effect("keeps the old brief when the build is stopped", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const projects = yield* ProjectsData;
      const before = yield* projects.get("telemedia");
      const fiber = yield* Effect.forkChild(backend.refreshBrief("telemedia"));
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.interrupt(fiber);
      const after = yield* projects.get("telemedia");
      assert.deepStrictEqual(after.brief, before.brief);
      assert.strictEqual(after.briefState, "fresh");
    }).pipe(Effect.provide(MockServices))
  );

  it.effect("refreshes an outdated brief before a call, not a fresh one", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const projects = yield* ProjectsData;
      assert.isFalse(yield* backend.prepareBrief("telemedia"));
      yield* projects.update("telemedia", { notes: "Срок 1 декабря" });
      assert.strictEqual(
        (yield* projects.get("telemedia")).briefState,
        "outdated"
      );
      assert.isTrue(yield* backend.prepareBrief("telemedia"));
      assert.strictEqual(
        (yield* projects.get("telemedia")).briefState,
        "building"
      );
      // One build per project.
      assert.isFalse(yield* backend.prepareBrief("telemedia"));
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(
        (yield* projects.get("telemedia")).briefState,
        "fresh"
      );
    }).pipe(Effect.provide(MockServices))
  );

  it.effect("fails without materials", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const projects = yield* ProjectsData;
      const project = yield* projects.create({ name: "Пусто" });
      const exit = yield* Effect.exit(backend.refreshBrief(project.id));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual((yield* projects.get(project.id)).briefState, "none");
    }).pipe(Effect.provide(MockServices))
  );
});
