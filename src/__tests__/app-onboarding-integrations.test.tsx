import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIntegrations } from "@/data/integrations";
import { resetOnboarding } from "@/data/onboarding";
import {
  CONNECT_DELAY_MS,
  cancelAllConnects,
} from "@/features/onboarding/integrations/api";
import { normalizeOutlineUrl } from "@/features/onboarding/integrations/outline-url";
import { DonePage } from "@/features/onboarding/integrations/pages/done-page";
import { IntegrationsPage } from "@/features/onboarding/integrations/pages/integrations-page";
import { ServiceConnectPage } from "@/features/onboarding/integrations/pages/service-connect-page";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/onboarding/integrations",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: navigation.push,
    replace: vi.fn(),
  }),
  useSearchParams: () => navigation.params,
}));

const CHECKING_KEY = /Проверяем ключ/u;
const VALID_KEY = "ol_api_x9Pq4Lm2Vb7Nd3Wf8Ht7Xk2";

function hrefOf(name: string) {
  return screen.getByRole("link", { name }).getAttribute("href");
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  navigation.params = new URLSearchParams();
  navigation.push.mockReset();
  cancelAllConnects();
  resetIntegrations();
  resetOnboarding();
});

afterEach(() => {
  cancelAllConnects();
  vi.useRealTimers();
});

describe("IntegrationsPage", () => {
  it("starts with nothing connected and lets the user skip", () => {
    render(<IntegrationsPage />);

    expect(hrefOf("Подключить GitHub")).toBe("/onboarding/integrations/github");
    expect(hrefOf("Подключить Outline")).toBe(
      "/onboarding/integrations/outline"
    );
    expect(hrefOf("Подключить ClickUp")).toBe(
      "/onboarding/integrations/clickup"
    );
    expect(hrefOf("Пропустить")).toBe("/onboarding/done");
    expect(hrefOf("Назад")).toBe("/onboarding/agent");
  });

  it("opens Paper's mixed list with ?demo=partial", () => {
    navigation.params = new URLSearchParams("demo=partial");
    render(<IntegrationsPage />);

    expect(screen.getByText("Подключено")).toBeDefined();
    expect(hrefOf("Исправить Outline")).toBe(
      "/onboarding/integrations/outline"
    );
    expect(hrefOf("ClickUp: ждём браузер")).toBe(
      "/onboarding/integrations/clickup"
    );
    expect(hrefOf("Продолжить")).toBe("/onboarding/done");
  });
});

