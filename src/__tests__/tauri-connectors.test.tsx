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
 * Connectors in the app (connectors-outline tasks 4.1 and 4.2,
 * connectors-clickup tasks 3.1 and 3.2), over the fake IPC
 * (./helpers/fake-tauri.ts): the integrations store reads
 * `connectors_list` and follows `DataChanged` of `connections` from every
 * window; Settings → Интеграции and the onboarding Outline and ClickUp
 * steps connect, refuse at the right field, pick a ClickUp workspace and
 * disconnect through the commands; GitHub is «скоро».
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

const {
  connectedClickUp,
  connectedOutline,
  fakeConnector,
  fakeProject,
  FAKE_OUTLINE_ACCOUNT,
} = await import("./helpers/fake-tauri");
const {
  connectWithKey,
  disconnectIntegration,
  getIntegrations,
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
const TOKEN = "pk_4815162_Q7Z2LM8NX4WD9KTR3HB6YC1P";
const TOKEN_REFUSED = /Токен не подошёл/u;
const PIXEL = { id: "9001", name: "Pixel Agency" };
const PERSONAL = { id: "9002", name: "Личное" };
const USER_LINE = /Токен Дима/u;

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function setOutline(
  view: ReturnType<typeof connectedOutline>,
  clickup = fakeConnector("clickup")
) {
  fake.db.connections = [view, fakeConnector("github"), clickup];
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

function ClickUpProbe() {
  const { clickup } = useIntegrations();
  return (
    <p data-testid="clickup">
      {clickup.status}
      {clickup.team ? `: ${clickup.team}` : ""}
      {clickup.user ? `, ${clickup.user}` : ""}
    </p>
  );
}

function outlineRow() {
  return screen.getByRole("article", { name: "Outline" });
}

function clickupRow() {
  return screen.getByRole("article", { name: "ClickUp" });
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
  fake.clickup.workspaces = [PIXEL];
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
      {
        host: "https://docs.pixel.agency",
        key: GOOD_KEY,
        kind: "outline",
        workspace: null,
      },
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
  it("offers to connect Outline and ClickUp; GitHub is «скоро» («Настройки без подключений»)", async () => {
    render(<SettingsPage section="integrations" />);

    expect(
      await within(outlineRow()).findByRole("button", { name: "Подключить" })
    ).toBeTruthy();
    expect(
      within(clickupRow()).getByRole("button", { name: "Подключить" })
    ).toBeTruthy();
    const github = screen.getByRole("article", { name: "GitHub" });
    expect(within(github).getByText("скоро")).toBeTruthy();
    expect(within(github).queryByRole("button")).toBeNull();
    expect(screen.getByText("0 из 2 работают")).toBeTruthy();
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
      workspace: null,
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

  it("says Keychain refused without breaking the connection", async () => {
    setOutline({
      ...connectedOutline(Date.now() - HOUR_MS),
      error: "Нет доступа к Keychain: связка ключей заблокирована",
      errorKind: "other",
    });
    await reload();
    render(<SettingsPage section="integrations" />);

    expect(
      await within(outlineRow()).findByText(
        "Не удалось обновить: Нет доступа к Keychain: связка ключей заблокирована"
      )
    ).toBeTruthy();
    expect(within(outlineRow()).getByText("Подключено")).toBeTruthy();
    expect(
      within(outlineRow()).queryByRole("button", { name: "Обновить ключ" })
    ).toBeNull();
  });

  it("shows a key without access as «Нет доступа» with «Обновить ключ»", async () => {
    setOutline({
      ...connectedOutline(Date.now() - HOUR_MS),
      error: "Нет доступа к Outline",
      errorKind: "forbidden",
      status: "error",
    });
    await reload();
    render(<SettingsPage section="integrations" />);

    expect(
      await within(outlineRow()).findByText(
        "Нет доступа: у ключа не хватает прав"
      )
    ).toBeTruthy();
    expect(
      within(outlineRow()).getByRole("button", { name: "Обновить ключ" })
    ).toBeTruthy();
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
    expect(
      screen.getByRole("link", { name: "Подключить ClickUp" })
    ).toBeTruthy();
    // GitHub can't be connected yet.
    expect(screen.getAllByText("скоро")).toHaveLength(1);
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
        workspace: null,
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

describe("ClickUp: the service and the store (connectors-clickup 3.1)", () => {
  it("connects with a token that opens one workspace", async () => {
    render(<ClickUpProbe />);
    await screen.findByText("disconnected");

    let result: Awaited<ReturnType<typeof connectWithKey>> | undefined;
    await act(async () => {
      result = await connectWithKey("clickup", "", TOKEN);
    });

    expect(result?.ok).toBe(true);
    expect(invokedWith("connector_connect_api_key")).toEqual([
      { host: "", key: TOKEN, kind: "clickup", workspace: null },
    ]);
    expect(screen.getByTestId("clickup").textContent).toBe(
      "connected: Pixel Agency, Дима"
    );
  });

  it("asks for a workspace when the token opens two, then connects the picked one", async () => {
    fake.clickup.workspaces = [PIXEL, PERSONAL];
    render(<ClickUpProbe />);
    await screen.findByText("disconnected");

    let result: Awaited<ReturnType<typeof connectWithKey>> | undefined;
    await act(async () => {
      result = await connectWithKey("clickup", "", TOKEN);
    });
    expect(result).toEqual({
      field: "workspace",
      ok: false,
      workspaces: [PIXEL, PERSONAL],
    });
    // Nothing saved before the pick.
    expect(screen.getByTestId("clickup").textContent).toBe("disconnected");

    await act(async () => {
      result = await connectWithKey("clickup", "", TOKEN, PERSONAL.id);
    });
    expect(result?.ok).toBe(true);
    expect(invokedWith("connector_connect_api_key").at(-1)).toEqual({
      host: "",
      key: TOKEN,
      kind: "clickup",
      workspace: PERSONAL.id,
    });
    expect(screen.getByTestId("clickup").textContent).toBe(
      "connected: Личное, Дима"
    );
  });

  it("returns a refusal at the key field and changes nothing", async () => {
    render(<ClickUpProbe />);
    await screen.findByText("disconnected");

    let result: Awaited<ReturnType<typeof connectWithKey>> | undefined;
    await act(async () => {
      result = await connectWithKey("clickup", "", "bad-token");
    });

    expect(result).toEqual({
      field: "key",
      message: "Токен не подошёл",
      ok: false,
    });
    expect(screen.getByTestId("clickup").textContent).toBe("disconnected");
  });
});

describe("ClickUp in Settings and onboarding (connectors-clickup 3.2)", () => {
  async function openClickUpDialog() {
    render(<SettingsPage section="integrations" />);
    fireEvent.click(
      await within(clickupRow()).findByRole("button", { name: "Подключить" })
    );
    return screen.findByRole("dialog", { name: "Подключить ClickUp" });
  }

  it("refuses a token at its field and keeps the focus there («Неверный токен»)", async () => {
    const dialog = await openClickUpDialog();
    expect(
      within(dialog)
        .getByRole("link", { name: "Открыть страницу токена" })
        .getAttribute("href")
    ).toBe("https://app.clickup.com/settings/apps");
    fireEvent.change(within(dialog).getByLabelText("Токен ClickUp"), {
      target: { value: "bad-token-123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));

    expect(await within(dialog).findByText(TOKEN_REFUSED)).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText("Токен ClickUp")
    );
    expect(
      fake.db.connections.find((view) => view.kind === "clickup")?.status
    ).toBe("disconnected");
  });

  it("picks one of several workspaces before connecting («Несколько пространств»)", async () => {
    fake.clickup.workspaces = [PIXEL, PERSONAL];
    const dialog = await openClickUpDialog();
    fireEvent.change(within(dialog).getByLabelText("Токен ClickUp"), {
      target: { value: TOKEN },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));

    const group = await within(dialog).findByRole("radiogroup");
    // Not connected until a workspace is picked.
    expect(
      within(dialog)
        .getByRole("button", { name: "Подключить" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(fake.db.connections.find((v) => v.kind === "clickup")?.status).toBe(
      "disconnected"
    );
    fireEvent.click(within(group).getByText("Pixel Agency"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));

    await waitFor(() => {
      expect(
        within(clickupRow()).getByText(
          "Пространство Pixel Agency, только чтение задач и комментариев"
        )
      ).toBeTruthy();
    });
    expect(within(clickupRow()).getByText(USER_LINE)).toBeTruthy();
    expect(invokedWith("connector_connect_api_key").at(-1)).toEqual({
      host: "",
      key: TOKEN,
      kind: "clickup",
      workspace: PIXEL.id,
    });
  });

  it("asks for a new token when it was revoked", async () => {
    setOutline(fakeConnector("outline"), {
      ...connectedClickUp(Date.now() - HOUR_MS),
      error: "Токен больше не подходит",
      errorKind: "unauthorized",
      status: "error",
    });
    await reload();
    render(<SettingsPage section="integrations" />);

    expect(
      await within(clickupRow()).findByText(
        "Токен больше не подходит: истёк или был отозван"
      )
    ).toBeTruthy();
    fireEvent.click(
      within(clickupRow()).getByRole("button", { name: "Обновить токен" })
    );
    expect(
      await screen.findByRole("dialog", { name: "Новый токен ClickUp" })
    ).toBeTruthy();
  });

  it("keeps ClickUp's reason on the onboarding list, not «Токен не подошёл», when ClickUp did not answer", async () => {
    fake.answers.set("connector_connect_api_key", () => ({
      rejected: { field: "key", reason: "ClickUp не ответил за 15 секунд" },
    }));
    render(<ServiceConnectPage service="clickup" />);
    fireEvent.change(await screen.findByLabelText("Токен ClickUp"), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));

    expect(
      await screen.findByText("ClickUp не ответил за 15 секунд")
    ).toBeTruthy();
    expect(getIntegrations().clickup).toEqual(
      expect.objectContaining({
        error: "ClickUp не ответил за 15 секунд",
        status: "error",
      })
    );
  });

  it("keeps «Токен не подошёл» on the onboarding list for a refused token", async () => {
    render(<ServiceConnectPage service="clickup" />);
    fireEvent.change(await screen.findByLabelText("Токен ClickUp"), {
      target: { value: "bad-token-123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));

    expect(await screen.findByText(TOKEN_REFUSED)).toBeTruthy();
    expect(getIntegrations().clickup.error).toBe(
      "Токен не подошёл, проверьте его"
    );
  });

  it("connects ClickUp in onboarding, then Settings shows the same workspace («Подключить ClickUp в онбординге»)", async () => {
    fake.clickup.workspaces = [PIXEL, PERSONAL];
    const onboarding = render(<ServiceConnectPage service="clickup" />);
    fireEvent.change(await screen.findByLabelText("Токен ClickUp"), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
    fireEvent.click(
      within(await screen.findByRole("radiogroup")).getByText("Pixel Agency")
    );
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "ClickUp подключён",
      })
    ).toBeTruthy();
    expect(screen.getByText("Pixel Agency")).toBeTruthy();
    expect(screen.getByText("Дима")).toBeTruthy();
    onboarding.unmount();

    render(<SettingsPage section="integrations" />);
    expect(
      await within(clickupRow()).findByText(
        "Пространство Pixel Agency, только чтение задач и комментариев"
      )
    ).toBeTruthy();
  });
});
