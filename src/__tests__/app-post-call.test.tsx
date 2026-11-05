import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/calls/summary",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push,
    replace: vi.fn(),
  }),
  useSearchParams: () => search,
}));

const { HistoryPage } = await import("@/features/post-call/pages/history-page");
const { CallSummaryPage } = await import(
  "@/features/post-call/pages/call-summary-page"
);
const { ProposalsPage } = await import(
  "@/features/post-call/pages/proposals-page"
);
const { TaskCardsPage } = await import(
  "@/features/post-call/pages/task-cards-page"
);
const { TranscriptPage } = await import(
  "@/features/post-call/pages/transcript-page"
);
const { CURRENT_CALL_ID, finishCall, resetCall, startCall, useCallSession } =
  await import("@/data/call-session");
const { resetCalls } = await import("@/data/calls");
const { toast } = await import("@/components/ui/toast");
const { SUMMARY_TLDR } = await import("@/features/post-call/mock");
const { routes } = await import("@/lib/routes");

const FIRST_CALL = /Приём звонков, Интеграция с CRM/u;
const MOMENT = /Здесь спросили/u;
const OPERATORS_ANSWER = /Ответ на «Сколько операторов/u;
const PROPOSALS = /Предложения/u;
const TASK_CARDS_NAV = /Карточки задач/u;
const CLIENT_SOURCE = /сказал клиент, 12:02/u;
const EDITED_CRM = /amoCRM, ключ у Игоря/u;
/** `momentParam` of the demo's phrases: recording, offset, segment. */
const OPERATORS_POINT = "telemedia-19-oct-recording@195000@t-120415";
const QUEUE_FACT = "telemedia-19-oct-recording@74000@t-120214";
const CLICKUP_SOON = /Отправить в ClickUp\s*скоро/u;
const GITHUB_SOON = /Отправить в GitHub\s*скоро/u;
const OPERATORS_QUESTION = /Сколько операторов/u;
const ALL_PROJECTS = /^Все проекты/u;
const COLLECT_MS = 3000;

let probed: ReturnType<typeof useCallSession> | undefined;

/** Reads the call session the way the call screens do. */
function SessionProbe() {
  probed = useCallSession();
  return null;
}

function open(Page: ComponentType, query: Record<string, string> = {}) {
  search = new URLSearchParams(query);
  return render(<Page />);
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function linkHref(name: string | RegExp) {
  return screen.getByRole("link", { name }).getAttribute("href");
}

beforeEach(() => {
  push.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  act(() => {
    resetCalls();
    resetCall();
  });
});

describe("history", () => {
  it("lists every call and links rows to their summaries", () => {
    open(HistoryPage);

    expect(screen.getByText("Все проекты", { selector: "p" })).toBeTruthy();
    expect(linkHref(FIRST_CALL)).toBe(routes.callSummary(CURRENT_CALL_ID));
    expect(
      screen.getByRole("link", { name: "Начать звонок" }).getAttribute("href")
    ).toBe(routes.startWidget());
  });

  it("filters by project and searches transcripts", () => {
    open(HistoryPage, { project: "lapa" });

    expect(screen.getByText("Онлайн-запись и напоминания")).toBeTruthy();
    expect(screen.queryByText(FIRST_CALL)).toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Поиск по звонкам" }),
      { target: { value: "операторов" } }
    );
    // The project's calls first; «Все проекты» widens the search.
    expect(screen.queryByRole("link", { name: FIRST_CALL })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: ALL_PROJECTS }));
    const result = screen.getByRole("link", { name: FIRST_CALL });
    expect(result.getAttribute("href")).toContain("/calls/transcript");
    expect(result.getAttribute("href")).toContain("moment=");
  });

  it("shows the empty state and a missing project", () => {
    const { unmount } = open(HistoryPage, { project: "rhythm" });
    expect(
      screen.getByRole("heading", { name: "Звонков пока не было" })
    ).toBeTruthy();
    unmount();

    open(HistoryPage, { project: "nope" });
    expect(
      screen.getByRole("heading", { name: "Проект не найден" })
    ).toBeTruthy();
    expect(linkHref("На главную")).toBe(routes.home());
  });
});

