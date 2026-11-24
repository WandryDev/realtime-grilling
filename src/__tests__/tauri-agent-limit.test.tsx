import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LimitHit, SubscriptionLimitView } from "@/bindings";

/*
 * The share of the subscription limit in Tauri mode (agent-limit-guard
 * tasks 5.1, 5.2), over the fake IPC (./helpers/fake-tauri.ts):
 * - every screen of a window follows `SubscriptionLimitChanged`;
 * - the start widget warns before a call (`agent-limit`, «Предупреждение
 *   перед звонком»): «Почти заполнен», «Порог пройден», «Запас есть»;
 *   «Начать сверх лимита» starts the call with the flag.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => {
    fake.emit(event, payload);
    return Promise.resolve();
  },
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: vi.fn(() => Promise.resolve()),
    label: "widget",
    listen: fake.listen,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

const { fakeProject, IDLE_SESSION, NO_LIMIT_DATA } = await import(
  "./helpers/fake-tauri"
);
const { useLimitOutlook } = await import("@/data/agent-limit");
const { StartWidgetPage } = await import(
  "@/features/call-widget/pages/start-widget-page"
);
const { CallPage } = await import("@/features/call/pages/call-page");
const { followCallSession } = await import("@/data/call-session");
const { refreshProjects } = await import("@/data/projects");
const { refreshPeople } = await import("@/data/people");
const { refreshCalls } = await import("@/data/calls");
const { refreshSettings } = await import("@/data/settings");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const NOW = new Date(2026, 10, 24, 12, 0).getTime();
const AT_14_09 = new Date(2026, 10, 24, 14, 9).getTime();
const DEC_1 = new Date(2026, 11, 1, 0, 59).getTime();
const ANY_LIMIT = /Лимит/u;
const NEAR_DETAIL = /Сброс в 14:09\. Агент может встать/u;
const REACHED_DETAIL = /Сброс 1 декабря в 00:59/u;

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

/** The share with the session and the week at these percents. */
function limit(
  session: number,
  week: number,
  outlook: SubscriptionLimitView["outlook"]
): SubscriptionLimitView {
  return {
    ...NO_LIMIT_DATA,
    outlook,
    session: {
      measuredAt: NOW,
      resetsAt: AT_14_09,
      source: "usage",
      used: session,
    },
    week: { measuredAt: NOW, resetsAt: DEC_1, source: "usage", used: week },
  };
}

const SESSION_84: LimitHit = {
  resetsAt: AT_14_09,
  threshold: 90,
  used: 84,
  window: "session",
};
const WEEK_81: LimitHit = {
  resetsAt: DEC_1,
  threshold: 80,
  used: 81,
  window: "week",
};

/** Another screen of the same window reading the outlook. */
function OutlookProbe() {
  const outlook = useLimitOutlook();
  return <output aria-label="Прогноз">{outlook.kind}</output>;
}

async function setLimit(next: SubscriptionLimitView) {
  await act(async () => {
    fake.setLimit(next);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true, toFake: ["Date"] });
  fake.answers.clear();
  fake.failures.clear();
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(TELEMEDIA, "Телемедиа")
  );
  fake.db.people.length = 0;
  fake.db.calls.length = 0;
  fake.db.settings = { onboardingCompleted: true };
  act(() => fake.setSession(IDLE_SESSION));
  await setLimit(NO_LIMIT_DATA);
  await act(() => refreshProjects());
  await act(() => refreshPeople());
  await act(() => refreshCalls());
  await act(() => refreshSettings());
  fake.invoked.length = 0;
  return () => {
    vi.useRealTimers();
  };
});

describe("the share of the limit in a window", () => {
  it("an event changes the outlook of every screen that reads it", async () => {
    render(
      <>
        <OutlookProbe />
        <OutlookProbe />
      </>
    );
    await waitFor(() => expect(invokedWith("agent_limit_get")).not.toEqual([]));
    expect(
      screen
        .getAllByRole("status", { name: "Прогноз" })
        .map((probe) => probe.textContent)
    ).toEqual(["ok", "ok"]);

    await setLimit(limit(30, 81, { hit: WEEK_81, kind: "reached" }));
    expect(
      screen
        .getAllByRole("status", { name: "Прогноз" })
        .map((probe) => probe.textContent)
    ).toEqual(["reached", "reached"]);
  });
});

describe("the start widget before a call", () => {
  it("«Запас есть»: no warning", async () => {
    await setLimit(limit(60, 30, { kind: "ok" }));
    render(<StartWidgetPage />);

    expect(await screen.findByRole("button", { name: "Начать" })).toBeTruthy();
    expect(screen.queryByText(ANY_LIMIT)).toBeNull();
  });

  it("«Почти заполнен»: the warning, and «Начать» as usual", async () => {
    await setLimit(limit(84, 30, { hit: SESSION_84, kind: "near" }));
    render(<StartWidgetPage />);

    expect(
      await screen.findByText("Лимит почти заполнен: сессия 84 % из 90 %")
    ).toBeTruthy();
    expect(screen.getByText(NEAR_DETAIL)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Начать" }));
    await waitFor(() => expect(invokedWith("call_start")).toHaveLength(1));
    expect(invokedWith("call_start")[0]?.input).not.toHaveProperty("overLimit");
  });

  it("«Порог пройден»: without the agent, or over the limit with the flag", async () => {
    await setLimit(limit(30, 81, { hit: WEEK_81, kind: "reached" }));
    render(<StartWidgetPage />);

    expect(
      await screen.findByText("Лимит Grill исчерпан: неделя 81 % из 80 %")
    ).toBeTruthy();
    expect(screen.getByText(REACHED_DETAIL)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Начать без агента" })
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Начать сверх лимита" })
    );
    await waitFor(() => expect(invokedWith("call_start")).toHaveLength(1));
    expect(invokedWith("call_start")[0]?.input).toMatchObject({
      overLimit: true,
      projectId: TELEMEDIA,
    });
  });
});

describe("«Звонка нет» in the call window", () => {
  it("warns of the threshold before the start widget opens", async () => {
    followCallSession();
    await setLimit(limit(84, 30, { hit: SESSION_84, kind: "near" }));
    render(<CallPage />);

    expect(await screen.findByText("Звонка нет")).toBeTruthy();
    expect(
      screen.getByText("Лимит почти заполнен: сессия 84 % из 90 %")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Начать звонок" })).toBeTruthy();
  });
});
