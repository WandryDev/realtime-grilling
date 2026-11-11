import { Clock, Context, Effect, Layer } from "effect";

import {
  type BrowseNode,
  type ConnectOutcome,
  type ConnectorKind,
  type ConnectorView,
  commands,
  type ExternalRef,
  type ProjectConnectorView,
  type ProjectSource,
  type SelectionItem,
  type SelectionItemView,
  type SyncState,
} from "@/bindings";
import { BackendError, call } from "@/effect/tauri";

import {
  invalid,
  MockDatabase,
  type MockSelection,
  type MockTables,
  notFound,
} from "./mock-database";
import {
  flattenDocuments,
  MOCK_OUTLINE_ACCOUNT,
  type MockOutlineDocument,
  mockOutlineBrowse,
  mockOutlineUrl,
} from "./mock-outline";

/*
 * Connectors (connectors-outline design.md, decisions 6 and 7): the
 * catalog with each service's connection, connecting by an API key,
 * disconnecting, the picker's tree and a project's selection with its
 * sync. Rust calls the services and keeps the keys in Keychain; nothing
 * here ever sees a key after it is sent.
 *
 * `layerMock` plays it in memory over the demo Outline
 * (`./mock-outline.ts`): the key check takes `MOCK_CONNECT_DELAY_MS`, a
 * host without a dot doesn't answer, a key that isn't `ol_api_` and 20
 * characters is refused. Everything else answers at once, so the stores
 * apply a mock write before the action returns. A selection syncs as
 * soon as it is saved, like the background sync of Rust.
 */
export class Connectors extends Context.Service<
  Connectors,
  {
    /** The catalog with each connector's connection. */
    readonly list: Effect.Effect<ConnectorView[], BackendError>;
    /** Checks the address and the key, then saves them. */
    readonly connectApiKey: (
      kind: ConnectorKind,
      host: string,
      key: string
    ) => Effect.Effect<ConnectOutcome, BackendError>;
    readonly disconnect: (
      kind: ConnectorKind
    ) => Effect.Effect<void, BackendError>;
    /** The containers without `parent`, else what is inside it. */
    readonly browse: (
      kind: ConnectorKind,
      parent: ExternalRef | null
    ) => Effect.Effect<BrowseNode[], BackendError>;
    readonly selectionGet: (
      projectId: string
    ) => Effect.Effect<ProjectConnectorView[], BackendError>;
    /** Replaces the selection (empty removes it) and starts its sync. */
    readonly selectionSet: (
      projectId: string,
      kind: ConnectorKind,
      items: SelectionItem[]
    ) => Effect.Effect<ProjectConnectorView, BackendError>;
    /** «Обновить»: resolves when the sync is done. */
    readonly sync: (
      projectId: string,
      kind: ConnectorKind | null
    ) => Effect.Effect<void, BackendError>;
  }
