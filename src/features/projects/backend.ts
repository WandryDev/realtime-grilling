import { open } from "@tauri-apps/plugin-dialog";
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Queue,
  Schema,
  Stream,
} from "effect";

import { type Brief, type BriefProgress, commands, events } from "@/bindings";
import {
  briefFingerprint,
  MockDatabase,
  type MockTables,
} from "@/data/services/mock-database";
import { type BackendError, call, subscribe } from "@/effect/tauri";

/*
 * Backend contract of the projects area: the brief build (design.md,
 * decisions 6, 8 and 9), the Markdown export and the documents from the
 * manager's computer (picked in a dialog or dropped on the window). The UI
 * runs these effects through the app runtime (`src/effect/runtime.ts`).
 *
 * - `layerTauri` calls `brief_build` and follows `BriefProgress` of that
 *   project to the last stage's `done`, `failed` or `cancelled` (every
 *   stage sends its own `done`); the build runs in Rust, so
 *   leaving the screen (or "Свернуть") doesn't stop it, `cancel` does.
 * - `layerMock` plays the agent with timers over the mock database and
 *   sends the same `BriefProgress` as Rust: the project reads `building`
 *   meanwhile, and the brief it writes is fresh.
 */

export class BriefError extends Schema.TaggedError<BriefError>()("BriefError", {
  message: Schema.String,
}) {}

/** The build was stopped ("Остановить", here or in another window). */
export class BriefCancelled extends Schema.TaggedError<BriefCancelled>()(
  "BriefCancelled",
  {}
) {}

export class ExportError extends Schema.TaggedError<ExportError>()(
  "ExportError",
  { message: Schema.String }
) {}

export type ExportTarget = "brief" | "calls";

/** Stages of "Собираю бриф проекта": read → … → write. */
export const BRIEF_BUILD_STAGES = 5;

/** What a file dropped on the window does to the drop zone. */
export type DocumentDrop =
  | { readonly type: "enter" | "leave" }
  | { readonly paths: string[]; readonly type: "drop" };

/** Extensions the document dialog offers (project-sources spec). */
export const DOCUMENT_EXTENSIONS = ["md", "txt", "pdf", "docx"];

const CALLS_EXPORT_LATER = "Экспорт итогов звонков появится позже";

export class ProjectsBackend extends Context.Service<
  ProjectsBackend,
  {
    /**
     * Builds the project's brief, or follows the build that runs already;
     * emits the number of finished stages and ends when the brief is saved.
     */
    readonly buildBrief: (
      projectId: string
    ) => Stream.Stream<number, BriefError | BriefCancelled>;
    /** "Обновить": the same build, to its end. */
    readonly refreshBrief: (
      projectId: string
    ) => Effect.Effect<void, BriefError | BriefCancelled>;
    /** "Остановить": the agent stops, the old brief stays. */
    readonly cancel: (projectId: string) => Effect.Effect<void>;
    /**
     * The start widget: refreshes an outdated brief in the background when
     * the agent is ready. Whether a build started.
     */
    readonly prepareBrief: (projectId: string) => Effect.Effect<boolean>;
    /** Stages of every build of every project, from any window. */
    readonly progress: Stream.Stream<BriefProgress>;
    /**
     * Markdown in a folder the user picks; the written file, or `null` when
     * the folder dialog was closed.
     */
    readonly exportMarkdown: (
      target: ExportTarget,
      project: { id: string; name: string }
    ) => Effect.Effect<string | null, ExportError>;
    /** "Выбрать файлы": the picked paths, `[]` when the dialog was closed. */
    readonly pickDocuments: Effect.Effect<string[]>;
    /** Files dragged over and dropped on this window. */
    readonly documentDrops: Stream.Stream<DocumentDrop>;
  }
