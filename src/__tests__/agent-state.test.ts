import { describe, expect, it } from "vitest";

import {
  AGENT_LISTENING,
  NO_TOPIC_ID,
  toAgentQuestions,
  toAgentStatusView,
  withFooters,
} from "@/features/call/agent-state";
import type { TranscriptItem } from "@/features/call/types";

import {
  at,
  callState,
  NOON,
  question,
  STATE_RECORDING,
  segmentEvidence,
  topic,
  visible,
} from "./helpers/call-state";

/*
 * The adapter of the backend's call state (agent-fast-loop design.md,
 * decision 11): what the call window and the overlay draw of it.
 */

const CALLS = topic("t-calls", "Приём звонков", 0);
const CRM = topic("t-crm", "Интеграция с CRM", 1);
const LATER = at(30);

describe("toAgentQuestions", () => {
  it("listens before the agent names a topic", () => {
    const view = toAgentQuestions(callState(), { now: LATER });

    expect(view.empty).toEqual(AGENT_LISTENING);
    expect(view.current).toBeUndefined();
    expect(view.pastOpen).toBe(0);
  });

  it("takes the main question, the queue and the pinned one by rank", () => {
    const state = callState({
      currentTopicId: CRM.id,
      questions: [
        visible("q-3", "Третий", CRM.id, 2, { gapType: "assumption" }),
        visible("q-pin", "Закреплённый", CRM.id, 0, {
          pinned: true,
          updatedAt: at(12),
        }),
        visible("q-main", "Главный", CRM.id, 1),
        // Waits for room: not visible yet
        question("q-wait", "Ждёт", { priority: 3, topicId: CRM.id }),
      ],
      topics: [CALLS, CRM],
    });

    const { current, empty } = toAgentQuestions(state, { now: LATER });

    expect(empty).toBeUndefined();
    expect(current?.title).toBe("Интеграция с CRM");
    expect(current?.meta).toBe("идёт сейчас, с 12:10");
    expect(current?.pinned).toEqual({
      description: "Почему: Закреплённый",
      id: "q-pin",
      label: "Закреплён вами в 12:12",
      title: "Закреплённый",
    });
    expect(current?.main).toMatchObject({
      id: "q-main",
      status: "Сейчас важнее всего",
      title: "Главный",
    });
    expect(current?.questions).toEqual([
      {
        description: "Почему: Третий",
        id: "q-3",
        tag: "assumption",
        title: "Третий",
      },
    ]);
  });

  it("keeps a question pinned in an earlier topic in the current list, tagged with its topic", () => {
    const state = callState({
      currentTopicId: CRM.id,
      questions: [
        visible("q-pin", "Сколько операторов в смене?", CALLS.id, 0, {
          pinned: true,
          updatedAt: at(12),
        }),
        visible("q-pin2", "Есть ли очередь?", CALLS.id, 1, { pinned: true }),
        visible("q-pin3", "Кто старший смены?", CALLS.id, 2, { pinned: true }),
        visible("q-main", "Главный", CRM.id, 3),
        question("q-old", "Старый", { topicId: CALLS.id }),
        question("q-wait", "Ждёт", { priority: 3, topicId: CRM.id }),
      ],
      topics: [CALLS, CRM],
    });

    const view = toAgentQuestions(state, { now: LATER });

    // Every visible question is drawn, more pins than questionCount too
    expect(view.current?.pinned).toMatchObject({
      id: "q-pin",
      label: "Закреплён вами в 12:12, из темы «Приём звонков»",
    });
    expect(view.current?.main).toMatchObject({
      id: "q-pin2",
      status: "Сейчас важнее всего, из темы «Приём звонков»",
    });
    expect(view.current?.questions).toEqual([
      {
        description: "Почему: Кто старший смены?",
        id: "q-pin3",
        tag: "empty",
        title: "Кто старший смены?",
        topic: "Из темы «Приём звонков»",
      },
      {
        description: "Почему: Главный",
        id: "q-main",
        tag: "empty",
        title: "Главный",
      },
    ]);
    // Not twice: the earlier topic lists what the current list doesn't
    expect(view.previous?.questions.map((item) => item.id)).toEqual(["q-old"]);
    expect(view.pastOpen).toBe(1);
    // The current topic's history is its own
    expect(view.current?.history).toBeUndefined();
  });

  it("marks a fresh main question and a contradiction", () => {
    const state = callState({
      currentTopicId: CRM.id,
      questions: [
        visible("q-new", "Новый", CRM.id, 0, { shownAt: LATER - 5000 }),
        visible("q-app", "Приложение входит?", CRM.id, 1, {
          gapType: "contradiction",
        }),
      ],
      topics: [CRM],
    });

    const { current } = toAgentQuestions(state, { now: LATER });

    expect(current?.main?.status).toBe("Новый, только что");
    expect(current?.questions[0]?.tag).toBe("contradiction");

    const old = toAgentQuestions(state, { now: LATER + 120_000 });
    expect(old.current?.main?.status).toBe("Сейчас важнее всего");
  });

  it("keeps the history: the answer with its quote, «Вернуть» for hidden and asked", () => {
    const state = callState({
      currentTopicId: CRM.id,
      questions: [
        question("q-crm", "Какая CRM?", {
          answerEvidence: [segmentEvidence("s-2", "У нас amoCRM")],
          status: "answered",
          topicId: CRM.id,
          updatedAt: at(21),
        }),
        question("q-budget", "Какой бюджет?", {
          status: "hidden",
          topicId: CRM.id,
          updatedAt: at(22),
        }),
        question("q-admin", "Кто администрирует?", {
          status: "asked",
          topicId: CRM.id,
          updatedAt: at(23),
        }),
      ],
      topics: [CRM],
    });

    const history = toAgentQuestions(state, { now: LATER }).current?.history;

    expect(history?.items).toEqual([
      {
        answer: "«У нас amoCRM»",
        id: "q-crm",
        question: "Какая CRM?",
        status: "answered",
        time: "12:21",
      },
      // No time: the row offers «Вернуть» for the question's id
      {
        id: "q-budget",
        note: "Вы скрыли",
        question: "Какой бюджет?",
        status: "hidden",
      },
      {
        id: "q-admin",
        note: "Вы отметили, что спросили",
        question: "Кто администрирует?",
        status: "unanswered",
      },
    ]);
  });

  it("counts the open questions left in earlier topics", () => {
    const ADS = topic("t-ads", "Реклама", 2);
    const state = callState({
      currentTopicId: ADS.id,
      questions: [
        question("q-queue", "Очередь с музыкой?", {
          priority: 1,
          topicId: CALLS.id,
        }),
        question("q-lead", "Кто старший смены?", {
          priority: 3,
          topicId: CALLS.id,
        }),
        question("q-done", "Сколько операторов?", {
          status: "answered",
          topicId: CALLS.id,
        }),
        question("q-amo", "Текущая интеграция?", { topicId: CRM.id }),
        question("q-proto", "Показать прототип?"),
      ],
      topics: [ADS, CALLS, CRM],
    });

    const view = toAgentQuestions(state, { now: LATER });

    expect(view.pastOpen).toBe(3);
    // The newest earlier topic first
    expect(view.previous?.title).toBe("Интеграция с CRM");
    expect(view.previous?.meta).toBe("12:10–12:20, осталось 1");
    expect(view.earlier.map((item) => item.title)).toEqual(["Приём звонков"]);
    expect(view.earlier[0]?.questions.map((item) => item.id)).toEqual([
      "q-lead",
      "q-queue",
    ]);
    expect(view.noTopic).toMatchObject({
      id: NO_TOPIC_ID,
      questions: [{ id: "q-proto" }],
      title: "Без темы",
    });
  });

  it("builds the final check with the topic above each question", () => {
    const state = callState({
      currentTopicId: CRM.id,
      finalCheck: {
        questionIds: ["q-record", "q-mobile", "q-gone"],
        startedAt: at(38),
      },
      questions: [
        question("q-mobile", "Приложение в первом этапе?", {
          gapType: "contradiction",
          topicId: CALLS.id,
        }),
        visible("q-record", "Записывать звонок в CRM?", CRM.id, 0),
        question("q-gone", "Уже отвечен", {
          status: "answered",
          topicId: CALLS.id,
        }),
        question("q-other", "Ещё открытый", { topicId: CRM.id }),
      ],
      topics: [CALLS, CRM],
    });

    const { finalCheck } = toAgentQuestions(state, { now: LATER });

    expect(finalCheck?.title).toBe("Финальная проверка");
    expect(finalCheck?.meta).toBe("2 самых важных из 3 открытых");
    expect(finalCheck?.main).toMatchObject({
      id: "q-record",
      status: "Интеграция с CRM",
      title: "Записывать звонок в CRM?",
    });
    expect(finalCheck?.questions).toEqual([
      {
        description: "Почему: Приложение в первом этапе?",
        id: "q-mobile",
        tag: "contradiction",
        title: "Приложение в первом этапе?",
        topic: "Приём звонков",
      },
    ]);
  });

  it("has no final check once all its questions are closed", () => {
    const state = callState({
      finalCheck: { questionIds: ["q-gone"], startedAt: at(38) },
      questions: [question("q-gone", "Отвечен", { status: "answered" })],
    });

    expect(toAgentQuestions(state, { now: LATER }).finalCheck).toBeUndefined();
  });
});