describe("summary", () => {
  it("links the panel nav and the breadcrumbs to real routes", () => {
    open(CallSummaryPage, { id: CURRENT_CALL_ID });

    const nav = screen.getByRole("navigation", { name: "Разделы звонка" });
    expect(
      within(nav).getByRole("link", { name: TASK_CARDS_NAV })
    ).toBeTruthy();
    expect(
      within(nav).getByRole("link", { name: PROPOSALS }).getAttribute("href")
    ).toBe(routes.callProposals(CURRENT_CALL_ID));
    const crumbs = screen.getByRole("navigation", { name: "Путь" });
    expect(
      within(crumbs)
        .getByRole("link", { name: "Телемедиа" })
        .getAttribute("href")
    ).toBe(routes.project("telemedia"));
    expect(linkHref("Открыть расшифровку на 12:04")).toBe(
      routes.callTranscript(CURRENT_CALL_ID, OPERATORS_POINT)
    );
  });

  it("collects the summary of a call that just ended", () => {
    vi.useFakeTimers();
    const add = vi.spyOn(toast, "add");
    act(() => {
      startCall({ participantIds: ["olga"], projectId: "telemedia" });
      finishCall();
    });
    render(<SessionProbe />);

    open(CallSummaryPage, { id: CURRENT_CALL_ID });
    expect(
      screen.getByRole("heading", { level: 1, name: "Собираю итоги" })
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Карточки задач" })).toBeNull();

    expect(
      screen.queryByRole("heading", { name: "Ответы для ClickUp" })
    ).toBeNull();
    expect(screen.getByText("Собираю итоги и карточки задач")).toBeTruthy();

    advance(COLLECT_MS);
    expect(
      screen.getByRole("heading", { level: 1, name: "Итоги звонка" })
    ).toBeTruthy();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Итоги сохранены" })
    );
    expect(probed?.status).toBe("idle");
  });

  it("Демо в браузере: the Телемедиа demo summary, without ClickUp", () => {
    open(CallSummaryPage, { id: CURRENT_CALL_ID });

    expect(screen.getByText(SUMMARY_TLDR.text)).toBeTruthy();
    expect(screen.getByText("Приём звонков, Интеграция с CRM")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Интеграция с CRM" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Ответы для ClickUp" })
    ).toBeNull();
  });

  it("a point's time opens the details page at its phrase", () => {
    open(TranscriptPage, { id: CURRENT_CALL_ID, moment: OPERATORS_POINT });

    expect(screen.getByLabelText("Момент 12:04")).toBeTruthy();
  });

  it("says when the call is unknown", () => {
    open(CallSummaryPage, { id: "nope" });

    expect(
      screen.getByRole("heading", { name: "Звонок не найден" })
    ).toBeTruthy();
    expect(linkHref("На главную")).toBe(routes.home());
  });
});

