import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/*
 * The main window when the local database can't be read (newer than the
 * app, failed migration): a full-window error instead of empty lists, and
 * "Повторить" once the storage answers again. Tauri mode over the fake
 * IPC (./helpers/fake-tauri.ts).
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
vi.mock("@tauri-apps/api/event", () => ({ listen: fake.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: fake.listen }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const NEWER_DATABASE =
  "База данных создана более новой версией Grill (схема 3, приложение знает 1)";

const { fakeProject } = await import("./helpers/fake-tauri");
const { AppFrame } = await import("@/features/shell/app-frame");

describe("main window over a broken storage", () => {
  it("shows the storage error instead of the page, then retries", async () => {
    fake.failures.set("projects_list", {
      kind: "Storage",
      message: NEWER_DATABASE,
    });
    render(
      <AppFrame>
        <p>Страница</p>
      </AppFrame>
    );

    expect(
      await screen.findByRole("heading", { name: "Не удалось открыть данные" })
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(NEWER_DATABASE);
    // The copies Rust keeps are grill.db.bak-v<N>.
    expect(screen.getByRole("alert").textContent).toContain("grill.db.bak-vN");
    expect(screen.queryByText("Страница")).toBeNull();

    fake.failures.clear();
    fake.db.projects.push(
      fakeProject("019a0000-0000-7000-8000-000000000001", "Телемедиа")
    );
    fake.invoked.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("Страница")).toBeTruthy();
    // Rust opens the database again before the stores re-read.
    const commands = fake.invoked.map((call) => call.command);
    expect(commands[0]).toBe("storage_reopen");
    expect(commands).toContain("projects_list");
  });
});
