import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURRENT_CALL_ID,
  resetCall,
  useCallSession,
} from "@/data/call-session";

const push = vi.fn();
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/call",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push,
    replace: vi.fn(),
  }),
  useSearchParams: () => search,
}));

const { CallPage } = await import("@/features/call/pages/call-page");
const { routes } = await import("@/lib/routes");

const PINNED_LABEL = /^Закреплён вами в/u;
const FINAL_CHECK_ANCHOR = /^Финальная проверка/u;
const RETURN_TO_FINAL_CHECK = /^К финальной проверке/u;

const AMO_QUESTION = "Используем текущую интеграцию с amoCRM или делаем новую?";

function openCall(demo?: string) {
  search = new URLSearchParams(demo ? { demo } : {});
  return render(<CallPage />);
}

function sessionStatus() {
  const { result, unmount } = renderHook(() => useCallSession());
  const { status } = result.current;
  unmount();
  return status;
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function questionRow(title: string) {
  return screen.getByRole("group", { name: title });
}

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  resetCall();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/call", () => {
  it("starts the demo call and streams the transcript and questions", () => {
    openCall();

    expect(sessionStatus()).toBe("live");
    expect(
      screen.getByText(
        "Слушаю. Первые вопросы появятся, когда станет понятна тема"
      )
    ).toBeTruthy();
    expect(
      screen.getByRole("timer", { name: "Идёт запись, 00:48" })
    ).toBeTruthy();

    advance(5000);
    expect(
      screen.getByText("Что происходит, если все операторы заняты?")
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Слушаю. Первые вопросы появятся, когда станет понятна тема"
      )
    ).toBeNull();
    expect(
      screen.getByRole("timer", { name: "Идёт запись, 00:53" })
    ).toBeTruthy();

    advance(30_000);
    expect(
      screen.getByRole("heading", { name: "Интеграция с CRM" })
    ).toBeTruthy();
    expect(screen.getByText(AMO_QUESTION)).toBeTruthy();
  });

  it("moves a question to the topic history and back", () => {
    openCall("reference");

    fireEvent.click(
      within(questionRow(AMO_QUESTION)).getByRole("button", {
        name: "Уже спросил",
      })
    );
    expect(screen.queryByRole("group", { name: AMO_QUESTION })).toBeNull();
    expect(screen.getByText("Вы отметили, что спросили")).toBeTruthy();

    const entry = screen.getByText(AMO_QUESTION).closest("li");
    if (!entry) {
      throw new Error("The asked question is not in the topic history");
    }
    fireEvent.click(within(entry).getByRole("button", { name: "Вернуть" }));
    expect(questionRow(AMO_QUESTION)).toBeTruthy();
    expect(screen.queryByText("Вы отметили, что спросили")).toBeNull();
  });

  it("pins and unpins a question", () => {
    openCall("reference");

    fireEvent.click(
      within(questionRow(AMO_QUESTION)).getByRole("button", {
        name: "Закрепить наверху темы",
      })
    );
    expect(screen.getByText(PINNED_LABEL)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Открепить" }));
    expect(screen.queryByText(PINNED_LABEL)).toBeNull();
    expect(
      within(questionRow(AMO_QUESTION)).getByRole("button", {
        name: "Скрыть вопрос",
      })
    ).toBeTruthy();
  });

  it("hides a question with H", () => {
    openCall("reference");

    fireEvent.keyDown(
      within(questionRow(AMO_QUESTION)).getByRole("button", {
        name: "Уже спросил",
      }),
      { key: "h" }
    );
    expect(screen.queryByRole("group", { name: AMO_QUESTION })).toBeNull();
    expect(screen.getAllByText("Вы скрыли")).toHaveLength(2);
  });

  it("collapses and expands the transcript", () => {
    openCall("reference");

    fireEvent.click(screen.getByRole("button", { name: "свернуть" }));
    expect(screen.queryByRole("heading", { name: "Расшифровка" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Развернуть расшифровку" })
    );
    expect(screen.getByRole("heading", { name: "Расшифровка" })).toBeTruthy();
  });

  it("ends the call, collects the summary and opens it", () => {
    openCall("reference");

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(sessionStatus()).toBe("finishing");
    expect(screen.getByText("Собираю итоги…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Завершить" })).toBeNull();

    advance(5000);
    expect(push).toHaveBeenCalledWith(routes.callSummary(CURRENT_CALL_ID));
  });

  it("cancels the end of the call", () => {
    openCall("reference");

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Отменить завершение" })
    );

    expect(sessionStatus()).toBe("live");
    expect(screen.queryByText("Собираю итоги…")).toBeNull();
    advance(10_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("counts down the mic panel and lets the call go on", () => {
    openCall("mic-released");

    expect(screen.getByText("6:48")).toBeTruthy();
    advance(2000);
    expect(screen.getByText("6:46")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(
      screen.queryByText("Микрофон больше не используется. Завершить звонок?")
    ).toBeNull();
  });

  it("brings the agent back with Повторить", () => {
    openCall("agent-timeout");

    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", {
        name: "Повторить",
      })
    );
    advance(1500);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Новый, только что")).toBeTruthy();
  });

  it("leaves the final check for the topics", () => {
    openCall("final-check");

    expect(
      screen.getByRole("button", { name: FINAL_CHECK_ANCHOR })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Вернуться к темам" }));
    expect(
      screen.queryByRole("button", { name: FINAL_CHECK_ANCHOR })
    ).toBeNull();
  });

  it("brings the final check back after leaving it", () => {
    openCall("final-check");

    fireEvent.click(screen.getByRole("button", { name: "Вернуться к темам" }));
    expect(screen.queryByText("Похоже, разговор идёт к концу")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: RETURN_TO_FINAL_CHECK })
    );
    expect(screen.getByText("Похоже, разговор идёт к концу")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: FINAL_CHECK_ANCHOR })
    ).toBeTruthy();
  });

  it("reconnects GitHub", () => {
    openCall("github-unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Подключить снова" }));
    advance(1500);
    expect(screen.queryByText("нет доступа")).toBeNull();
    expect(screen.getByText("telemedia/backend")).toBeTruthy();
  });
});