describe("proposals", () => {
  it("accepts, rejects, edits and undoes until all is reviewed", () => {
    open(ProposalsPage, { id: CURRENT_CALL_ID });
    expect(screen.getByText("разобрано 3 из 7")).toBeTruthy();

    const channels = screen.getByRole("article", {
      name: "Раздел «Продукт»",
    });
    fireEvent.click(within(channels).getByRole("button", { name: "Принять" }));
    expect(screen.getByText("разобрано 4 из 7")).toBeTruthy();

    const tech = screen.getByRole("article", {
      name: "Как формулировать вопросы",
    });
    fireEvent.click(within(tech).getByRole("button", { name: "Отклонить" }));
    expect(screen.getByText("разобрано 5 из 7")).toBeTruthy();

    const crm = screen.getByRole("article", { name: "Раздел «Стек»" });
    fireEvent.click(within(crm).getByRole("button", { name: "Изменить" }));
    const editor = screen.getByRole("textbox", { name: "Новый текст" });
    fireEvent.change(editor, { target: { value: "amoCRM, ключ у Игоря" } });
    fireEvent.keyDown(editor, { ctrlKey: true, key: "Enter" });
    expect(screen.getByText(EDITED_CRM)).toBeTruthy();
    expect(screen.getByText("разобрано 6 из 7")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Вернуть" })[0]);
    expect(screen.getByText("разобрано 5 из 7")).toBeTruthy();

    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByRole("heading", { name: "Всё разобрано" })).toBeTruthy();
    expect(linkHref("К итогам звонка")).toBe(
      routes.callSummary(CURRENT_CALL_ID)
    );
  });
});

describe("task cards", () => {
  it("accepts a card; sending to ClickUp or GitHub is «скоро»", async () => {
    open(TaskCardsPage, { id: CURRENT_CALL_ID });

    const card = screen.getByRole("region", { name: "Приём звонков" });
    fireEvent.click(within(card).getByRole("button", { name: "Принять" }));
    expect(await within(card).findByText("принята")).toBeTruthy();
    // Unavailable, but focusable: a screen reader hears why.
    const clickUp = within(card).getByRole("button", { name: CLICKUP_SOON });
    expect(clickUp.getAttribute("aria-disabled")).toBe("true");
    expect(
      within(card)
        .getByRole("button", { name: GITHUB_SOON })
        .getAttribute("aria-disabled")
    ).toBe("true");
  });

  it("discards a card and brings it back", async () => {
    open(TaskCardsPage, { id: CURRENT_CALL_ID });

    const card = screen.getByRole("region", { name: "Интеграция с CRM" });
    fireEvent.click(within(card).getByRole("button", { name: "Отбросить" }));
    expect(await within(card).findByText("отброшена")).toBeTruthy();
    expect(within(card).queryByText("Цель")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Вернуть" }));
    expect(await within(card).findByText("Цель")).toBeTruthy();
  });

  it("opens the source quote and links it to the transcript", () => {
    open(TaskCardsPage, { id: CURRENT_CALL_ID });

    fireEvent.click(screen.getAllByRole("button", { name: CLIENT_SOURCE })[0]);
    expect(linkHref("Открыть в расшифровке")).toBe(
      routes.callTranscript(CURRENT_CALL_ID, QUEUE_FACT)
    );
    // «Послушать» opens the details page playing from the phrase.
    fireEvent.click(screen.getByRole("button", { name: "Послушать" }));
    expect(push).toHaveBeenCalledWith(
      routes.callTranscript(CURRENT_CALL_ID, QUEUE_FACT, true)
    );
  });
});

describe("transcript", () => {
  it("highlights the moment from the link and from a question", () => {
    open(TranscriptPage, { id: CURRENT_CALL_ID, moment: "phone" });
    expect(screen.getByLabelText(MOMENT)).toBeTruthy();
    expect(screen.getByText("29:12")).toBeTruthy();

    // An answered question opens the client's answer.
    fireEvent.click(screen.getByRole("button", { name: OPERATORS_QUESTION }));
    expect(screen.getByLabelText(OPERATORS_ANSWER)).toBeTruthy();
    expect(screen.getByText("3:15")).toBeTruthy();
  });

  it("plays and deletes the recording after confirmation", async () => {
    open(TranscriptPage, { id: CURRENT_CALL_ID });

    fireEvent.click(screen.getByRole("button", { name: "Слушать" }));
    expect(screen.getByRole("button", { name: "Пауза" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Удалить запись" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить запись звонка?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Удалить запись" })
    );
    expect(screen.queryByRole("region", { name: "Запись звонка" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Запись удалена" })
    ).toBeTruthy();
  });
});
