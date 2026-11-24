import { Clock, Context, Effect, Layer, Result, type Stream } from "effect";

import { type CallSession, type CallStart, commands, events } from "@/bindings";
import {
  type BackendError,
  call,
  currentThenChanges,
  listenFromCurrent,
} from "@/effect/tauri";
import { RecordingBackend } from "@/features/recording/backend";

import { mockAgentLimit } from "./agent-limit";
import { invalid, MockDatabase, notFound } from "./mock-database";
import { DEMO_CALL_ID } from "./mock-seed";

/*
 * The call in progress (call-lifecycle design.md, decisions 2, 4 and 10).
 * In Tauri the backend owns it: "Начать" creates the call and records it,
 * "Завершить" stops the recording, and every change goes to every window
 * as `CallSessionChanged`. A window reads the session when it opens
 * (`call_current`) and follows the event; it never sends the session
 * itself.
 *
 * `layerMock` is the browser's and the tests' demo: one page, one session,
 * the demo call's id (`DEMO_CALL_ID`, whose summary the post-call screens
 * have). It records through the mock recorder and answers synchronously,
 * so a screen sees the change before the action returns.
 *
 * Every action returns the session as it is after it. A finish, resume or
 * close in the wrong state changes nothing; an id that isn't the current
 * call's is `Invalid` (`NotFound` in Rust for an unknown one).
 */
export class CallSessionBackend extends Context.Service<
  CallSessionBackend,
  {
    /** The session now. */
    readonly current: Effect.Effect<CallSession, BackendError>;
    /** The session now, then each change, from every window. */
    readonly sessions: Stream.Stream<CallSession, BackendError>;
    /**
     * "Начать": the call with its project (or none) and people, recorded.
     * During a call, that call. No microphone access: `External` with
     * `reason: "noAccess"`, and no call.
     */
    readonly start: (
      input: CallStart
    ) => Effect.Effect<CallSession, BackendError>;
    /** "Завершить": the recording stops, the call is `finishing`. */
    readonly finish: (
      callId: string
    ) => Effect.Effect<CallSession, BackendError>;
    /**
     * "Отменить завершение": `live` again with a new recording. When that
     * recording doesn't start, the call is live without one and the error
     * says why.
     */
    readonly resume: (
      callId: string
    ) => Effect.Effect<CallSession, BackendError>;
    /**
     * Browser: the mock summary is built, the call is over and none is
     * current. In Tauri the backend's build closes the call itself (post-call
     * design.md, decision 1), so no window does: `Invalid`, nothing sent.
     */
    readonly close: (
      callId: string
    ) => Effect.Effect<CallSession, BackendError>;
    /** "Продолжить": the countdown of the auto end stops. */
    readonly keep: (callId: string) => Effect.Effect<CallSession, BackendError>;
    /**
     * "Удалить все данные": the call goes without a summary (a live one's
     * recording stops), none is current; its data is the delete's. In Tauri
     * the overlay hides and the main window stays where it is.
     */
    readonly discard: (
      callId: string
    ) => Effect.Effect<CallSession, BackendError>;
  }
