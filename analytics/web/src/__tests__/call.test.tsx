// «Звонок» (spec analytics-web, tasks 7.3 and 7.4): the timeline, an agent
// call whole, a question's lineage and a finding's way.

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallView } from "@/views/call";
import {
  agentCall,
  details,
  finding,
  findingDetails,
  MINUTE,
  question,
  segment,
  timeline,
} from "./helpers/data";
import { change, serve } from "./helpers/fake-server";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("id=call-1"),
}));

const LIVE_PHRASE = /если все заняты звонок/u;
const QUESTION_CHIP = /Сколько ждёт звонок/u;
const FINDING_CHIP = /Находка · Регламент/u;

beforeEach(() => {
  serve({});
});

const phrases = () =>
  screen.getAllByTestId("phrase").map((row) => row.textContent ?? "");

const openCall = (index = 0) => {
  const mark = screen.getAllByTestId("agent-call")[index];
  if (!mark) {
    throw new Error(`no agent call mark ${index}`);
  }
  fireEvent.click(mark);
};

describe("«Таймлайн звонка»", () => {
  it("«Итог звонка»: tokens and $ of the whole call and of each kind", async () => {
    const calls = [
      ...Array.from({ length: 40 }, (_, i) =>
        agentCall(`fast-${i}`, (i + 1) * 10_000, { costUsd: 0.01 })
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        agentCall(`slow-${i}`, (i + 1) * 100_000, {
          costUsd: 0.05,
          kind: "slowLoop",
        })
      ),
      agentCall("summary", 900_000, { costUsd: 0.2, kind: "summary" }),
    ];
    serve({ "/api/calls/call-1": timeline({ agentCalls: calls }) });
    render(<CallView />);

    const top = await screen.findByTestId("call-totals");
    // 40 × 0.01 + 3 × 0.05 + 0.2
    expect(top.textContent).toContain("$0.750");
    expect(top.textContent).toContain("44");
    // Every call is 30 000 cache read, 2 in, 600 out.
    expect(top.textContent).toContain("1.3M");

    const kinds = within(screen.getByTestId("kind-totals"))
      .getAllByRole("row")
      .map((row) => row.textContent ?? "");
    expect(kinds).toHaveLength(3);
    expect(kinds.find((row) => row.startsWith("Быстрый контур"))).toContain(
      "40 вызовов"
    );
    expect(kinds.find((row) => row.startsWith("Быстрый контур"))).toContain(
      "$0.400"
    );
    expect(kinds.find((row) => row.startsWith("Медленный контур"))).toContain(
      "$0.150"
    );
    expect(kinds.find((row) => row.startsWith("Итоги звонка"))).toContain(
      "$0.200"
    );
    expect(screen.getAllByTestId("agent-call")).toHaveLength(44);
  });

  it("«Уточнённая расшифровка»: shown, and the call's live phrases stay by its link", async () => {
    serve({
      "/api/agent-calls/ac-1": details(agentCall("ac-1", 66_000)),
      "/api/calls/call-1": timeline({
        agentCalls: [
          agentCall("ac-1", 66_000, {
            triggerSegmentId: "seg-2",
            windowSegments: ["seg-1", "seg-2"],
          }),
        ],
        liveSegments: [
          segment("seg-1", 55_000, "Здравствуйте", "me"),
          segment("seg-2", 61_000, "если все заняты звонок встаёт в очередь"),
        ],
        recordings: [
          {
            endedAt: null,
            id: "rec-1",
            refined: true,
            startedAt: timeline().call.startedAt ?? 0,
            status: "finished",
          },
        ],
        segments: [
          segment("ref-1", 54_800, "Здравствуйте!", "me"),
          segment("ref-2", 61_000, "Если все заняты, звонок встаёт в очередь."),
        ],
      }),
    });
    render(<CallView />);

    await screen.findByTestId("call-totals");
    expect(phrases()).toEqual([
      expect.stringContaining("Здравствуйте!"),
      expect.stringContaining("Если все заняты, звонок встаёт в очередь."),
    ]);
    expect(screen.queryByText(LIVE_PHRASE)).toBeNull();

    openCall();
    const panel = await screen.findByTestId("agent-call-panel");
    // The phrase the call was set off by, as the agent heard it.
    expect(panel.textContent).toContain(
      "«если все заняты звонок встаёт в очередь»"
    );
    // Its window lights the refined phrases at the same time.
    const lit = screen
      .getAllByTestId("phrase")
      .filter((row) => row.dataset.highlighted === "true");
    expect(lit).toHaveLength(2);
  });

  it("«Чтение во время звонка»: open details stay, new phrases come at the end", async () => {
    const call = agentCall("ac-1", 5 * MINUTE);
    const before = timeline({
      agentCalls: [call],
      segments: [segment("s-1", 4 * MINUTE, "Очередь звонков")],
    });
    serve({
      "/api/agent-calls/ac-1": details(call),
      "/api/calls/call-1": before,
    });
    render(<CallView />);
    await screen.findByTestId("call-totals");
    openCall();
    const panel = await screen.findByTestId("agent-call-panel");
    await within(panel).findByText("Ответ CLI");

    serve({
      "/api/agent-calls/ac-1": details(call),
      "/api/calls/call-1": {
        ...before,
        segments: [
          ...before.segments,
          segment("s-2", 6 * MINUTE, "А если оператор занят?"),
          segment("s-3", 7 * MINUTE, "Тогда звонок ждёт"),
        ],
      },
    });
    change();

    await waitFor(() => expect(phrases()).toHaveLength(3));
    expect(phrases().at(-1)).toContain("Тогда звонок ждёт");
    // The same panel, still open, its prompt not read again from scratch.
    expect(screen.getByTestId("agent-call-panel")).toBe(panel);
    expect(within(panel).getByText("Ответ CLI")).toBeDefined();
  });
});

