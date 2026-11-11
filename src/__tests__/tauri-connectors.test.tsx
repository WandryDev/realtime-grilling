import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Connectors in the app (connectors-outline tasks 4.1 and 4.2), over the
 * fake IPC (./helpers/fake-tauri.ts): the integrations store reads
 * `connectors_list` and follows `DataChanged` of `connections` from every
 * window; Settings → Интеграции and the onboarding Outline step connect,
 * refuse at the right field and disconnect through the commands; GitHub
 * and ClickUp are «скоро».
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: fake.listen }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/integrations",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: nav.push,
    replace: vi.fn(),
  }),
  useSearchParams: () => nav.search,
}));

const { connectedOutline, fakeConnector, fakeProject, FAKE_OUTLINE_ACCOUNT } =
  await import("./helpers/fake-tauri");
const {
  connectWithKey,
  disconnectIntegration,
  refreshIntegrations,
  useIntegrations,
} = await import("@/data/integrations");
const { refreshConnectorSelections } = await import(
  "@/data/connector-selections"
);
const { refreshProjects } = await import("@/data/projects");
const { SettingsPage } = await import(
  "@/features/settings/pages/settings-page"
);
const { IntegrationsPage } = await import(
  "@/features/onboarding/integrations/pages/integrations-page"
);
const { ServiceConnectPage } = await import(
  "@/features/onboarding/integrations/pages/service-connect-page"
);

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const GOOD_KEY = "ol_api_x9Pq4Lm2Vb7Nd3Wf8Ht7Xk2";
const HOUR_MS = 3_600_000;
const AGENT_PATH = /Grill сам загружает документы/u;
const MASKED_KEY = /^ol_api_•+7Xk2$/u;
const NOT_UPDATED = /Не удалось обновить/u;
const TOUCHES_TELEMEDIA = /Это коснётся проекта «Телемедиа»/u;

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function setOutline(view: ReturnType<typeof connectedOutline>) {
  fake.db.connections = [
    view,
    fakeConnector("github"),
    fakeConnector("clickup"),
  ];
}

/** The stores outlive a test: read the reset tables. */
async function reload() {
  await act(async () => {
    await refreshProjects();
    await refreshIntegrations();
    await refreshConnectorSelections();
  });
}

function IntegrationsProbe() {
  const integrations = useIntegrations();
  const { outline } = integrations;
  return (
    <p data-testid="outline">
      {outline.status}
      {outline.team ? `: ${outline.team}` : ""}
      {integrations.github.available === false ? ", github скоро" : ""}
    </p>
  );
}

function outlineRow() {
  return screen.getByRole("article", { name: "Outline" });
}

beforeEach(async () => {
  nav.push.mockReset();
  nav.search = new URLSearchParams();
  fake.answers.clear();
  fake.failures.clear();
  fake.db.projects.splice(0, fake.db.projects.length, {
    ...fakeProject(TELEMEDIA, "Телемедиа"),
  });
  fake.db.selections = [];
  setOutline(fakeConnector("outline"));
  await reload();
  fake.invoked.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Connectors service and the integrations store (4.1)", () => {
  it("connects Outline with the key and shows the team", async () => {
    render(<IntegrationsProbe />);
    expect((await screen.findByTestId("outline")).textContent).toBe(
      "disconnected, github скоро"
    );

    let result: Awaited<ReturnType<typeof connectWithKey>> | undefined;
    await act(async () => {
      result = await connectWithKey(
        "outline",
        "https://docs.pixel.agency",
        GOOD_KEY
      );
    });

    expect(result?.ok).toBe(true);
    expect(invokedWith("connector_connect_api_key")).toEqual([
      { host: "https://docs.pixel.agency", key: GOOD_KEY, kind: "outline" },
    ]);
    expect(screen.getByTestId("outline").textContent).toBe(
      "connected: Pixel Agency, github скоро"
    );
  });

  it("returns a refusal with its field and changes nothing", async () => {
    render(<IntegrationsProbe />);
    await screen.findByText("disconnected, github скоро");

    let result: Awaited<ReturnType<typeof connectWithKey>> | undefined;
    await act(async () => {
      result = await connectWithKey(
        "outline",
        "https://docs.pixel.agency",
        "bad-key"
      );
    });

    expect(result).toEqual({
      field: "key",
      message: "Ключ не подошёл",
      ok: false,
    });
    expect(screen.getByTestId("outline").textContent).toBe(
      "disconnected, github скоро"
    );
  });

  it("disconnects through the command", async () => {
    setOutline(connectedOutline());
    await reload();
    render(<IntegrationsProbe />);
    await screen.findByText("connected: Pixel Agency, github скоро");

    await act(async () => {
      await disconnectIntegration("outline");
    });

    expect(invokedWith("connector_disconnect")).toEqual([{ kind: "outline" }]);
    expect(screen.getByTestId("outline").textContent).toBe(
      "disconnected, github скоро"
    );
  });

  it("follows a connect made in another window", async () => {
    render(<IntegrationsProbe />);
    await screen.findByText("disconnected, github скоро");

    act(() => {
      setOutline(connectedOutline());
      fake.dataChanged({
        change: "updated",
        entity: "connections",
        id: "outline",
        projectId: null,
      });
    });

    expect(
      await screen.findByText("connected: Pixel Agency, github скоро")
    ).toBeTruthy();
  });
});

