import { Context, Effect, Fiber, Layer, PubSub, Stream } from "effect";

import {
  type Call,
  type CallSummary,
  type CallSummaryView,
  commands,
  events,
  type SummaryCounts,
  type SummaryProgress,
  type SummaryStage,
  type SummaryStageState,
} from "@/bindings";
import { type BackendError, call, listen } from "@/effect/tauri";

import {
  invalid,
  MockDatabase,
  type MockTables,
  notFound,
  uuidv7,
} from "./mock-database";
import { demoRecords } from "./mock-records";

/*
 * The summary of a call (post-call design.md, decisions 1, 2 and 12). Rust
 * builds it after the call: `CallManager` starts the build when the call
 * goes to `finishing`, «Собрать итоги» (`build`) starts it again for a
 * finished one, «Остановить» (`cancel`) stops it. `progress` is every
 * build's `SummaryProgress`: each stage `running`, then `done` when the
 * next starts; the build ends with `(saving, done)`, or `failed` /
 * `cancelled` at the stage it reached. `get` also tells the stage of the
 * build running now, so a window opened during it shows that stage.
 *
 * `layerMock` plays the build with a timer over the mock database, through
 * the same stages and writes as Rust: the summary reads `building`, then
 * the demo summary is saved (`./mock-records.ts`) with fresh pending
 * proposals; the decided ones stay. A call without a recording gets the
 * demo one first: the browser's call window plays that call. The mock
 * leaves the call's status to the call session (`closeCall`).
 */
export class SummaryData extends Context.Service<
  SummaryData,
  {
    /** The summary of a call and the build running for it. */
    readonly get: (
      callId: string
    ) => Effect.Effect<CallSummaryView, BackendError>;
    /** «Собрать итоги»: returns at once, `progress` follows the build. */
    readonly build: (callId: string) => Effect.Effect<void, BackendError>;
    /** «Остановить». */
    readonly cancel: (callId: string) => Effect.Effect<void, BackendError>;
    /** The progress of every call's build. */
    readonly progress: Stream.Stream<SummaryProgress, BackendError>;
  }