describe("«Вызов агента целиком»", () => {
  it("«Отклонённый вопрос»: rejected with «цитата не найдена» and the quote", async () => {
    const call = agentCall("ac-1", MINUTE, {
      ops: [
        {
          applied: false,
          idx: 0,
          op: "question",
          reason: { quote: "клиент ждёт пять минут", reason: "quoteNotFound" },
          subjectId: null,
          subjectKind: null,
        },
      ],
    });
    serve({
      "/api/agent-calls/ac-1": details(call, {
        reply: {
          ops: [{ op: "question", text: "Сколько ждёт клиент?" }],
        },
      }),
      "/api/calls/call-1": timeline({ agentCalls: [call] }),
    });
    render(<CallView />);
    await screen.findByTestId("call-totals");
    openCall();

    const op = await screen.findByTestId("op");
    expect(op.textContent).toContain("отклонена");
    expect(op.textContent).toContain(
      "цитата не найдена: «клиент ждёт пять минут»"
    );
    await waitFor(() =>
      expect(op.textContent).toContain("Сколько ждёт клиент?")
    );
  });

  it("«Ошибка вызова»: the mark says «таймаут», the details the prompt and no reply", async () => {
    const call = agentCall("ac-1", MINUTE, {
      costUsd: null,
      error: "CLI не ответил за 60 с",
      outcome: "timeout",
    });
    serve({
      "/api/agent-calls/ac-1": details(call, {
        parts: [
          { hash: "h-system", label: "system", text: "Ты помощник." },
          { hash: "h-window", label: "window", text: "Клиент: очередь" },
        ],
        rawReply: null,
        reply: null,
      }),
      "/api/calls/call-1": timeline({ agentCalls: [call] }),
    });
    render(<CallView />);
    await screen.findByTestId("call-totals");

    const mark = screen.getByTestId("agent-call");
    expect(mark.textContent).toContain("таймаут");
    openCall();
    const panel = await screen.findByTestId("agent-call-panel");
    expect(panel.textContent).toContain("CLI не ответил за 60 с");
    await within(panel).findByTestId("no-reply");
    expect(panel.textContent).toContain("Промпт · 2 частей");
    expect(within(panel).getByText("system")).toBeDefined();
    expect(within(panel).getByText("window")).toBeDefined();
  });

  it("marks the prompt parts the call before it had", async () => {
    const first = agentCall("ac-1", MINUTE);
    const second = agentCall("ac-2", 2 * MINUTE);
    serve({
      "/api/agent-calls/ac-1": details(first),
      "/api/agent-calls/ac-2": details(second, {
        parts: [
          { hash: "h-system", label: "system", text: "Ты помощник." },
          { hash: "h-new", label: "window", text: "Клиент: очередь" },
        ],
      }),
      "/api/calls/call-1": timeline({ agentCalls: [first, second] }),
    });
    render(<CallView />);
    await screen.findByTestId("call-totals");
    openCall(1);
    const panel = await screen.findByTestId("agent-call-panel");
    const system = (await within(panel).findByText("system")).closest(
      "summary"
    );
    expect(system?.textContent).toContain("как в прошлом вызове");
    const window = within(panel).getByText("window").closest("summary");
    expect(window?.textContent).not.toContain("как в прошлом вызове");
  });
});