>()("grill/data/services/Connectors") {
  static readonly layerTauri = Layer.succeed(Connectors, {
    browse: (kind, parent) =>
      call(() => commands.connectorBrowse(kind, parent)),
    connectApiKey: (kind, host, key) =>
      call(() => commands.connectorConnectApiKey(kind, host, key)),
    disconnect: (kind) =>
      Effect.asVoid(call(() => commands.connectorDisconnect(kind))),
    list: call(() => commands.connectorsList()),
    selectionGet: (projectId) =>
      call(() => commands.connectorSelectionGet(projectId)),
    selectionSet: (projectId, kind, items) =>
      call(() => commands.connectorSelectionSet(projectId, kind, items)),
    sync: (projectId, kind) =>
      Effect.asVoid(call(() => commands.connectorSync(projectId, kind))),
  });

  static readonly layerMock = Layer.effect(
    Connectors,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const outlineOnly = Effect.fnUntraced(function* (kind: ConnectorKind) {
        if (kind !== "outline") {
          return yield* invalid(`${KIND_LABEL[kind]} пока нельзя подключить`);
        }
      });

      const projectExists = Effect.fnUntraced(function* (projectId: string) {
        if (!tables.projects.has(projectId)) {
          return yield* notFound(`Проект ${projectId} не найден`);
        }
      });

      const connectApiKey = Effect.fnUntraced(function* (
        kind: ConnectorKind,
        host: string,
        key: string
      ): Effect.fn.Return<ConnectOutcome, BackendError> {
        yield* outlineOnly(kind);
        yield* Effect.sleep(MOCK_CONNECT_DELAY_MS);
        const origin = mockNormalizeHost(host);
        if (typeof origin !== "string") {
          return { rejected: { field: "host", reason: origin.reason } };
        }
        if (!key.trim()) {
          return { rejected: { field: "key", reason: "Введите ключ" } };
        }
        if (!new URL(origin).hostname.includes(".")) {
          return {
            rejected: {
              field: "host",
              reason: "Не удалось подключиться к Outline",
            },
          };
        }
        if (!MOCK_OUTLINE_KEY.test(key.trim())) {
          return { rejected: { field: "key", reason: "Ключ не подошёл" } };
        }
        const now = yield* Clock.currentTimeMillis;
        const current = tables.connections.get(kind);
        if (!current) {
          return yield* invalid(`${KIND_LABEL[kind]} пока нельзя подключить`);
        }
        const connected: ConnectorView = {
          ...current,
          account: { ...MOCK_OUTLINE_ACCOUNT, host: origin },
          connectedAt: now,
          error: null,
          errorKind: null,
          lastAttemptAt: now,
          lastOkAt: now,
          status: "connected",
        };
        tables.connections.set(kind, connected);
        yield* database.emit("connections", kind, null, "updated");
        // Rust syncs the projects' selections again in the background.
        for (const selection of [...tables.selections.values()]) {
          if (selection.kind === kind) {
            yield* syncSelection(selection.projectId, kind);
          }
        }
        return { connected };
      });

      const disconnect = Effect.fnUntraced(function* (kind: ConnectorKind) {
        const current = tables.connections.get(kind);
        if (!current) {
          return;
        }
        tables.connections.set(kind, {
          ...current,
          account: null,
          connectedAt: null,
          error: null,
          errorKind: null,
          lastAttemptAt: null,
          lastOkAt: null,
          status: "disconnected",
        });
        yield* database.emit("connections", kind, null, "deleted");
      });

      const browse = Effect.fnUntraced(function* (
        kind: ConnectorKind,
        parent: ExternalRef | null
      ) {
        yield* outlineOnly(kind);
        const connection = tables.connections.get(kind);
        if (connection?.status !== "connected") {
          return yield* invalid(`${KIND_LABEL[kind]} не подключён`);
        }
        const nodes = mockOutlineBrowse(tables.outline, parent);
        if (!nodes) {
          return yield* external("Не найдено");
        }
        return nodes;
      });

      const viewOf = (
        projectId: string,
        kind: ConnectorKind
      ): ProjectConnectorView => {
        const selection = tables.selections.get(selectionKey(projectId, kind));
        const connection = tables.connections.get(kind);
        const teamId = connection?.account?.teamId;
        const items = (selection?.items ?? []).map(
          (item): SelectionItemView => {
            const otherAccount =
              teamId !== undefined &&
              selection !== undefined &&
              selection.accountRef !== teamId;
            const missing = selection?.missing.has(item.externalId) ?? false;
            return {
              externalId: item.externalId,
              itemKind: item.itemKind,
              otherAccount,
              status: otherAccount || missing ? "unavailable" : "ok",
              title: item.title,
              url: item.url ?? null,
            };
          }
        );
        return {
          connected: connection?.status !== "disconnected",
          items,
          kind,
          projectId,
          sync: selection?.sync ?? null,
          syncing: false,
        };
      };

      const selectionGet = Effect.fnUntraced(function* (projectId: string) {
        yield* projectExists(projectId);
        return [viewOf(projectId, "outline")];
      });

      /** Plays `sync_project` over the demo Outline. */
      const syncSelection = Effect.fnUntraced(function* (
        projectId: string,
        kind: ConnectorKind
      ) {
        const key = selectionKey(projectId, kind);
        const selection = tables.selections.get(key);
        if (!selection) {
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        const connection = tables.connections.get(kind);
        const failed = (state: Pick<SyncState, "error" | "errorKind">) =>
          Effect.gen(function* () {
            tables.selections.set(key, {
              ...selection,
              sync: {
                error: state.error,
                errorKind: state.errorKind,
                lastAttemptAt: now,
                lastOkAt: selection.sync?.lastOkAt ?? null,
                skipped: selection.sync?.skipped ?? 0,
              },
            });
            yield* database.emit(
              "connectorSelections",
              kind,
              projectId,
              "updated"
            );
          });
        if (!connection || connection.status === "disconnected") {
          return yield* failed({
            error: `${KIND_LABEL[kind]} отключён`,
            errorKind: "disconnected",
          });
        }
        if (connection.status === "error") {
          return yield* failed({
            error: connection.error ?? "Ключ больше не подходит",
            errorKind: connection.errorKind ?? "unauthorized",
          });
        }
        const otherTeam = selection.accountRef !== connection.account?.teamId;
        const { documents, missing } = resolveSelection(
          tables,
          selection.items
        );
        // Another team's items stay as they are until the manager decides.
        const changed = otherTeam
          ? false
          : applyDocuments(tables, projectId, documents.slice(0, MAX), now);
        tables.selections.set(key, {
          ...selection,
          missing,
          sync: {
            error: null,
            errorKind: null,
            lastAttemptAt: now,
            lastOkAt: now,
            skipped: Math.max(0, documents.length - MAX),
          },
        });
        if (changed) {
          yield* database.emit("project", projectId, projectId, "updated");
        } else {
          yield* database.emit(
            "connectorSelections",
            kind,
            projectId,
            "updated"
          );
        }
      });

      const selectionSet = Effect.fnUntraced(function* (
        projectId: string,
        kind: ConnectorKind,
        items: SelectionItem[]
      ) {
        yield* outlineOnly(kind);
        yield* projectExists(projectId);
        const key = selectionKey(projectId, kind);
        if (items.length === 0) {
          tables.selections.delete(key);
          applyDocuments(tables, projectId, [], 0);
          yield* database.emit("project", projectId, projectId, "updated");
          return viewOf(projectId, kind);
        }
        const connection = tables.connections.get(kind);
        if (connection?.status === "disconnected" || !connection?.account) {
          return yield* invalid(`${KIND_LABEL[kind]} не подключён`);
        }
        const { documents } = resolveSelection(tables, items);
        if (documents.length > MAX) {
          return yield* invalid(limitMessage(kind, documents.length));
        }
        const previous = tables.selections.get(key);
        const selection: MockSelection = {
          accountRef: connection.account.teamId,
          items,
          kind,
          missing: new Set(),
          projectId,
          sync: previous?.sync ?? null,
        };
        tables.selections.set(key, selection);
        yield* database.emit("connectorSelections", kind, projectId, "updated");
        yield* syncSelection(projectId, kind);
        return viewOf(projectId, kind);
      });

      const sync = Effect.fnUntraced(function* (
        projectId: string,
        kind: ConnectorKind | null
      ) {
        yield* projectExists(projectId);
        yield* syncSelection(projectId, kind ?? "outline");
      });

      return Connectors.of({
        browse,
        connectApiKey,
        disconnect,
        list: Effect.sync(() => [...tables.connections.values()]),
        selectionGet,
        selectionSet,
        sync,
      });
    })
  );
}