>()("grill/features/projects/ProjectsBackend") {
  static readonly layerTauri = Layer.succeed(ProjectsBackend, {
    buildBrief: tauriBuildBrief,
    cancel: (projectId) =>
      call(() => commands.briefCancel(projectId)).pipe(
        Effect.asVoid,
        Effect.ignore
      ),
    documentDrops: Stream.callback<DocumentDrop>((queue) =>
      Effect.acquireRelease(
        Effect.tryPromise(async () => {
          const { getCurrentWebview } = await import("@tauri-apps/api/webview");
          return getCurrentWebview().onDragDropEvent(({ payload }) => {
            if (payload.type === "drop") {
              Queue.offerUnsafe(queue, { paths: payload.paths, type: "drop" });
            } else if (payload.type !== "over") {
              Queue.offerUnsafe(queue, { type: payload.type });
            }
          });
        }),
        (unlisten) => Effect.sync(unlisten)
      ).pipe(Effect.ignore)
    ),
    exportMarkdown: Effect.fn("ProjectsBackend.exportMarkdown")(function* (
      target: ExportTarget,
      project: { id: string; name: string }
    ) {
      if (target === "calls") {
        return yield* new ExportError({ message: CALLS_EXPORT_LATER });
      }
      const folder = yield* Effect.tryPromise({
        catch: (cause) =>
          new ExportError({
            message:
              cause instanceof Error ? cause.message : "Папка не выбрана",
          }),
        try: () =>
          open({
            canCreateDirectories: true,
            directory: true,
            title: `Куда сохранить бриф «${project.name}»`,
          }),
      });
      if (folder === null) {
        return null;
      }
      return yield* call(() => commands.briefExport(project.id, folder)).pipe(
        Effect.mapError((error) => new ExportError({ message: error.message }))
      );
    }),
    pickDocuments: Effect.tryPromise(() =>
      open({
        filters: [{ extensions: DOCUMENT_EXTENSIONS, name: "Документы" }],
        multiple: true,
        title: "Документы проекта",
      })
    ).pipe(
      Effect.map((paths) => paths ?? []),
      Effect.orElseSucceed((): string[] => [])
    ),
    prepareBrief: (projectId) =>
      call(() => commands.briefPrepare(projectId)).pipe(
        Effect.orElseSucceed(() => false)
      ),
    progress: Stream.callback<BriefProgress, BackendError>((queue) =>
      subscribe(events.briefProgress, (progress) => {
        Queue.offerUnsafe(queue, progress);
      })
    ).pipe(Stream.catch(() => Stream.empty)),
    refreshBrief: (projectId) => Stream.runDrain(tauriBuildBrief(projectId)),
  });

  static readonly layerMock = Layer.effect(
    ProjectsBackend,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;
      const progress = yield* PubSub.unbounded<BriefProgress>();
      /** Builds `prepareBrief` started, so `cancel` can stop them. */
      const background = new Map<string, Fiber.Fiber<unknown, unknown>>();

      const publish = (
        projectId: string,
        stage: number,
        state: BriefProgress["state"]
      ) => PubSub.publish(progress, { projectId, stage, state });

      const projectChanged = (projectId: string) =>
        database.emit("project", projectId, projectId, "updated");

      /** The stages of a build that runs already. */
      const follow = (projectId: string) =>
        buildStages(
          Stream.fromPubSub(progress).pipe(
            Stream.filter((item) => item.projectId === projectId)
          )
        );

      const run = (
        projectId: string
      ): Stream.Stream<number, BriefError | BriefCancelled> =>
        Stream.unwrap(
          Effect.gen(function* (): Effect.fn.Return<
            Stream.Stream<number, BriefError | BriefCancelled>
          > {
            const project = tables.projects.get(projectId);
            if (!project) {
              return Stream.fail(
                new BriefError({ message: `Проект ${projectId} не найден` })
              );
            }
            if (!hasMaterials(tables, projectId)) {
              return Stream.fail(new BriefError({ message: NO_MATERIALS }));
            }
            // What the brief is built from, read before the agent works.
            const inputs = briefFingerprint(tables, projectId);
            tables.building.add(projectId);
            yield* projectChanged(projectId);
            // The stage running now, for the cancel.
            let current = 0;
            return Stream.range(1, BRIEF_BUILD_STAGES).pipe(
              // The same events as Rust: each stage runs, then is done.
              Stream.mapEffect((stage) =>
                Effect.gen(function* () {
                  current = stage;
                  yield* publish(projectId, stage, { status: "running" });
                  yield* Effect.sleep(MOCK_STAGE);
                  // Deleting a project stops its build, as in Rust.
                  if (!tables.projects.has(projectId)) {
                    return yield* new BriefCancelled();
                  }
                  if (stage === BRIEF_BUILD_STAGES) {
                    yield* saveBrief(projectId, inputs);
                    // Not `building` by the time the last `done` is read.
                    tables.building.delete(projectId);
                  }
                  yield* publish(projectId, stage, { status: "done" });
                  return stage;
                })
              ),
              Stream.onExit((exit) =>
                Effect.gen(function* () {
                  tables.building.delete(projectId);
                  if (!Exit.isSuccess(exit)) {
                    yield* publish(projectId, Math.max(current, 1), {
                      status: "cancelled",
                    });
                  }
                  yield* projectChanged(projectId);
                })
              )
            );
          })
        );

      const saveBrief = Effect.fnUntraced(function* (
        projectId: string,
        inputs: string
      ) {
        const project = tables.projects.get(projectId);
        if (!project) {
          return;
        }
        const now = yield* database.touch(project.updatedAt);
        tables.projects.set(projectId, {
          ...project,
          brief: mockBrief(tables, projectId),
          briefBuiltAt: now,
          briefTruncated: false,
          updatedAt: now,
        });
        tables.briefInputs.set(projectId, inputs);
      });

      const buildBrief = (projectId: string) =>
        tables.building.has(projectId) ? follow(projectId) : run(projectId);

      return ProjectsBackend.of({
        buildBrief,
        cancel: (projectId) =>
          Effect.suspend(() => {
            const fiber = background.get(projectId);
            background.delete(projectId);
            return fiber ? Fiber.interrupt(fiber) : Effect.void;
          }),
        documentDrops: Stream.empty,
        exportMarkdown: Effect.fn("ProjectsBackend.exportMarkdown")(function* (
          target: ExportTarget,
          project: { id: string; name: string }
        ) {
          if (target === "calls") {
            return yield* new ExportError({ message: CALLS_EXPORT_LATER });
          }
          if (!tables.projects.get(project.id)?.brief) {
            return yield* new ExportError({ message: "Бриф ещё не собран" });
          }
          yield* Effect.sleep("800 millis");
          return "Документы / Grill";
        }),
        pickDocuments: Effect.succeed([...MOCK_PICKED_DOCUMENTS]),
        prepareBrief: (projectId) =>
          Effect.gen(function* () {
            const project = tables.projects.get(projectId);
            if (!project || tables.building.has(projectId)) {
              return false;
            }
            const outdated =
              project.brief !== null &&
              tables.briefInputs.get(projectId) !==
                briefFingerprint(tables, projectId);
            const missing =
              project.brief === null && hasMaterials(tables, projectId);
            if (!(outdated || missing)) {
              return false;
            }
            const fiber = yield* Effect.forkDetach(
              Stream.runDrain(run(projectId)).pipe(
                Effect.ignore,
                Effect.ensuring(Effect.sync(() => background.delete(projectId)))
              ),
              { startImmediately: true }
            );
            background.set(projectId, fiber);
            return true;
          }),
        progress: Stream.fromPubSub(progress),
        refreshBrief: (projectId) => Stream.runDrain(buildBrief(projectId)),
      });
    })
  );
}