describe("«Родословная вопроса»", () => {
  it("«Скрытый вопрос»: its creator, its grounds, «показан 12:03», «скрыт 14:10»", async () => {
    const start = timeline().call.startedAt ?? 0;
    const creator = agentCall("ac-12", 12 * MINUTE, {
      ops: [
        {
          applied: true,
          idx: 0,
          op: "question",
          reason: null,
          subjectId: "q-1",
          subjectKind: "question",
        },
      ],
    });
    serve({
      "/api/agent-calls/ac-12": details(creator),
      "/api/calls/call-1": timeline({
        agentCalls: [creator],
        questionSteps: [
          {
            agentCallId: null,
            at: start + 12 * MINUTE + 3000,
            id: "e-1",
            step: "shown",
            subjectId: "q-1",
          },
          {
            agentCallId: null,
            at: start + 14 * MINUTE + 10_000,
            id: "e-2",
            step: "hidden",
            subjectId: "q-1",
          },
        ],
        questions: [
          question("q-1", 12 * MINUTE, {
            evidence: [{ id: "s-1", source: "segment" }],
            status: "hidden",
          }),
        ],
        segments: [
          segment(
            "s-1",
            11 * MINUTE,
            "Звонок стоит в очереди, пока все заняты"
          ),
        ],
      }),
    });
    render(<CallView />);
    await screen.findByTestId("call-totals");

    // The question is on the phrase it rests on.
    const phrase = screen.getByTestId("phrase");
    fireEvent.click(
      within(phrase).getByRole("button", { name: QUESTION_CHIP })
    );
    const panel = await screen.findByTestId("question-panel");
    expect(within(panel).getByText("Быстрый контур · 12:00")).toBeDefined();
    expect(panel.textContent).toContain(
      "«Звонок стоит в очереди, пока все заняты»"
    );
    const history = within(panel).getByTestId("history").querySelectorAll("li");
    expect([...history].map((item) => item.textContent)).toEqual([
      "12:03показан",
      "14:10скрыт",
    ]);

    // The creator opens from the question.
    fireEvent.click(within(panel).getByText("Быстрый контур · 12:00"));
    expect(await screen.findByTestId("agent-call-panel")).toBeDefined();
  });
});

describe("«Outline и ClickUp в звонке»", () => {
  it("«Находка стала основанием»: both calls and the question at the finding, the finding at the question", async () => {
    const found = finding("f-1", 3 * MINUTE);
    const contradiction = question("q-1", 5 * MINUTE, {
      evidence: [
        { id: "s-1", source: "segment" },
        { id: "f-1", source: "document" },
      ],
      gapType: "contradiction",
      text: "Сколько секунд ждёт клиент — 30 или 60?",
    });
    serve({
      "/api/calls/call-1": timeline({
        agentCalls: [
          agentCall("slow-1", 2 * MINUTE, { kind: "slowLoop" }),
          agentCall("ac-4", 4 * MINUTE, { findingsInPrompt: ["f-1"] }),
          agentCall("ac-5", 5 * MINUTE, {
            findingsInPrompt: ["f-1"],
            ops: [
              {
                applied: true,
                idx: 0,
                op: "question",
                reason: null,
                subjectId: "q-1",
                subjectKind: "question",
              },
            ],
          }),
        ],
        findings: [found],
        questions: [contradiction],
        segments: [segment("s-1", 4 * MINUTE + 30_000, "Ждёт минуту")],
      }),
      "/api/findings/f-1": findingDetails(found, {
        citedBy: ["q-1"],
        givenTo: ["ac-4", "ac-5"],
      }),
    });
    render(<CallView />);
    await screen.findByTestId("call-totals");

    fireEvent.click(screen.getByRole("button", { name: FINDING_CHIP }));
    const panel = await screen.findByTestId("finding-panel");
    expect(
      within(panel).getByRole("link", { name: "Регламент смен" })
    ).toBeDefined();
    const given = within(within(panel).getByTestId("given-to"))
      .getAllByRole("button")
      .map((item) => item.textContent);
    expect(given).toEqual(["Быстрый контур · 04:00", "Быстрый контур · 05:00"]);
    const cited = within(panel).getByTestId("cited-by");
    fireEvent.click(
      within(cited).getByText("Сколько секунд ждёт клиент — 30 или 60?")
    );

    const lineage = await screen.findByTestId("question-panel");
    expect(within(lineage).getByText("Находка · Регламент смен")).toBeDefined();
    expect(within(lineage).getByText("Быстрый контур · 05:00")).toBeDefined();
  });
});
