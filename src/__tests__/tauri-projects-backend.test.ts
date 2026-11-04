import { Effect, Exit, Fiber, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectsBackend as Backend } from "@/features/projects/backend";

/*
 * ProjectsBackend.layerTauri over the fake IPC (./helpers/fake-tauri.ts):
 * `brief_build` returns at once and the stages come as `BriefProgress`;
 * the stream follows the project's own until `done`, `failed` or
 * `cancelled`. The folder for the export comes from the dialog plugin.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));

const { ProjectsBackend } = await import("@/features/projects/backend");

const PROJECT = "019a0000-0000-7000-8000-000000000001";
const OTHER = "019a0000-0000-7000-8000-000000000002";

function run<A, E>(effect: Effect.Effect<A, E, Backend>) {
  return Effect.runPromise(
    Effect.exit(effect.pipe(Effect.provide(ProjectsBackend.layerTauri)))
  );
}

/** Starts the build and waits until it listens and has asked Rust. */
async function startBuild() {
  const fiber = Effect.runFork(
    ProjectsBackend.use((backend) =>
      Stream.runCollect(backend.buildBrief(PROJECT))
    ).pipe(Effect.provide(ProjectsBackend.layerTauri))
  );
  await vi.waitFor(() => {
    const listening = fake.handlers.get("brief-progress")?.size === 1;
    const asked = fake.invoked.some((call) => call.command === "brief_build");
    if (!(listening && asked)) {
      throw new Error("The build has not started yet");
    }
  });
  return fiber;
}

function progress(
  stage: number,
  state:
    | { status: "running" | "done" | "cancelled" }
    | { message: string; status: "failed" },
  projectId = PROJECT
) {
  fake.emit("brief-progress", { projectId, stage, state });
}

beforeEach(() => {
  fake.invoked.length = 0;
  fake.answers.clear();
  fake.failures.clear();
});

describe("ProjectsBackend.layerTauri", () => {
  it("follows the stages of its project to the saved brief", async () => {
    const fiber = await startBuild();
    expect(fake.invoked.at(-1)).toEqual({
      args: { projectId: PROJECT },
      command: "brief_build",
    });

    progress(1, { status: "running" });
    progress(2, { status: "running" });
    // Another project's build is not this one.
    progress(5, { status: "done" }, OTHER);
    progress(3, { status: "running" });
    progress(4, { status: "running" });
    progress(5, { status: "running" });
    progress(5, { status: "done" });

    const stages = await Effect.runPromise(Fiber.join(fiber));
    expect(Array.from(stages)).toEqual([0, 1, 2, 3, 4, 5]);
    // The listener goes with the stream.
    expect(fake.handlers.get("brief-progress")?.size).toBe(0);
  });

  it("ends with BriefCancelled when the build is stopped", async () => {
    const fiber = await startBuild();
    progress(1, { status: "running" });
    await run(ProjectsBackend.use((backend) => backend.cancel(PROJECT)));
    expect(fake.invoked.at(-1)).toEqual({
      args: { projectId: PROJECT },
      command: "brief_cancel",
    });
    progress(3, { status: "cancelled" });

    const exit = await Effect.runPromise(Effect.exit(Fiber.join(fiber)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("BriefCancelled");
  });

  it("fails with the reason of a failed stage", async () => {
    const fiber = await startBuild();
    progress(1, { status: "running" });
    progress(2, { message: "Claude Code не найден", status: "failed" });

    const exit = await Effect.runPromise(Effect.exit(Fiber.join(fiber)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Claude Code не найден");
  });

  it("fails when Rust turns the build away", async () => {
    fake.failures.set("brief_build", {
      kind: "NotFound",
      message: "Проект не найден",
    });
    const exit = await run(
      ProjectsBackend.use((backend) => backend.refreshBrief(PROJECT))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("BriefError");
  });

  it("asks Rust to prepare the brief and never fails the widget", async () => {
    fake.answers.set("brief_prepare", () => true);
    const started = await run(
      ProjectsBackend.use((backend) => backend.prepareBrief(PROJECT))
    );
    expect(started).toEqual(Exit.succeed(true));
    expect(fake.invoked.at(-1)?.args).toEqual({ projectId: PROJECT });

    fake.failures.set("brief_prepare", {
      kind: "Storage",
      message: "База недоступна",
    });
    const failed = await run(
      ProjectsBackend.use((backend) => backend.prepareBrief(PROJECT))
    );
    expect(failed).toEqual(Exit.succeed(false));
  });

  it("exports the brief into the folder picked in the dialog", async () => {
    fake.answers.set("plugin:dialog|open", () => "/Users/dima/Документы");
    const written = await run(
      ProjectsBackend.use((backend) =>
        backend.exportMarkdown("brief", { id: PROJECT, name: "Телемедиа" })
      )
    );
    expect(written).toEqual(Exit.succeed("/Users/dima/Документы/бриф.md"));
    expect(fake.invoked.at(-1)).toEqual({
      args: { folder: "/Users/dima/Документы", projectId: PROJECT },
      command: "brief_export",
    });

    // The dialog closed: nothing written.
    fake.answers.set("plugin:dialog|open", () => null);
    fake.invoked.length = 0;
    const closed = await run(
      ProjectsBackend.use((backend) =>
        backend.exportMarkdown("brief", { id: PROJECT, name: "Телемедиа" })
      )
    );
    expect(closed).toEqual(Exit.succeed(null));
    expect(fake.invoked.map((call) => call.command)).toEqual([
      "plugin:dialog|open",
    ]);
  });

  it("picks documents with the supported types", async () => {
    fake.answers.set("plugin:dialog|open", () => ["/Users/dima/ТЗ.docx"]);
    const paths = await run(
      ProjectsBackend.use((backend) => backend.pickDocuments)
    );
    expect(paths).toEqual(Exit.succeed(["/Users/dima/ТЗ.docx"]));
    expect(fake.invoked.at(-1)?.args).toEqual({
      options: {
        filters: [
          { extensions: ["md", "txt", "pdf", "docx"], name: "Документы" },
        ],
        multiple: true,
        title: "Документы проекта",
      },
    });
  });
});