/** `brief_build`, then the `BriefProgress` of that project to its end. */
function tauriBuildBrief(projectId: string) {
  return buildStages(
    Stream.callback<BriefProgress, BackendError>((queue) =>
      Effect.gen(function* () {
        // Listen first: the first stage may come before the answer.
        yield* subscribe(events.briefProgress, (progress) => {
          if (progress.projectId === projectId) {
            Queue.offerUnsafe(queue, progress);
          }
        });
        yield* call(() => commands.briefBuild(projectId));
      })
    ).pipe(
      Stream.mapError((error) => new BriefError({ message: error.message }))
    )
  );
}

/**
 * Whether a `BriefProgress` ends its build. Rust sends `done` for every
 * stage (`(1, running), (1, done), (2, running) … (5, done)`): only the
 * last stage's `done` is the end, as are `failed` and `cancelled`.
 */
export function endsBuild(progress: BriefProgress) {
  switch (progress.state.status) {
    case "running":
      return false;
    case "done":
      return progress.stage >= BRIEF_BUILD_STAGES;
    default:
      return true;
  }
}

/**
 * Stages finished by the time of a `BriefProgress`: a running stage means
 * the ones before it are done, a done one counts itself.
 */
export function finishedStages(progress: BriefProgress) {
  const finished =
    progress.state.status === "done" ? progress.stage : progress.stage - 1;
  return Math.min(Math.max(finished, 0), BRIEF_BUILD_STAGES);
}

