import { act, render, screen, waitFor } from "@testing-library/react";
import { Effect, Exit, Fiber, type Layer, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CallSummary,
  CallSummaryView,
  Proposal,
  SummaryProgress,
} from "@/bindings";

/*
 * The post-call data services in Tauri (post-call design.md, decision 12),
 * over the fake IPC (./helpers/fake-tauri.ts): each method calls its
 * command with the arguments Rust reads, a `CommandError` comes back as a
 * `BackendError` of the same kind (anything else is `Transport`), and
 * `SummaryProgress` is a stream whose listener goes with it. The hooks
 * read on the first subscriber, follow the build's progress and read the
 * summary again on the call's `DataChanged` and when the build ends.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const os = vi.hoisted(() => ({ platform: "macos" }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => os.platform }));

const { CallRecordsData } = await import("@/data/services/call-records");
const { CallsData } = await import("@/data/services/calls");
const { ProposalsData } = await import("@/data/services/proposals");
const { SummaryData } = await import("@/data/services/summaries");
const { DataLayerTauri } = await import("@/data/services/layers");
const { useCallSummary } = await import("@/data/summaries");
const { decideProposal, useCallProposals } = await import("@/data/proposals");
const { recordingAudioUrl } = await import("@/data/call-records");

const CALL = "019a0000-0000-7000-8000-0000000000c1";
const PROJECT = "019a0000-0000-7000-8000-000000000001";
const RECORDING = "019a0000-0000-7000-8000-0000000000aa";

type Services = Layer.Success<typeof DataLayerTauri>;

function run<A, E>(effect: Effect.Effect<A, E, Services>) {
  return Effect.runPromise(
    Effect.exit(effect.pipe(Effect.provide(DataLayerTauri)))
  );
}

/** Answers `command` with `value` and returns what it was called with. */
function answer(command: string, value: unknown) {
  fake.answers.set(command, () => value);
}

function lastArgs(command: string) {
  return fake.invoked.filter((call) => call.command === command).at(-1)?.args;
}

const stored = (state: CallSummary["state"]): CallSummary => ({
  builtAt: state === "ready" ? 2000 : null,
  callId: CALL,
  content: state === "ready" ? { cards: [], next: [], topics: [] } : null,
  createdAt: 1000,
  error: null,
  state,
  title: state === "ready" ? "Созвон про CRM" : "",
  tldr: "",
  transcriptPass: state === "ready" ? "refined" : null,
  updatedAt: 1000,
});

const progress = (
  stage: SummaryProgress["stage"],
  state: SummaryProgress["state"],
  callId = CALL
): SummaryProgress => ({ callId, counts: null, stage, state });

const proposal = (decision: Proposal["decision"]): Proposal => ({
  after: "Держит доступы к amoCRM",
  applied: null,
  before: null,
  callId: CALL,
  createdAt: 1000,
  decidedAt: null,
  decision,
  edited: null,
  evidence: [],
  field: "role",
  id: "019a0000-0000-7000-8000-0000000000p1",
  kind: "said",
  personId: "019a0000-0000-7000-8000-0000000000e1",
  target: "person",
  updatedAt: 1000,
});

beforeEach(() => {
  fake.invoked.length = 0;
  fake.answers.clear();
  fake.failures.clear();
});