describe("withFooters", () => {
  const phrase = (
    id: string,
    startMs: number,
    text: string
  ): TranscriptItem => ({
    id: `${STATE_RECORDING}:others:${startMs}`,
    kind: "client",
    segment: { id, startMs },
    text,
  });
  const items: TranscriptItem[] = [
    phrase("s-1", 6 * 60_000, "Приложение пока не трогаем"),
    { id: "me-1", kind: "me", text: "Сколько операторов?" },
    phrase("s-2", 8 * 60_000, "Пятеро на старте"),
    phrase("s-3", 12 * 60_000, "Из приложения тоже звонят, надо завести"),
  ];

  it("signs the answer and the later phrase of a contradiction, with the time of the earlier", () => {
    const questions = [
      question("q-ops", "Сколько операторов?", {
        answerEvidence: [segmentEvidence("s-2", "Пятеро")],
        status: "answered",
      }),
      question("q-app", "Приложение в первом этапе?", {
        evidence: [
          segmentEvidence("s-3", "тоже звонят"),
          segmentEvidence("s-1", "пока не трогаем"),
        ],
        gapType: "contradiction",
      }),
    ];

    const signed = withFooters(items, questions, NOON);

    expect(
      signed.map((item) => (item.kind === "client" ? item.footer : null))
    ).toEqual([
      undefined,
      null,
      { status: "answered", text: "ответ на вопрос" },
      {
        status: "contradiction",
        text: "противоречит сказанному в",
        time: "12:06",
      },
    ]);
    // Without the start of the recording: the time into it
    const offset = withFooters(items, questions).at(-1);
    expect(offset?.kind === "client" && offset.footer?.time).toBe("6:00");
  });

  it("drops a footer the questions no longer name", () => {
    const signed = withFooters(
      items,
      [
        question("q-ops", "Сколько операторов?", {
          answerEvidence: [segmentEvidence("s-2", "Пятеро")],
          status: "answered",
        }),
      ],
      NOON
    );
    const restored = withFooters(signed, [], NOON);

    expect(signed[2]).toHaveProperty("footer");
    expect(
      restored.every((item) => item.kind !== "client" || !item.footer)
    ).toBe(true);
  });
});