describe("Settings → Интеграции in the app (4.2)", () => {
  it("offers to connect Outline; GitHub and ClickUp are «скоро»", async () => {
    render(<SettingsPage section="integrations" />);

    expect(
      await within(outlineRow()).findByRole("button", { name: "Подключить" })
    ).toBeTruthy();
    for (const name of ["GitHub", "ClickUp"]) {
      const row = screen.getByRole("article", { name });
      expect(within(row).getByText("скоро")).toBeTruthy();
      expect(within(row).queryByRole("button")).toBeNull();
    }
    expect(screen.getByText("0 из 1 работают")).toBeTruthy();
    // How the data reaches the agent, no MCP.
    expect(screen.getByText(AGENT_PATH).textContent).not.toContain("MCP");
  });

  it("connects from the dialog, the error at the field it belongs to", async () => {
    render(<SettingsPage section="integrations" />);
    fireEvent.click(
      await within(outlineRow()).findByRole("button", { name: "Подключить" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Подключить Outline",
    });
    fireEvent.change(within(dialog).getByLabelText("Адрес Outline"), {
      target: { value: "nowhere.example" },
    });
    fireEvent.change(within(dialog).getByLabelText("API-ключ"), {
      target: { value: GOOD_KEY },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));

    const hostError = await within(dialog).findByText(
      "Не удалось подключиться к Outline"
    );
    expect(hostError).toBeTruthy();
    // The key stays, masked.
    const key = within(dialog).getByLabelText("API-ключ") as HTMLInputElement;
    expect(key.value).toMatch(MASKED_KEY);

    fireEvent.change(within(dialog).getByLabelText("Адрес Outline"), {
      target: { value: "docs.pixel.agency/doc/brief-AbC123" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));

    // The dialog closes: the row is reachable again.
    await waitFor(() => {
      expect(
        within(outlineRow()).getByText(
          "Команда Pixel Agency, только чтение документов"
        )
      ).toBeTruthy();
    });
    expect(invokedWith("connector_connect_api_key").at(-1)).toEqual({
      host: "https://docs.pixel.agency",
      key: GOOD_KEY,
      kind: "outline",
    });
  });

  it("asks for a new key when the old one was revoked («Ключ отозвали»)", async () => {
    setOutline(connectedOutline(Date.now() - HOUR_MS * 2));
    fake.db.connections[0] = {
      ...fake.db.connections[0],
      error: "Ключ больше не подходит",
      errorKind: "unauthorized",
      status: "error",
    } as (typeof fake.db.connections)[0];
    await reload();
    render(<SettingsPage section="integrations" />);

    expect(
      await within(outlineRow()).findByText(
        "Ключ больше не подходит: истёк или был отозван"
      )
    ).toBeTruthy();
    fireEvent.click(
      within(outlineRow()).getByRole("button", { name: "Обновить ключ" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Новый ключ Outline",
    });
    expect(
      (within(dialog).getByLabelText("Адрес Outline") as HTMLInputElement).value
    ).toBe(FAKE_OUTLINE_ACCOUNT.host);
    fireEvent.change(within(dialog).getByLabelText("API-ключ"), {
      target: { value: GOOD_KEY },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));

    await waitFor(() => {
      expect(within(outlineRow()).getByText("Подключено")).toBeTruthy();
    });
  });

  it("keeps a connection the service did not answer, with «Повторить»", async () => {
    setOutline({
      ...connectedOutline(Date.now() - HOUR_MS * 3),
      errorKind: "unreachable",
    });
    await reload();
    render(<SettingsPage section="integrations" />);

    expect(await within(outlineRow()).findByText(NOT_UPDATED)).toBeTruthy();
    expect(within(outlineRow()).getByText("Подключено")).toBeTruthy();
    fireEvent.click(
      within(outlineRow()).getByRole("button", { name: "Повторить" })
    );
    await waitFor(() => {
      expect(invokedWith("connector_browse")).toEqual([
        { kind: "outline", parent: null },
      ]);
    });
  });

  it("names the projects a disconnect touches and keeps their sources", async () => {
    setOutline(connectedOutline());
    fake.db.selections = [
      {
        connected: true,
        items: [
          {
            externalId: "col-telemedia",
            itemKind: "container",
            otherAccount: false,
            status: "ok",
            title: "Телемедиа",
            url: null,
          },
        ],
        kind: "outline",
        projectId: TELEMEDIA,
        sync: null,
        syncing: false,
      },
    ];
    await reload();
    render(<SettingsPage section="integrations" />);

    fireEvent.click(
      await within(outlineRow()).findByRole("button", { name: "Отключить" })
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Отключить Outline?",
    });
    expect(within(dialog).getByText(TOUCHES_TELEMEDIA)).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Документы Outline останутся в проектах с последним текстом"
      )
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отключить" }));

    expect(
      await within(outlineRow()).findByRole("button", { name: "Подключить" })
    ).toBeTruthy();
    expect(invokedWith("connector_disconnect")).toEqual([{ kind: "outline" }]);
  });
});

describe("Onboarding integrations in the app (4.2)", () => {
  it("skips the step without connecting («Пропустить интеграции»)", async () => {
    render(<IntegrationsPage />);

    const skip = await screen.findByRole("link", { name: "Пропустить" });
    expect(skip.getAttribute("href")).toBe("/onboarding/done");
    expect(
      screen.getByRole("link", { name: "Подключить Outline" })
    ).toBeTruthy();
    // GitHub and ClickUp can't be connected yet.
    expect(screen.getAllByText("скоро")).toHaveLength(2);
    expect(
      screen.queryByRole("link", { name: "Подключить GitHub" })
    ).toBeNull();
    expect(invokedWith("connector_connect_api_key")).toEqual([]);
    expect(invokedWith("connector_disconnect")).toEqual([]);
  });

  it("refuses a key at its field and keeps the focus there", async () => {
    render(<ServiceConnectPage service="outline" />);
    fireEvent.change(await screen.findByLabelText("API-ключ"), {
      target: { value: "bad-key-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Ключ не подошёл"
    );
    expect(document.activeElement).toBe(screen.getByLabelText("API-ключ"));
  });

  it("connects in onboarding, then Settings shows the same team", async () => {
    const onboarding = render(<ServiceConnectPage service="outline" />);
    fireEvent.change(await screen.findByLabelText("Адрес Outline"), {
      target: { value: "wandry.getoutline.com/doc/telemedia-brief-AbC123" },
    });
    fireEvent.change(screen.getByLabelText("API-ключ"), {
      target: { value: GOOD_KEY },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Outline подключён",
      })
    ).toBeTruthy();
    expect(screen.getByText("Pixel Agency")).toBeTruthy();
    expect(invokedWith("connector_connect_api_key")).toEqual([
      {
        host: "https://wandry.getoutline.com",
        key: GOOD_KEY,
        kind: "outline",
      },
    ]);
    onboarding.unmount();

    render(<SettingsPage section="integrations" />);
    expect(
      await within(outlineRow()).findByText(
        "Команда Pixel Agency, только чтение документов"
      )
    ).toBeTruthy();
    expect(
      within(outlineRow()).getByText("wandry.getoutline.com")
    ).toBeTruthy();
  });
});
