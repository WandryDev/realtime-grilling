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
const CLICKUP_TOKEN = "pk_4815162_Q7Z2LM8NX4WD9KTR3HB6YC1P";

const connectClickUp = (key: string, workspace: string | null) =>
  Effect.gen(function* () {
    const connectors = yield* Connectors;
    const fiber = yield* Effect.forkChild(
      connectors.connectApiKey("clickup", "", key, workspace)
    );
    yield* TestClock.adjust(MOCK_CONNECT_DELAY_MS);
    return yield* Fiber.join(fiber);
  });

const clickupSources = (projectId: string) =>
  ProjectSourcesData.use((sources) => sources.list(projectId)).pipe(
    Effect.map((list) =>
      list.filter((source) => source.origin?.connector === "clickup")
    )
  );

const connect = (host: string, key: string) =>
  Effect.gen(function* () {
    const connectors = yield* Connectors;
    const fiber = yield* Effect.forkChild(
      connectors.connectApiKey("outline", host, key, null)
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

describe("Connectors.layerMock: ClickUp (connectors-clickup 3.1)", () => {
  it.effect("asks for a workspace, then connects the picked one", () =>
    Effect.gen(function* () {
      const connectors = yield* Connectors;
      yield* connectors.disconnect("clickup");

      const refused = yield* connectClickUp("pk_short", null);
      assert.deepStrictEqual(refused.rejected, {
        field: "key",
        reason: "Токен не подошёл",
      });
      const choose = yield* connectClickUp(CLICKUP_TOKEN, null);
      assert.deepStrictEqual(
        choose.chooseWorkspace?.workspaces.map((item) => item.name),
        ["Pixel Agency", "Личное"]
      );
      const before = (yield* connectors.list).find(
        (view) => view.kind === "clickup"
      );
      assert.strictEqual(before?.status, "disconnected");

      const other = yield* connectClickUp(CLICKUP_TOKEN, "nope");
      assert.strictEqual(
        other.rejected?.reason,
        "Токен не открывает это пространство"
      );
      const outcome = yield* connectClickUp(CLICKUP_TOKEN, "9001");
      assert.strictEqual(outcome.connected?.account?.teamName, "Pixel Agency");
      assert.strictEqual(outcome.connected?.account?.host, null);
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect("browses spaces, folders with their lists, and tasks", () =>
    Effect.gen(function* () {
      const connectors = yield* Connectors;
      const spaces = yield* connectors.browse("clickup", null);
      assert.deepStrictEqual(
        spaces.map((node) => [node.title, node.documentCount]),
        [
          ["Клиенты", 0],
          ["Внутреннее", 0],
        ]
      );
      const inside = yield* connectors.browse("clickup", {
        id: "space:sp-clients",
        kind: "container",
      });
      const [folder, lapa] = inside;
      assert.strictEqual(folder?.title, "Телемедиа");
      assert.strictEqual(folder?.children.length, 2);
      assert.strictEqual(folder?.documentCount, 19);
      assert.strictEqual(lapa?.title, "Ветклиника Лапа");
      const tasks = yield* connectors.browse("clickup", {
        id: "list:ls-tm-1",
        kind: "container",
      });
      assert.strictEqual(tasks[0]?.children.length, 2);
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect("refuses a space over 200 tasks with the ClickUp words", () =>
    Effect.gen(function* () {
      const connectors = yield* Connectors;
      const projectId = yield* newProject;
      const error = yield* Effect.flip(
        connectors.selectionSet(projectId, "clickup", [
          {
            externalId: "space:sp-internal",
            itemKind: "container",
            title: "Внутреннее",
          },
        ])
      );
      assert.strictEqual(error.kind, "Invalid");
      assert.include(error.message, "не больше 200 задач");
      assert.include(error.message, "340");
    }).pipe(Effect.provide(DataLayerMock))
  );

  it.effect(
    "syncs a space less an excluded list and a task with its subtasks",
    () =>
      Effect.gen(function* () {
        const connectors = yield* Connectors;
        const projectId = yield* newProject;
        yield* connectors.selectionSet(projectId, "clickup", [
          {
            externalId: "space:sp-clients",
            itemKind: "container",
            title: "Клиенты",
          },
          { externalId: "list:ls-tm-2", itemKind: "exclude", title: "Этап 2" },
          { externalId: "tm1-mis", itemKind: "exclude", title: "МИС" },
        ]);
        // 14 + 6 tasks less «Интеграция с МИС» and its two subtasks.
        const sources = yield* clickupSources(projectId);
        assert.strictEqual(sources.length, 17);
        assert.isFalse(
          sources.some((source) => source.origin?.externalId === "tm1-mis-auth")
        );
        const views = yield* connectors.selectionGet(projectId);
        assert.deepStrictEqual(
          views.map((view) => view.kind),
          ["outline", "clickup"]
        );
      }).pipe(Effect.provide(DataLayerMock))
  );
});