describe("post-call data services in Tauri", () => {
  it("passes the arguments Rust reads", async () => {
    for (const command of [
      "summary_get",
      "summary_build",
      "summary_cancel",
      "proposals_list",
      "proposals_for_person",
      "proposal_decide",
      "proposal_undo",
      "call_cards",
      "call_card_update",
      "call_transcript",
      "call_questions",
      "calls_search",
      "recording_peaks",
      "call_audio_delete",
    ]) {
      answer(command, null);
    }
    const decide = { decision: "accepted", edited: "Техлид" } as const;
    const patch = { decision: "accepted" } as const;
    const exits = await Promise.all([
      run(SummaryData.use((data) => data.get(CALL))),
      run(SummaryData.use((data) => data.build(CALL))),
      run(SummaryData.use((data) => data.cancel(CALL))),
      run(ProposalsData.use((data) => data.list(CALL))),
      run(ProposalsData.use((data) => data.forPerson("person"))),
      run(ProposalsData.use((data) => data.decide("p1", decide))),
      run(ProposalsData.use((data) => data.undo("p1"))),
      run(CallRecordsData.use((data) => data.cards(CALL))),
      run(CallRecordsData.use((data) => data.updateCard(CALL, "c1", patch))),
      run(CallRecordsData.use((data) => data.transcript(CALL))),
      run(CallRecordsData.use((data) => data.questions(CALL))),
      run(CallsData.use((data) => data.search("amoCRM", PROJECT))),
      run(CallRecordsData.use((data) => data.peaks(RECORDING, 120))),
      run(CallRecordsData.use((data) => data.deleteAudio(CALL))),
    ]);
    expect(
      exits.every((exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit))
    ).toBe(true);
    expect(fake.invoked.map(({ args, command }) => [command, args])).toEqual([
      ["summary_get", { callId: CALL }],
      ["summary_build", { callId: CALL }],
      ["summary_cancel", { callId: CALL }],
      ["proposals_list", { callId: CALL }],
      ["proposals_for_person", { personId: "person" }],
      ["proposal_decide", { id: "p1", input: decide }],
      ["proposal_undo", { id: "p1" }],
      ["call_cards", { callId: CALL }],
      ["call_card_update", { callId: CALL, cardId: "c1", patch }],
      ["call_transcript", { callId: CALL }],
      ["call_questions", { callId: CALL }],
      ["calls_search", { projectId: PROJECT, query: "amoCRM" }],
      ["recording_peaks", { bars: 120, recordingId: RECORDING }],
      ["call_audio_delete", { callId: CALL }],
    ]);
  });

  it("maps the errors of Rust to the kinds of BackendError", async () => {
    fake.failures.set("summary_build", {
      kind: "Invalid",
      message: "Итоги собираются после звонка: сначала завершите его",
    });
    fake.failures.set("proposal_undo", {
      kind: "Invalid",
      message: "Поле изменили после принятия",
    });
    fake.failures.set("recording_peaks", {
      kind: "NotFound",
      message: "Аудио записи удалено",
    });
    fake.failures.set("call_transcript", {
      kind: "Storage",
      message: "database is locked",
    });
    // Not a `CommandError`: the IPC itself failed.
    fake.answers.set("call_questions", () =>
      Promise.reject(new Error("ipc closed"))
    );
    const kinds = await Promise.all(
      [
        SummaryData.use((data) => data.build(CALL)),
        ProposalsData.use((data) => data.undo("p1")),
        CallRecordsData.use((data) => data.peaks(RECORDING, 10)),
        CallRecordsData.use((data) => data.transcript(CALL)),
        CallRecordsData.use((data) => data.questions(CALL)),
      ].map((effect) =>
        run(
          Effect.flip(effect as Effect.Effect<unknown, unknown, Services>)
        ).then((exit) =>
          Exit.isSuccess(exit)
            ? [
                (exit.value as { kind: string }).kind,
                (exit.value as { message: string }).message,
              ]
            : undefined
        )
      )
    );
    expect(kinds).toEqual([
      ["Invalid", "Итоги собираются после звонка: сначала завершите его"],
      ["Invalid", "Поле изменили после принятия"],
      ["NotFound", "Аудио записи удалено"],
      ["Storage", "database is locked"],
      ["Transport", "ipc closed"],
    ]);
  });

  it("streams the progress of every build until it is stopped", async () => {
    const seen: SummaryProgress[] = [];
    const fiber = Effect.runFork(
      SummaryData.use((data) =>
        Stream.runForEach(data.progress, (item) =>
          Effect.sync(() => seen.push(item))
        )
      ).pipe(Effect.provide(DataLayerTauri))
    );
    await vi.waitFor(() =>
      expect(fake.handlers.get("summary-progress")?.size).toBe(1)
    );
    const events = [
      progress("transcript", { status: "running" }),
      progress("transcript", { status: "done" }),
      progress("summary", { message: "Агент не вошёл", status: "failed" }),
      progress("saving", { status: "cancelled" }, "other-call"),
    ];
    for (const event of events) {
      fake.emit("summary-progress", event);
    }
    await vi.waitFor(() => expect(seen).toEqual(events));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(fake.handlers.get("summary-progress")?.size).toBe(0);
  });

  it("builds the audio address of the platform", () => {
    os.platform = "macos";
    expect(recordingAudioUrl(RECORDING, "others")).toBe(
      `grill-audio://localhost/${RECORDING}/others?format=wav`
    );
    os.platform = "windows";
    expect(recordingAudioUrl(RECORDING, "me")).toBe(
      `http://grill-audio.localhost/${RECORDING}/me?format=wav`
    );
    os.platform = "macos";
  });
});