>()("grill/data/services/CallSessionBackend") {
  static readonly layerTauri = Layer.succeed(CallSessionBackend, {
    close: () =>
      Effect.fail(invalid("Звонок закрывает сборка итогов, а не окно")),
    current: call(() => commands.callCurrent()),
    discard: (callId) => call(() => commands.callDiscard(callId)),
    finish: (callId) => call(() => commands.callFinish(callId)),
    keep: (callId) => call(() => commands.callKeep(callId)),
    resume: (callId) => call(() => commands.callResume(callId)),
    sessions: listenFromCurrent(
      events.callSessionChanged,
      call(() => commands.callCurrent()),
      (change) => change.session
    ),
    start: (input) => call(() => commands.callStart(input)),
  });

  static readonly layerMock = Layer.effect(
    CallSessionBackend,
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const { tables } = yield* MockDatabase;

      const set = (next: CallSession) =>
        Effect.sync(() => {
          mockSession.session = next;
          for (const listener of mockSession.listeners) {
            listener(next);
          }
          return next;
        });

      /** The current call's session, or `Invalid`. */
      const current = (callId: string) =>
        Effect.suspend(() => {
          const { session } = mockSession;
          return session.callId === callId
            ? Effect.succeed(session)
            : Effect.fail(invalid(`Звонок ${callId} сейчас не идёт`));
        });

      const checkStart = Effect.fnUntraced(function* (input: CallStart) {
        const projectId = input.projectId ?? null;
        const participantIds = [...new Set(input.participantIds ?? [])];
        if (projectId !== null && !tables.projects.has(projectId)) {
          return yield* notFound(`Проект ${projectId} не найден`);
        }
        if (projectId === null && participantIds.length > 0) {
          return yield* invalid("У звонка без проекта нет участников");
        }
        const participants: string[] = [];
        for (const id of participantIds) {
          const person = tables.people.get(id);
          if (!person) {
            return yield* notFound(`Человек ${id} не найден`);
          }
          if (person.projectId !== projectId) {
            return yield* invalid(
              `${person.name} из другого проекта и не может быть участником этого звонка`
            );
          }
          participants.push(person.name);
        }
        return { participantIds, participants, projectId };
      });

      const start = Effect.fnUntraced(function* (input: CallStart) {
        if (mockSession.session.status !== "idle") {
          return mockSession.session;
        }
        const people = yield* checkStart(input);
        const recordingId = yield* recorder.start(people);
        if (input.overLimit) {
          // «Начать сверх лимита», as Rust's `call_start`.
          mockAgentLimit.allowOver(recordingId);
        }
        const startedAt = yield* Clock.currentTimeMillis;
        return yield* set({
          ...people,
          autoEnd: null,
          callId: DEMO_CALL_ID,
          recordingId,
          startedAt,
          status: "live",
        });
      });

      /** A live call's recording stops; one already gone is fine. */
      const stopRecording = (session: CallSession) =>
        session.recordingId === null
          ? Effect.void
          : recorder.stop(session.recordingId).pipe(
              Effect.catchIf(
                (error) => error.kind === "NotFound",
                () => Effect.void
              )
            );

      const finish = Effect.fnUntraced(function* (callId: string) {
        const session = yield* current(callId);
        if (session.status !== "live") {
          return session;
        }
        yield* stopRecording(session);
        return yield* set({ ...session, autoEnd: null, status: "finishing" });
      });

      const discard = Effect.fnUntraced(function* (callId: string) {
        const session = yield* current(callId);
        if (session.status === "idle") {
          return session;
        }
        if (session.status === "live") {
          yield* stopRecording(session);
        }
        return yield* set(IDLE_SESSION);
      });

      const resume = Effect.fnUntraced(function* (callId: string) {
        const session = yield* current(callId);
        if (session.status !== "finishing") {
          return session;
        }
        const started = yield* Effect.result(
          recorder.start({
            participantIds: session.participantIds,
            projectId: session.projectId,
          })
        );
        if (Result.isFailure(started)) {
          yield* set({ ...session, recordingId: null, status: "live" });
          return yield* Effect.fail(started.failure);
        }
        return yield* set({
          ...session,
          recordingId: started.success,
          status: "live",
        });
      });

      const close = Effect.fnUntraced(function* (callId: string) {
        const session = yield* current(callId);
        return session.status === "finishing"
          ? yield* set(IDLE_SESSION)
          : session;
      });

      const keep = Effect.fnUntraced(function* (callId: string) {
        const session = yield* current(callId);
        return session.autoEnd === null
          ? session
          : yield* set({ ...session, autoEnd: null });
      });

      return CallSessionBackend.of({
        close,
        current: Effect.sync(() => mockSession.session),
        discard,
        finish,
        keep,
        resume,
        sessions: currentThenChanges<CallSession, BackendError>(
          (emit) =>
            Effect.acquireRelease(
              Effect.sync(() => mockSession.listeners.add(emit)),
              () => Effect.sync(() => mockSession.listeners.delete(emit))
            ),
          Effect.sync(() => mockSession.session)
        ),
        start,
      });
    })
  );
}

/** No call: what `call_current` answers when none is current. */
export const IDLE_SESSION: CallSession = {
  autoEnd: null,
  callId: null,
  participantIds: [],
  participants: [],
  projectId: null,
  recordingId: null,
  startedAt: null,
  status: "idle",
};

/*
 * The session of `layerMock`: one per page, like the mock recorder's
 * recording, so `resetMockCallSession` can end it between tests.
 */
const mockSession = {
  listeners: new Set<(session: CallSession) => void>(),
  session: IDLE_SESSION,
};

/** The mock's session back to no call (tests, the dev navigator). */
export function resetMockCallSession() {
  mockSession.session = IDLE_SESSION;
  for (const listener of mockSession.listeners) {
    listener(IDLE_SESSION);
  }
}
