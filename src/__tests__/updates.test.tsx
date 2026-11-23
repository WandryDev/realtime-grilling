import { Toaster } from "@grill/ui/toast";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneralSettings } from "@/features/settings/screens/general-settings";
import { mockUpdates } from "@/features/updates/backend";
import { UpdateToast } from "@/features/updates/update-toast";

const ASYNC_TIMEOUT = { timeout: 4000 };
const RESTART = { name: "Перезапустить" };
const CHECK = { name: "Проверить обновления" };

afterEach(() => {
  mockUpdates.reset();
});

describe("Settings → Общие, «Обновления»", () => {
  it("shows the version and checks on request", async () => {
    const user = userEvent.setup();
    const check = vi.fn();
    render(
      <GeneralSettings
        onCheckUpdates={check}
        updates={{
          current: "0.3.0",
          state: { checkedAt: 0, status: "upToDate" },
        }}
      />
    );

    expect(screen.getByText("Grill 0.3.0")).toBeTruthy();
    expect(screen.getByText("Установлена последняя версия")).toBeTruthy();
    await user.click(screen.getByRole("button", CHECK));
    expect(check).toHaveBeenCalledOnce();
  });

  it("offers the restart once an update is downloaded", () => {
    render(
      <GeneralSettings
        updates={{
          current: "0.3.0",
          state: { notes: null, status: "ready", version: "0.4.0" },
        }}
      />
    );

    expect(
      screen.getByText(
        "Версия 0.4.0 скачана. Перезапустите Grill, чтобы установить её"
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", RESTART)).toBeTruthy();
    expect(screen.queryByRole("button", CHECK)).toBeNull();
  });

  it("can't check while a download runs", () => {
    render(
      <GeneralSettings
        updates={{
          current: "0.3.0",
          state: { percent: 42, status: "downloading", version: "0.4.0" },
        }}
      />
    );

    expect(screen.getByText("Скачиваем версию 0.4.0: 42%")).toBeTruthy();
    expect(
      screen.getByRole("button", CHECK).hasAttribute("data-disabled")
    ).toBe(true);
  });

  it("has nothing to do in a debug build", () => {
    render(
      <GeneralSettings
        updates={{ current: "0.3.0", state: { status: "disabled" } }}
      />
    );

    expect(
      screen.getByText("Сборка для разработки не обновляется")
    ).toBeTruthy();
    expect(screen.queryByRole("button", CHECK)).toBeNull();
  });
});

describe("UpdateToast", () => {
  it("says once that a downloaded version is ready", async () => {
    render(
      <Toaster>
        <UpdateToast />
      </Toaster>
    );
    expect(screen.queryByText("Готова версия 0.4.0")).toBeNull();

    const ready = {
      current: "0.3.0",
      state: { notes: null, status: "ready", version: "0.4.0" },
    } as const;
    act(() => mockUpdates.set(ready));
    await waitFor(
      () => expect(screen.getByText("Готова версия 0.4.0")).toBeTruthy(),
      ASYNC_TIMEOUT
    );
    act(() => mockUpdates.set({ ...ready }));
    expect(screen.getAllByText("Готова версия 0.4.0")).toHaveLength(1);
    expect(screen.getByRole("button", RESTART)).toBeTruthy();
  });
});
