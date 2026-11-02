import { Context, Effect, Layer, Schema, Stream } from "effect";

/*
 * Backend contract of the projects area. The UI runs these effects through
 * the app runtime (`src/effect/runtime.ts`) and never knows what is behind
 * them: today `layerMock` simulates the agent with timers, later a Tauri
 * layer calls the Rust commands.
 */

export class BriefError extends Schema.TaggedError<BriefError>()("BriefError", {
  message: Schema.String,
}) {}

export class ExportError extends Schema.TaggedError<ExportError>()(
  "ExportError",
  { message: Schema.String }
) {}

export type ExportTarget = "brief" | "calls";

/** Stages of "Собираю бриф проекта": read → … → write. */
export const BRIEF_BUILD_STAGES = 5;

export class ProjectsBackend extends Context.Service<
  ProjectsBackend,
  {
    /** The agent writes the brief; emits the number of finished stages. */
    readonly buildBrief: (
      projectId: string
    ) => Stream.Stream<number, BriefError>;
    /** "Обновить": the agent rereads only what changed. */
    readonly refreshBrief: (
      projectId: string
    ) => Effect.Effect<void, BriefError>;
    /** Markdown files in a folder the user picks; returns the folder. */
    readonly exportMarkdown: (
      target: ExportTarget,
      projectName: string
    ) => Effect.Effect<string, ExportError>;
  }
>()("grill/features/projects/ProjectsBackend") {
  static readonly layerMock = Layer.succeed(ProjectsBackend, {
    buildBrief: (_projectId: string) =>
      Stream.range(1, BRIEF_BUILD_STAGES).pipe(
        Stream.mapEffect((stage) =>
          Effect.as(Effect.sleep("900 millis"), stage)
        )
      ),
    exportMarkdown: Effect.fn("ProjectsBackend.exportMarkdown")(function* (
      _target: ExportTarget,
      _projectName: string
    ) {
      yield* Effect.sleep("800 millis");
      return "Документы / Grill";
    }),
    refreshBrief: Effect.fn("ProjectsBackend.refreshBrief")(function* (
      _projectId: string
    ) {
      yield* Effect.sleep("2500 millis");
    }),
  });
}