/** How long the demo key check takes. */
export const MOCK_CONNECT_DELAY_MS = 1200;

/** The most documents a project takes from a connector. */
export const MAX_CONNECTOR_DOCUMENTS = 200;
const MAX = MAX_CONNECTOR_DOCUMENTS;

const MOCK_OUTLINE_KEY = /^ol_api_[A-Za-z0-9]{20,}$/u;

const KIND_LABEL: Record<ConnectorKind, string> = {
  clickup: "ClickUp",
  github: "GitHub",
  outline: "Outline",
};

/** What Rust says when a selection brings too many documents. */
export function limitMessage(kind: ConnectorKind, count: number) {
  return `Из ${KIND_LABEL[kind]} в проект загружается не больше ${MAX} документов, а в выбранном ${count}. Выберите отдельные документы.`;
}

function selectionKey(projectId: string, kind: ConnectorKind) {
  return `${projectId}:${kind}`;
}

/** A failure of the service, as Rust reports it. */
const external = (message: string) =>
  new BackendError({ kind: "External", message });

const LOCALHOSTS = new Set(["localhost", "127.0.0.1"]);
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu;

/** The address normalization of Rust (`outline::address`). */
function mockNormalizeHost(input: string): string | { reason: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { reason: "Введите адрес Outline" };
  }
  try {
    const url = new URL(SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol === "http:" && !LOCALHOSTS.has(url.hostname)) {
      return { reason: "Нужен адрес с https" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { reason: "Нужен адрес вида https://…" };
    }
    return url.origin;
  } catch {
    return { reason: "Не похоже на адрес Outline" };
  }
}