/**
 * Finished stages from the `BriefProgress` of one build; the stream ends
 * with the build (see `endsBuild`), failing when it failed or was stopped.
 */
function buildStages<E>(
  stages: Stream.Stream<BriefProgress, E>
): Stream.Stream<number, E | BriefError | BriefCancelled> {
  return stages.pipe(
    Stream.takeUntil(endsBuild),
    Stream.mapEffect(
      (item): Effect.Effect<number, BriefError | BriefCancelled> => {
        switch (item.state.status) {
          case "running":
          case "done":
            return Effect.succeed(finishedStages(item));
          case "failed":
            return Effect.fail(new BriefError({ message: item.state.message }));
          default:
            return Effect.fail(new BriefCancelled());
        }
      }
    )
  );
}

/** How long a stage of the mock agent takes. */
const MOCK_STAGE = "900 millis";

const NO_MATERIALS =
  "Не из чего собрать бриф: добавьте описание, заметки, людей или документы";

/** What the browser demo "picks" in the file dialog. */
const MOCK_PICKED_DOCUMENTS = [
  "/Users/dima/Документы/ТЗ.docx",
  "/Users/dima/Документы/Переписка с клиентом.pdf",
];

function hasMaterials(tables: MockTables, projectId: string) {
  const project = tables.projects.get(projectId);
  if (!project) {
    return false;
  }
  const hasPeople = [...tables.people.values()].some(
    (person) => person.projectId === projectId
  );
  const hasDocuments = [...tables.sources.values()].some(
    ({ source }) => source.projectId === projectId && source.status === "ready"
  );
  return (
    project.description.trim() !== "" ||
    project.notes.trim() !== "" ||
    hasPeople ||
    hasDocuments
  );
}

const EXTENSION = /\.[^.]+$/u;

/** What the mock agent writes: the materials, laid out as a brief. */
function mockBrief(tables: MockTables, projectId: string): Brief {
  const project = tables.projects.get(projectId);
  const people = [...tables.people.values()].filter(
    (person) => person.projectId === projectId
  );
  const documents = [...tables.sources.values()]
    .map(({ source }) => source)
    .filter(
      (source) => source.projectId === projectId && source.status === "ready"
    );
  const materials = [
    project?.description.trim() ? "описание" : null,
    project?.notes.trim() ? "заметки" : null,
    people.length > 0 ? "люди клиента" : null,
    documents.length > 0 ? "документы" : null,
  ].filter((item) => item !== null);
  return {
    glossary: people.map((person) => ({
      definition: person.role || "Человек клиента",
      term: person.name,
    })),
    keyDocuments: documents.map((source) => ({
      sourceId: source.id,
      title: source.name.replace(EXTENSION, ""),
      why: "Документ проекта",
    })),
    modules: [],
    // Not the materials word for word: the browser has no agent.
    product: `Демо-бриф проекта «${project?.name ?? ""}», собран без агента: ${materials.join(", ")}. В приложении бриф пишет Claude Code.`,
    stack: [],
  };
}