describe("toAgentStatusView", () => {
  const status = (
    state: Parameters<typeof toAgentStatusView>[0]["state"],
    utilization: number | null = null
  ) => ({
    recordingId: STATE_RECORDING,
    state,
    utilization,
  });

  it("listens while idle and thinks calmly", () => {
    expect(toAgentStatusView(status({ kind: "idle" }), LATER)).toEqual({
      agent: { state: "listening" },
      frozen: false,
      retryIn: null,
      thinking: false,
    });
    expect(
      toAgentStatusView(status({ kind: "thinking" }, 0.42), LATER)
    ).toMatchObject({
      agent: { state: "thinking" },
      thinking: true,
      usage: "лимит 42%",
    });
  });

  it("counts down to the retry of an error, with «Повторить»", () => {
    const view = toAgentStatusView(
      status({
        kind: "error",
        message: "Таймаут 30 с",
        retryAt: LATER + 29_500,
      }),
      LATER
    );

    expect(view.retryIn).toBe(30);
    expect(view.frozen).toBe(true);
    expect(view.banner).toMatchObject({
      actions: [{ id: "retry", label: "Повторить" }],
      footnote: "Таймаут 30 с",
      hint: { text: "Сам попробую через", time: "0:30" },
    });
  });

  it("leads to Settings → Агент when Claude Code needs a login", () => {
    const view = toAgentStatusView(status({ kind: "needsLogin" }), LATER);

    expect(view.banner?.actions).toEqual([
      expect.objectContaining({ href: "/settings/agent" }),
    ]);
    expect(view.agent.label).toBe("нужен вход");
  });

  it("names the reset time of a used-up limit", () => {
    expect(
      toAgentStatusView(
        status({ kind: "rateLimited", resetsAt: at(180) }, 1),
        LATER
      )
    ).toMatchObject({
      banner: { title: "Лимит подписки Claude исчерпан до 15:00" },
      retryIn: null,
      usage: "лимит 100%",
    });
    expect(
      toAgentStatusView(status({ kind: "rateLimited", resetsAt: null }), LATER)
        .banner?.title
    ).toBe("Лимит подписки Claude исчерпан");
  });
});