function SummaryProbe() {
  const { building, status, summary } = useCallSummary(CALL);
  return (
    <p>
      {status}: {summary?.state ?? "нет"},{" "}
      {building ? `${building.stage} ${building.state.status}` : "без сборки"}
    </p>
  );
}

function ProposalsProbe() {
  const { data, status } = useCallProposals(CALL);
  return (
    <p>
      {status}: {data.map((item) => item.decision).join(", ") || "пусто"}
    </p>
  );
}

describe("post-call hooks in Tauri", () => {
  it("follows the build of a call and reads its summary again", async () => {
    let view: CallSummaryView = {
      building: progress("transcript", { status: "running" }),
      summary: stored("building"),
    };
    fake.answers.set("summary_get", () => view);
    render(<SummaryProbe />);
    expect(screen.getByText("loading: нет, без сборки")).toBeTruthy();
    // A window opened during the build shows the stage it is at.
    await screen.findByText("ready: building, transcript running");
    await waitFor(() =>
      expect(fake.handlers.get("summary-progress")?.size).toBe(1)
    );

    act(() => {
      fake.emit("summary-progress", progress("summary", { status: "running" }));
      // Another call's build is not this one.
      fake.emit(
        "summary-progress",
        progress("saving", { status: "running" }, "other-call")
      );
    });
    await screen.findByText("ready: building, summary running");

    // Saved: the call's `DataChanged`, then the end of the build.
    view = { building: null, summary: stored("ready") };
    const reads = fake.invoked.filter(
      (call) => call.command === "summary_get"
    ).length;
    act(() => {
      fake.dataChanged({
        change: "updated",
        entity: "call",
        id: CALL,
        projectId: PROJECT,
      });
      fake.emit("summary-progress", progress("saving", { status: "done" }));
    });
    await screen.findByText("ready: ready, без сборки");
    expect(
      fake.invoked.filter((call) => call.command === "summary_get").length
    ).toBeGreaterThan(reads);
  });

  it("reads a call's proposals again after a decision", async () => {
    let listed = [proposal("pending")];
    fake.answers.set("proposals_list", () => listed);
    fake.answers.set("proposal_decide", () => {
      listed = [proposal("accepted")];
      queueMicrotask(() =>
        fake.dataChanged({
          change: "updated",
          entity: "call",
          id: CALL,
          projectId: PROJECT,
        })
      );
      return listed[0];
    });
    render(<ProposalsProbe />);
    await screen.findByText("ready: pending");

    const decided = await act(() =>
      decideProposal(proposal("pending"), { decision: "accepted" })
    );
    expect(decided?.decision).toBe("accepted");
    expect(lastArgs("proposal_decide")).toEqual({
      id: proposal("pending").id,
      input: { decision: "accepted" },
    });
    await screen.findByText("ready: accepted");
  });
});
