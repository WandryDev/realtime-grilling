import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriWindow = vi.hoisted(() => ({
  close: vi.fn(() => Promise.resolve()),
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => tauriWindow,
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

const { OverlayPage } = await import(
  "@/features/call-widget/pages/overlay-page"
);
const { StartWidgetPage } = await import(
  "@/features/call-widget/pages/start-widget-page"
);
const { MainWindow } = await import("@/features/shell/main-window");
const { windowChromeFor } = await import("@/lib/platform");

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/** Pretends to be a Tauri webview on the OS of `userAgent`. */
function inTauri(userAgent: string) {
  vi.stubGlobal("isTauri", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  tauriWindow.close.mockClear();
  tauriWindow.minimize.mockClear();
  tauriWindow.toggleMaximize.mockClear();
});

describe("windowChromeFor", () => {
  it.each([
    [false, MAC_SAFARI, "browser"],
    [false, WINDOWS_EDGE, "browser"],
    [true, MAC_SAFARI, "macos"],
    [true, WINDOWS_EDGE, "windows"],
    [true, LINUX, "native"],
  ] as const)("tauri=%s, %s → %s", (tauri, userAgent, chrome) => {
    expect(windowChromeFor({ tauri, userAgent })).toBe(chrome);
  });
});

describe("window title bar", () => {
  function renderMainWindow() {
    return render(
      <MainWindow>
        <p>Содержимое</p>
      </MainWindow>
    );
  }

  it("draws the macOS traffic lights in the browser", () => {
    const { container } = renderMainWindow();
    const lights = container.querySelector("[data-slot=window-traffic-lights]");
    expect(lights).not.toBeNull();
    expect(lights?.className).not.toContain("*:invisible");
    expect(screen.queryByRole("group", { name: "Управление окном" })).toBe(
      null
    );
  });

  it("leaves room for the native traffic lights in Tauri on macOS", () => {
    inTauri(MAC_SAFARI);
    const { container } = renderMainWindow();
    const lights = container.querySelector("[data-slot=window-traffic-lights]");
    expect(lights?.hasAttribute("data-native-traffic-lights")).toBe(true);
    expect(lights?.className).toContain("*:invisible");
    expect(screen.queryByRole("group", { name: "Управление окном" })).toBe(
      null
    );
  });

  it("wires the Windows buttons to the Tauri window", () => {
    inTauri(WINDOWS_EDGE);
    const { container } = renderMainWindow();
    expect(
      container.querySelector("[data-slot=window-traffic-lights]")
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Свернуть" }));
    fireEvent.click(screen.getByRole("button", { name: "Развернуть" }));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));

    expect(tauriWindow.minimize).toHaveBeenCalledOnce();
    expect(tauriWindow.toggleMaximize).toHaveBeenCalledOnce();
    expect(tauriWindow.close).toHaveBeenCalledOnce();
  });
});

describe("floating windows", () => {
  it.each([
    ["/widget", StartWidgetPage],
    ["/overlay", OverlayPage],
  ])("%s has a floating root", (_route, Page) => {
    const { container } = render(<Page />);
    expect(container.querySelector('[data-window="floating"]')).not.toBeNull();
  });

  it("draws the desktop stand-in only in the browser", () => {
    render(<StartWidgetPage />);
    expect(screen.getByText("zoom.us")).toBeTruthy();
  });

  it("is only the card in Tauri, dragged by the card", () => {
    inTauri(MAC_SAFARI);
    const { container } = render(<StartWidgetPage />);
    const root = container.querySelector('[data-window="floating"]');
    expect(root?.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(screen.queryByText("zoom.us")).toBeNull();
  });
});