>()("grill/data/services/SummaryData") {
  static readonly layerTauri = Layer.succeed(SummaryData, {
    build: (callId) => Effect.asVoid(call(() => commands.summaryBuild(callId))),
    cancel: (callId) =>
      Effect.asVoid(call(() => commands.summaryCancel(callId))),
    get: (callId) => call(() => commands.summaryGet(callId)),
    progress: listen(events.summaryProgress),
  });

  static readonly layerMock = Layer.effect(
    SummaryData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;
      const progress = yield* PubSub.unbounded<SummaryProgress>();
      const running = new Map<string, Fiber.Fiber<unknown, unknown>>();

      const stored = Effect.fnUntraced(function* (callId: string) {
        const found = tables.calls.get(callId);
        if (!found) {
          return yield* notFound(`Звонок ${callId} не найден`);
        }
        return found;
      });

      const get = Effect.fnUntraced(function* (callId: string) {
        const found = yield* stored(callId);
        return {
          building: tables.summaryBuilds.get(callId) ?? null,
          summary: summaryOf(tables, found),
        };
      });

      const send = (
        callId: string,
        stage: SummaryStage,
        state: SummaryStageState,
        counts: SummaryCounts | null
      ) =>
        Effect.suspend(() => {
          const item: SummaryProgress = { callId, counts, stage, state };
          if (tables.summaryBuilds.has(callId)) {
            tables.summaryBuilds.set(callId, item);
          }
          return PubSub.publish(progress, item);
        });

      /** Writes the summary of a call (`start_building`, `save_*`). */
      const writeSummary = Effect.fnUntraced(function* (
        callId: string,
        change: (current: CallSummary) => CallSummary
      ) {
        const found = tables.calls.get(callId);
        if (!found) {
          return;
        }
        const { now } = yield* database.stamp;
        const current =
          tables.summaries.get(callId) ?? emptySummary(callId, now);
        tables.summaries.set(callId, {
          ...change(current),
          updatedAt: Math.max(now, current.updatedAt + 1),
        });
        yield* database.emit("call", callId, found.projectId, "updated");
      });

      /** The demo transcript of a call that has none (the mock call). */
      const recordingOf = Effect.fnUntraced(function* (found: Call) {
        const own = [...tables.recordings.values()].filter(
          (item) => item.callId === found.id
        );
        if (own.length > 0) {
          return own;
        }
        const { now } = yield* database.stamp;
        const demo = demoRecords(
          found.id,
          found.startedAt ?? found.createdAt,
          () => uuidv7(now),
          false
        );
        tables.recordings.set(demo.recording.id, {
          callId: found.id,
          recording: demo.recording,
        });
        for (const question of demo.questions) {
          tables.questions.set(question.id, question);
        }
        return [{ callId: found.id, recording: demo.recording }];
      });

      /** `save_build`: the demo summary and fresh pending proposals. */
      const save = Effect.fnUntraced(function* (found: Call) {
        const { now } = yield* database.stamp;
        const [recording] = yield* recordingOf(found);
        // The summary's moments point at the call's recording.
        const demo = demoRecords(
          found.id,
          recording?.recording.startedAt ?? found.startedAt ?? found.createdAt,
          (key) =>
            recording && key === `${found.id}-recording`
              ? recording.recording.id
              : uuidv7(now),
          false
        );
        const saved = { ...demo.summary, builtAt: now };
        yield* writeSummary(found.id, (current) => ({
          ...saved,
          createdAt: current.createdAt,
        }));
        if (!found.title.trim()) {
          const named = tables.calls.get(found.id);
          if (named) {
            tables.calls.set(found.id, {
              ...named,
              title: saved.title,
              updatedAt: yield* database.touch(named.updatedAt),
            });
          }
        }
        const decided = [...tables.proposals.values()].filter(
          (item) => item.callId === found.id && item.decision !== "pending"
        );
        for (const [id, item] of tables.proposals) {
          if (item.callId === found.id && item.decision === "pending") {
            tables.proposals.delete(id);
          }
        }
        const added =
          found.projectId === null
            ? []
            : demo.proposals.filter(
                (item) =>
                  !decided.some(
                    (old) =>
                      old.target === item.target &&
                      old.personId === item.personId &&
                      old.field === item.field &&
                      old.after === item.after
                  ) &&
                  (item.personId === null || tables.people.has(item.personId))
              );
        for (const item of added) {
          tables.proposals.set(item.id, {
            ...item,
            createdAt: now,
            updatedAt: now,
          });
        }
        return added.length;
      });

      const run = (found: Call) =>
        Effect.gen(function* () {
          const callId = found.id;
          let counts: SummaryCounts | null = null;
          let reached: SummaryStage = "transcript";
          const stage = Effect.fnUntraced(function* (next: SummaryStage) {
            if (next !== reached) {
              yield* send(callId, reached, { status: "done" }, counts);
            }
            reached = next;
            yield* send(callId, next, { status: "running" }, counts);
          });
          tables.summaryBuilds.set(callId, {
            callId,
            counts,
            stage: "transcript",
            state: { status: "running" },
          });
          return yield* Effect.gen(function* () {
            yield* stage("transcript");
            yield* writeSummary(callId, (current) => ({
              ...current,
              error: null,
              state: "building",
            }));
            const recordings = yield* recordingOf(found);
            yield* Effect.sleep(MOCK_STAGE_MS);
            counts = {
              proposals: null,
              segments: recordings.reduce(
                (total, item) => total + item.recording.segments.length,
                0
              ),
              topics: FAST_TOPICS,
              transcriptPass: "refined",
            };
            yield* stage("summary");
            yield* Effect.sleep(MOCK_STAGE_MS);
            counts = { ...counts, topics: SUMMARY_TOPICS };
            if (found.projectId !== null) {
              yield* stage("proposals");
              yield* Effect.sleep(MOCK_STAGE_MS);
            }
            yield* stage("saving");
            yield* Effect.sleep(MOCK_STAGE_MS);
            if (!tables.calls.has(callId)) {
              return yield* Effect.interrupt;
            }
            const pending = yield* save(found);
            counts = { ...counts, proposals: pending };
            tables.summaryBuilds.delete(callId);
            yield* send(callId, "saving", { status: "done" }, counts);
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                tables.summaryBuilds.delete(callId);
                yield* writeSummary(callId, (current) => ({
                  ...current,
                  error: CANCELLED,
                  state: "failed",
                }));
                yield* send(callId, reached, { status: "cancelled" }, counts);
              })
            )
          );
        });

      const build = Effect.fnUntraced(function* (callId: string) {
        const found = yield* stored(callId);
        if (found.status === "live") {
          return yield* invalid(
            "Итоги собираются после звонка: сначала завершите его"
          );
        }
        if (running.has(callId)) {
          return;
        }
        const fiber = yield* Effect.forkDetach(
          run(found).pipe(
            Effect.ensuring(Effect.sync(() => running.delete(callId)))
          ),
          { startImmediately: true }
        );
        running.set(callId, fiber);
      });

      const cancel = (callId: string) =>
        Effect.suspend(() => {
          const fiber = running.get(callId);
          return fiber ? Fiber.interrupt(fiber) : Effect.void;
        });

      return SummaryData.of({
        build,
        cancel,
        get,
        progress: Stream.fromPubSub(progress),
      });
    })
  );
}

/** How long each stage of a mock build takes. */
export const MOCK_STAGE_MS = 600;
/** Topics of the fast loop, then of the summary, in the demo. */
const FAST_TOPICS = 2;
const SUMMARY_TOPICS = 2;

/** The `error` of a stopped build. */
export const CANCELLED = "cancelled";
/** The `error` of a finished call without a stored summary. */
export const INTERRUPTED = "interrupted";

function emptySummary(callId: string, now: number): CallSummary {
  return {
    builtAt: null,
    callId,
    content: null,
    createdAt: now,
    error: null,
    state: "building",
    title: "",
    tldr: "",
    transcriptPass: null,
    updatedAt: now,
  };
}

/**
 * What `summary_get` reads: the stored summary; `null` for a live call or
 * a finishing one before its build wrote anything; `failed` /
 * `interrupted` for a finished call without one.
 */
function summaryOf(tables: MockTables, found: Call): CallSummary | null {
  const saved = tables.summaries.get(found.id);
  if (saved) {
    return saved;
  }
  if (found.status !== "finished") {
    return null;
  }
  return {
    ...emptySummary(found.id, found.updatedAt),
    error: INTERRUPTED,
    state: "failed",
  };
}
