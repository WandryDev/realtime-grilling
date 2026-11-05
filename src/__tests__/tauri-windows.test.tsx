import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The four Tauri windows load at start and stay loaded; each knows itself
 * by its label. Over the fake IPC (./helpers/fake-tauri.ts):
 * - the hidden main window never leaves for onboarding, and opens the
 *   routes sent to it whatever page it shows;
 * - the start widget and the overlay hand over to other windows instead of
 *   loading their pages; at the start and the end of a call the backend
 *   moves the windows, and every window follows its call in progress;
 * - the widget's project comes from the live list.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const win = vi.hoisted(() => ({
  hide: vi.fn(() => Promise.resolve()),
  label: "main",
}));

const nav = vi.hoisted(() => ({
  pathname: "/",
  push: vi.fn(),
  replace: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  // Rust sends an emitted event to every window, the sender's included.
  emit: (event: string, payload: unknown) => {
    fake.emit(event, payload);
    return Promise.resolve();
  },
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: win.hide,
    label: win.label,
    listen: fake.listen,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: nav.push,
    replace: nav.replace,
  }),
  useSearchParams: () => nav.search,
}));

const { IDLE_SESSION, fakeProject, liveSession } = await import(
  "./helpers/fake-tauri"
);

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const LAPA = "019a0000-0000-7000-8000-000000000002";

const { AppFrame } = await import("@/features/shell/app-frame");
const { HomePage } = await import("@/features/projects/pages/home-page");
const { StartWidgetPage } = await import(
  "@/features/call-widget/pages/start-widget-page"
);
const { OverlayPage } = await import(
  "@/features/call-widget/pages/overlay-page"
);
const { useCallSession } = await import("@/data/call-session");
const { routes } = await import("@/lib/routes");
const { refreshProjects } = await import("@/data/projects");

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function sessionEvents() {
  return [...(fake.handlers.get("call-session-changed") ?? [])];
}

function SessionProbe() {
  const session = useCallSession();
  return <output aria-label="Сессия">{session.status}</output>;
}

beforeEach(async () => {
  win.label = "main";
  nav.search = new URLSearchParams();
  win.hide.mockClear();
  nav.pathname = "/";
  nav.push.mockReset();
  nav.replace.mockReset();
  fake.invoked.length = 0;
  fake.failures.clear();
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(TELEMEDIA, "Телемедиа"),
    fakeProject(LAPA, "Ветклиника Лапа")
  );
  fake.db.settings = { onboardingCompleted: true };
  // The stores outlive a test: read the reset tables.
  await act(() => refreshProjects());
  fake.invoked.length = 0;
  fake.db.calls.length = 0;
  act(() => fake.setSession(IDLE_SESSION));
});

describe("main window", () => {
  it("stays on home before onboarding is done: Rust picks the window", async () => {
    fake.db.settings = { onboardingCompleted: false };
    render(
      <AppFrame>
        <HomePage />
      </AppFrame>
    );

    expect(
      (await screen.findAllByText("Ветклиника Лапа")).length
    ).toBeGreaterThan(0);
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("opens routes sent to it on any page, by its window label", async () => {
    nav.pathname = "/onboarding";
    render(
      <AppFrame>
        <p>Онбординг</p>
      </AppFrame>
    );
    await waitFor(() => expect(fake.handlers.get("navigate")?.size).toBe(1));

    act(() => fake.emit("navigate", { route: routes.newProject() }));

    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith(routes.newProject())
    );
  });

  it("does not listen for routes in a floating window", async () => {
    win.label = "overlay";
    nav.pathname = "/overlay";
    render(
      <AppFrame>
        <p>Оверлей</p>
      </AppFrame>
    );
    await waitFor(() => expect(sessionEvents()).toHaveLength(1));
    expect(fake.handlers.get("navigate")?.size ?? 0).toBe(0);
  });
});

describe("start widget window", () => {
  it("preselects a project of the live list and follows it", async () => {
    win.label = "widget";
    nav.pathname = "/widget";
    render(
      <AppFrame>
        <StartWidgetPage />
      </AppFrame>
    );

    // Not the demo project of the prerender: the first stored one.
    expect(await screen.findByText("Телемедиа")).toBeTruthy();
    expect(screen.queryByText("Звонок без проекта")).toBeNull();

    // The project is deleted in the main window: back to the default.
    act(() => {
      fake.db.projects.shift();
      fake.dataChanged({
        change: "deleted",
        entity: "project",
        id: TELEMEDIA,
        projectId: TELEMEDIA,
      });
    });
    expect(await screen.findByText("Ветклиника Лапа")).toBeTruthy();
    expect(screen.queryByText("Телемедиа")).toBeNull();
  });

  it("leaves the windows to the backend on «Начать»", async () => {
    win.label = "widget";
    nav.pathname = "/widget";
    render(
      <AppFrame>
        <StartWidgetPage />
        <SessionProbe />
      </AppFrame>
    );
    await screen.findByText("Телемедиа");

    fireEvent.click(screen.getByRole("button", { name: "Начать" }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Сессия" }).textContent).toBe(
        "live"
      )
    );
    expect(invokedWith("call_start")).toEqual([
      { input: { participantIds: [], projectId: TELEMEDIA } },
    ]);
    // The backend hides the widget and shows the overlay: no window moves
    // from here, and nothing is sent to the other windows.
    expect(invokedWith("windows_show")).toEqual([]);
    expect(win.hide).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Готовлю бриф" })).toBeNull();
  });

  it("hides the window with the pill's ×", async () => {
    win.label = "widget";
    nav.pathname = "/widget";
    render(
      <AppFrame>
        <StartWidgetPage />
      </AppFrame>
    );
    await screen.findByText("Телемедиа");

    fireEvent.click(screen.getByRole("button", { name: "Не сейчас" }));
    fireEvent.click(screen.getByRole("button", { name: "Скрыть" }));

    await waitFor(() => expect(win.hide).toHaveBeenCalled());
    expect(screen.queryByText("Виджет скрыт до следующего звонка")).toBeNull();
  });
});

describe("overlay window", () => {
  it("follows the backend's call and leaves the summary to it", async () => {
    win.label = "overlay";
    nav.pathname = "/overlay";
    render(
      <AppFrame>
        <OverlayPage />
        <SessionProbe />
      </AppFrame>
    );
    await waitFor(() => expect(sessionEvents()).toHaveLength(1));

    // The widget started a call; the backend tells every window.
    const now = Date.now();
    act(() =>
      fake.setSession(
        liveSession({
          autoEnd: { app: "Zoom", endsAt: now + 600_000, releasedAt: now },
          participants: ["Ольга"],
          projectId: LAPA,
        })
      )
    );
    expect(await screen.findByText("Ветклиника Лапа")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Сессия" }).textContent).toBe(
      "live"
    );

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));

    await waitFor(() =>
      expect(invokedWith("call_finish")).toEqual([{ callId: "fake-call-live" }])
    );
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Сессия" }).textContent).toBe(
        "finishing"
      )
    );
    // The backend hides the overlay and opens the summary in main.
    expect(invokedWith("windows_show")).toEqual([]);
    expect(win.hide).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("opens the call window in the main window", async () => {
    win.label = "overlay";
    nav.pathname = "/overlay";
    render(<OverlayPage />);

    fireEvent.click(
      screen.getAllByRole("link", { name: "Открыть окно звонка" })[0] as Element
    );

    await waitFor(() =>
      expect(invokedWith("windows_show")).toEqual([
        { label: "main", route: routes.call() },
      ])
    );
    expect(win.hide).toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });
});
