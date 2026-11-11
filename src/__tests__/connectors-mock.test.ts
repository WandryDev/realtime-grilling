import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { Connectors, MOCK_CONNECT_DELAY_MS } from "@/data/services/connectors";
import { DataLayerMock } from "@/data/services/layers";
import { ProjectsData } from "@/data/services/projects";
import { ProjectSourcesData } from "@/data/services/sources";

/*
 * `Connectors.layerMock` keeps the Rust contract of connectors-outline
 * (design.md, decision 6) for the browser demo: a refusal names its field
 * and saves nothing, a pick over 200 documents is `Invalid`, a sync
 * brings the picked documents once and leaves the excluded ones out, a
 * disconnect keeps the sources.
 */

const VALID_KEY = "ol_api_x9Pq4Lm2Vb7Nd3Wf8Ht7Xk2";

const connect = (host: string, key: string) =>
  Effect.gen(function* () {
    const connectors = yield* Connectors;
    const fiber = yield* Effect.forkChild(
      connectors.connectApiKey("outline", host, key)
    );
    yield* TestClock.adjust(MOCK_CONNECT_DELAY_MS);
    return yield* Fiber.join(fiber);
  });

const newProject = Effect.gen(function* () {
  const projects = yield* ProjectsData;
  const project = yield* projects.create({ name: "Тест коннекторов" });
  return project.id;
});

const outlineSources = (projectId: string) =>
  ProjectSourcesData.use((sources) => sources.list(projectId)).pipe(
    Effect.map((list) => list.filter((source) => source.origin))
  );

describe("Connectors.layerMock", () => {
  it.effect("refuses a key or an address at its field and saves nothing", () =>
    Effect.gen(function* () {
      const connectors = yield* Connectors;
      yield* connectors.disconnect("outline");

      const key = yield* connect("docs.pixel.agency", "ol_api_short");
      assert.deepStrictEqual(key.rejected?.field, "key");
      const host = yield* connect("http://docs.pixel.agency", VALID_KEY);
      assert.deepStrictEqual(host.rejected, {
        field: "host",
        reason: "Нужен адрес с https",
      });

      const [outline] = yield* connectors.list;
      assert.strictEqual(outline?.status, "disconnected");
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect("connects with the team and trims the address to its root", () =>
    Effect.gen(function* () {
      const outcome = yield* connect(
        "wandry.getoutline.com/doc/brief-AbC123",
        VALID_KEY
      );
      assert.strictEqual(outcome.connected?.status, "connected");
      assert.strictEqual(
        outcome.connected?.account?.host,
        "https://wandry.getoutline.com"
      );
      assert.strictEqual(outcome.connected?.account?.teamName, "Pixel Agency");
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect("refuses a pick over 200 documents before saving it", () =>
    Effect.gen(function* () {
      const connectors = yield* Connectors;
      const projectId = yield* newProject;
      const error = yield* Effect.flip(
        connectors.selectionSet(projectId, "outline", [
          { externalId: "col-archive", itemKind: "container", title: "Архив" },
        ])
      );
      assert.strictEqual(error.kind, "Invalid");
      assert.include(error.message, "340");
      const [view] = yield* connectors.selectionGet(projectId);
      assert.deepStrictEqual(view?.items, []);
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect("syncs a collection once, without its excluded document", () =>
    Effect.gen(function* () {
      const connectors = yield* Connectors;
      const projectId = yield* newProject;
      yield* connectors.selectionSet(projectId, "outline", [
        {
          externalId: "col-telemedia",
          itemKind: "container",
          title: "Телемедиа",
        },
        // Picked again by itself: still one source.
        { externalId: "tm-api", itemKind: "document", title: "API" },
      ]);
      assert.strictEqual((yield* outlineSources(projectId)).length, 12);

      yield* connectors.selectionSet(projectId, "outline", [
        {
          externalId: "col-telemedia",
          itemKind: "container",
          title: "Телемедиа",
        },
        { externalId: "tm-contract", itemKind: "exclude", title: "Договор" },
      ]);
      yield* connectors.sync(projectId, "outline");
      const sources = yield* outlineSources(projectId);
      assert.strictEqual(sources.length, 11);
      assert.isFalse(
        sources.some((source) => source.origin?.externalId === "tm-contract")
      );
      const empty = sources.find((source) => source.name === "Глоссарий");
      assert.strictEqual(empty?.status, "noText");
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect("keeps the sources after a disconnect and says why", () =>
    Effect.gen(function* () {
      const connectors = yield* Connectors;
      const projectId = yield* newProject;
      yield* connectors.selectionSet(projectId, "outline", [
        { externalId: "col-logistics", itemKind: "container", title: "ЛП" },
      ]);
      yield* connectors.disconnect("outline");
      yield* connectors.sync(projectId, "outline");

      assert.strictEqual((yield* outlineSources(projectId)).length, 3);
      const [view] = yield* connectors.selectionGet(projectId);
      assert.isFalse(view?.connected);
      assert.strictEqual(view?.sync?.errorKind, "disconnected");
      const error = yield* Effect.flip(
        ProjectSourcesData.use((sources) =>
          sources.remove(`${projectId}:outline:lp-routes`)
        )
      );
      assert.strictEqual(error.kind, "Invalid");
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect(
    "marks a deleted collection unavailable and drops its documents",
    () =>
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        const projectId = yield* newProject;
        yield* connectors.selectionSet(projectId, "outline", [
          { externalId: "col-lapa", itemKind: "container", title: "Лапа" },
          { externalId: "gone", itemKind: "document", title: "Удалённый" },
        ]);
        const [view] = yield* connectors.selectionGet(projectId);
        const gone = view?.items.find((item) => item.externalId === "gone");
        assert.strictEqual(gone?.status, "unavailable");
        assert.strictEqual((yield* outlineSources(projectId)).length, 5);
      }).pipe(Effect.provide(DataLayerMock))
  );
});
