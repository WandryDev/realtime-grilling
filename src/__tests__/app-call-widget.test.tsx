import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/widget",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push,
    replace: vi.fn(),
  }),
  useSearchParams: () => search,
}));

const { StartWidgetPage } = await import(
  "@/features/call-widget/pages/start-widget-page"
);
const { OverlayPage } = await import(
  "@/features/call-widget/pages/overlay-page"
);
const { CURRENT_CALL_ID, resetCall } = await import("@/data/call-session");
const { updateSetting } = await import("@/data/settings");
const { routes } = await import("@/lib/routes");

const REMOVE_OLGA = /Убрать.*Ольга/u;
const FIRST_FEED_QUESTION = "Кто в клинике видит историю звонков пациента?";
const BRIEF_MS = 5000;
const HANDOVER_MS = 1200;
const FIRST_QUESTION_MS = 4000;

function open(Page: ComponentType, demo?: string) {
  search = new URLSearchParams(demo ? { demo } : {});
  return render(<Page />);
}

/** Link buttons are plain <a> links (`linkButtonProps` clears role="button"). */
function linkHref(name: string) {
  return screen.getByRole("link", { name }).getAttribute("href");
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Lets the backend answer: the recorder's start, the mic watch's events. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  push.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => resetCall());
});

describe("/widget", () => {
  it("starts the call with the last project and people", async () => {
    open(StartWidgetPage);

    expect(
      screen.getByRole("heading", { level: 1, name: "Начать звонок?" })
    ).toBeTruthy();
    expect(screen.getByText("Телемедиа")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: REMOVE_OLGA }));
    expect(screen.queryByRole("button", { name: REMOVE_OLGA })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Начать" }));
    await settle();
    expect(
      screen.getByRole("heading", { level: 1, name: "Готовлю бриф" })
    ).toBeTruthy();
    expect(
      screen.getByText("Телемедиа, с Игорем.", { exact: false })
    ).toBeTruthy();

    advance(BRIEF_MS);
    advance(HANDOVER_MS);
    expect(push).toHaveBeenCalledWith(routes.overlay());
  });

  it("collapses into the pill and starts from there", async () => {
    open(StartWidgetPage);

    fireEvent.click(screen.getByRole("button", { name: "Не сейчас" }));
    expect(screen.getByText("звонок в Zoom")).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Развернуть виджет" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Начать звонок?" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Не сейчас" }));
    fireEvent.click(screen.getByRole("button", { name: "Начать" }));
    await settle();
    expect(
      screen.getByRole("heading", { level: 1, name: "Готовлю бриф" })
    ).toBeTruthy();
  });

  it("links the launch card to the call window and the overlay", () => {
    open(StartWidgetPage, "launching");

    expect(linkHref("Открыть окно звонка")).toBe(routes.call());
    expect(linkHref("Оверлей")).toBe(routes.overlay());
  });

  it("hides the pill and can show the widget again", () => {
    open(StartWidgetPage, "collapsed");

    fireEvent.click(screen.getByRole("button", { name: "Скрыть" }));
    expect(screen.getByText("Виджет скрыт до следующего звонка")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Показать снова" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Начать звонок?" })
    ).toBeTruthy();
  });
});

describe("/overlay", () => {
  it("puts a new question from the agent on top", () => {
    open(OverlayPage);

    expect(
      screen.getByRole("heading", { level: 1, name: "Интеграция с CRM" })
    ).toBeTruthy();
    expect(linkHref("Открыть окно звонка")).toBe(routes.call());

    advance(FIRST_QUESTION_MS);
    expect(screen.getByText(FIRST_FEED_QUESTION)).toBeTruthy();
    expect(screen.getByText("слушаю")).toBeTruthy();
  });

  it("says «не видно в демонстрации» only while «Скрывать при демонстрации» is on", () => {
    const page = open(OverlayPage);
    expect(screen.getByText("не видно в демонстрации")).toBeTruthy();
    page.unmount();

    act(() => {
      updateSetting("hideOnShare", false);
    });
    try {
      open(OverlayPage);
      expect(screen.queryByText("не видно в демонстрации")).toBeNull();
    } finally {
      act(() => {
        updateSetting("hideOnShare", true);
      });
    }
  });

  it("hides a question: the next one takes the main place", () => {
    open(OverlayPage);
    const main = "Записывать в CRM сам звонок или только факт и длительность?";
    const next = "Мобильное приложение входит в первый этап?";

    fireEvent.click(
      within(screen.getByRole("group", { name: main })).getByRole("button", {
        name: "Скрыть вопрос",
      })
    );

    expect(screen.queryByRole("group", { name: main })).toBeNull();
    expect(
      within(screen.getByRole("group", { name: next })).getByText(
        "Новый, только что"
      )
    ).toBeTruthy();
  });

  it("collapses into the pill and shows new questions under it", () => {
    open(OverlayPage);

    fireEvent.click(screen.getByRole("button", { name: "Свернуть в пилюлю" }));
    expect(screen.queryByRole("heading")).toBeNull();

    advance(FIRST_QUESTION_MS);
    expect(screen.getByText("Новый вопрос")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByText("Новый вопрос")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Развернуть оверлей" }));
    expect(screen.getByText(FIRST_FEED_QUESTION)).toBeTruthy();
  });

  it("hides the new-question card after 8 seconds", () => {
    open(OverlayPage, "collapsed");

    expect(screen.getByText("Новый вопрос")).toBeTruthy();
    advance(3000);
    expect(screen.getByText("Новый вопрос")).toBeTruthy();
    advance(5000);
    expect(screen.queryByText("Новый вопрос")).toBeNull();
  });

  it("offers to end the call when the meeting app lets the mic go", async () => {
    open(OverlayPage);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Выйти из встречи" }));
    await settle();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Микрофон больше не используется. Завершить звонок?",
      })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Интеграция с CRM" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Выйти из встречи" }));
    await settle();
    expect(
      screen.getByText("Zoom отпустил микрофон", { exact: false })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(push).toHaveBeenCalledWith(routes.callSummary(CURRENT_CALL_ID));
  });

  it("opens the final check from ?demo", () => {
    open(OverlayPage, "final-check");

    expect(
      screen.getByRole("heading", { level: 1, name: "Финальная проверка" })
    ).toBeTruthy();
  });
});