describe("GitHub step", () => {
  it("waits for Authorize and shows the connection on the list", async () => {
    const { unmount } = render(<ServiceConnectPage service="github" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Открыть github.com/login/device" })
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Ждём подтверждения на github.com"
    );

    await advance(CONNECT_DELAY_MS.github);
    expect(
      screen.getByRole("heading", { level: 1, name: "GitHub подключён" })
    ).toBeDefined();
    expect(hrefOf("Готово")).toBe("/onboarding/integrations");
    unmount();

    render(<IntegrationsPage />);
    expect(
      screen.getByText("dima-kapish, доступ к 12 репозиториям")
    ).toBeDefined();
    expect(
      screen.queryByRole("link", { name: "Подключить GitHub" })
    ).toBeNull();
    expect(hrefOf("Продолжить")).toBe("/onboarding/done");
  });

  it("gets a new code after it expired", () => {
    navigation.params = new URLSearchParams("demo=expired");
    render(<ServiceConnectPage service="github" />);

    expect(screen.getByText("Код истёк")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Получить новый код" }));

    expect(screen.queryByText("Код истёк")).toBeNull();
    expect(screen.queryByText("WDJB-MJHT")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Открыть github.com/login/device" })
    ).toBeDefined();
  });

  it("returns to the summary when opened from it", () => {
    navigation.params = new URLSearchParams("from=done");
    render(<ServiceConnectPage service="github" />);

    expect(hrefOf("Назад")).toBe("/onboarding/done");
  });
});

describe("Outline step", () => {
  function submit() {
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
  }

  function typeKey(value: string) {
    fireEvent.change(screen.getByLabelText("API-ключ"), {
      target: { value },
    });
  }

  it("asks for the key before checking it", () => {
    render(<ServiceConnectPage service="outline" />);

    submit();
    expect(screen.getByRole("alert").textContent).toContain(
      "Вставьте API-ключ"
    );
    expect(screen.getByLabelText("API-ключ").getAttribute("aria-invalid")).toBe(
      "true"
    );
  });

  it("rejects a wrong key, then connects with the right one", async () => {
    render(<ServiceConnectPage service="outline" />);

    typeKey("ol_api_short");
    submit();
    expect(
      screen
        .getByRole("button", { name: CHECKING_KEY })
        .getAttribute("aria-busy")
    ).toBe("true");

    await advance(CONNECT_DELAY_MS.outline);
    expect(screen.getByRole("alert").textContent).toContain("Ключ не подошёл");

    typeKey(VALID_KEY);
    expect(screen.queryByRole("alert")).toBeNull();
    submit();
    await advance(CONNECT_DELAY_MS.outline);

    expect(
      screen.getByRole("heading", { level: 1, name: "Outline подключён" })
    ).toBeDefined();
    expect(hrefOf("Готово")).toBe("/onboarding/integrations");
  });

  it("trims the address and reports one that doesn't answer", async () => {
    render(<ServiceConnectPage service="outline" />);

    fireEvent.change(screen.getByLabelText("Адрес Outline"), {
      target: { value: "intranet/doc/brief-123" },
    });
    typeKey(VALID_KEY);
    submit();

    expect(screen.getByLabelText("Адрес Outline")).toHaveProperty(
      "value",
      "https://intranet"
    );
    await advance(CONNECT_DELAY_MS.outline);
    expect(screen.getByRole("alert").textContent).toContain("не отвечает");
  });

  it("normalizes pasted addresses to the root", () => {
    expect(normalizeOutlineUrl("docs.pixel.agency/")).toBe(
      "https://docs.pixel.agency"
    );
    expect(
      normalizeOutlineUrl("https://docs.pixel.agency/doc/brief-abc?x=1")
    ).toBe("https://docs.pixel.agency");
    expect(normalizeOutlineUrl("  ")).toBeNull();
  });
});

describe("ClickUp step", () => {
  it("can cancel the browser sign-in and connect on the second try", async () => {
    render(<ServiceConnectPage service="clickup" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Продолжить в браузере" })
    );
    expect(screen.getByText("Ждём ответа от ClickUp")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(
      screen.getByRole("button", { name: "Продолжить в браузере" })
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Продолжить в браузере" })
    );
    await advance(CONNECT_DELAY_MS.clickup);
    expect(
      screen.getByRole("heading", { level: 1, name: "ClickUp подключён" })
    ).toBeDefined();
  });

  it("retries after an error forced with ?demo=error", () => {
    navigation.params = new URLSearchParams("demo=error");
    render(<ServiceConnectPage service="clickup" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "ClickUp не подключился" })
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Попробовать снова" }));
    expect(screen.getByText("Ждём ответа от ClickUp")).toBeDefined();
  });
});

describe("DonePage", () => {
  it("offers the skipped services and finishes the setup", () => {
    render(<DonePage />);

    expect(hrefOf("Подключить GitHub")).toBe(
      "/onboarding/integrations/github?from=done"
    );
    expect(hrefOf("Назад")).toBe("/onboarding/integrations");

    fireEvent.click(
      screen.getByRole("button", { name: "Добавить первый проект" })
    );
    expect(window.localStorage.getItem("grill.onboarding-done")).toBe("1");
    expect(navigation.push).toHaveBeenCalledWith("/project/new");
  });
});