/** The documents a selection brings, newest first, and what is gone. */
function resolveSelection(tables: MockTables, items: SelectionItem[]) {
  const excluded = new Set(
    items
      .filter((item) => item.itemKind === "exclude")
      .map((item) => item.externalId)
  );
  const found = new Map<string, MockOutlineDocument>();
  const missing = new Set<string>();
  for (const item of items) {
    if (item.itemKind === "exclude") {
      continue;
    }
    let documents: MockOutlineDocument[] | undefined;
    if (item.itemKind === "container") {
      documents = tables.outline.find(
        (collection) => collection.id === item.externalId
      )?.documents;
    } else {
      const all = tables.outline.flatMap((collection) =>
        flattenDocuments(collection.documents)
      );
      const document = all.find((entry) => entry.id === item.externalId);
      documents = document ? [document] : undefined;
    }
    if (!documents) {
      missing.add(item.externalId);
      continue;
    }
    for (const document of flattenDocuments(documents)) {
      if (!excluded.has(document.id)) {
        found.set(document.id, document);
      }
    }
  }
  const documents = [...found.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  return { documents, missing };
}

const MOCK_CHARS_PER_DOCUMENT = 2400;

/**
 * Makes the project's Outline sources these documents; whether anything
 * changed. A document keeps its source while its version is the same.
 */
function applyDocuments(
  tables: MockTables,
  projectId: string,
  documents: MockOutlineDocument[],
  now: number
) {
  let changed = false;
  const wanted = new Map(documents.map((item) => [item.id, item]));
  for (const [id, { source }] of tables.sources) {
    if (source.projectId !== projectId || !source.origin) {
      continue;
    }
    const document = wanted.get(source.origin.externalId);
    if (document && document.updatedAt <= source.origin.updatedAt) {
      wanted.delete(document.id);
    } else if (!document) {
      tables.sources.delete(id);
      changed = true;
    }
  }
  let order = 0;
  for (const document of wanted.values()) {
    order += 1;
    const id = `${projectId}:outline:${document.id}`;
    const source: ProjectSource = {
      createdAt: now + order,
      error: document.empty ? "В документе только заголовок" : null,
      extension: "md",
      id,
      name: document.title,
      origin: {
        connector: "outline",
        externalId: document.id,
        updatedAt: Math.max(document.updatedAt, now),
        url: mockOutlineUrl("doc", document.id),
      },
      projectId,
      size: document.empty ? 0 : MOCK_CHARS_PER_DOCUMENT,
      status: document.empty ? "noText" : "ready",
      textChars: document.empty ? 0 : MOCK_CHARS_PER_DOCUMENT,
      truncated: false,
    };
    tables.sources.set(id, { sha256: `${id}:${document.updatedAt}`, source });
    changed = true;
  }
  return changed;
}
