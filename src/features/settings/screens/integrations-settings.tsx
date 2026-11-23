"use client";

import { Badge } from "@grill/ui/badge";
import {
  ClaudeIcon,
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@grill/ui/brand-icons";
import { Button } from "@grill/ui/button";
import Link from "next/link";
import { type ReactNode, useCallback } from "react";
import type { IntegrationState, IntegrationsState } from "@/data/integrations";
import { relativeTime } from "@/features/projects/project-data";
import { type IntegrationService, routes } from "@/lib/routes";

import {
  DisconnectServiceDialog,
  ServiceDisconnectedToast,
} from "../components/integration-overlays";
import {
  ServiceBroken,
  ServiceChip,
  ServiceConnected,
  ServiceConnecting,
  ServiceDisconnected,
  ServiceGroup,
  ServiceRow,
  ServiceTextAction,
} from "../components/service-row";
import { SettingsScreen } from "../components/settings-screen";
import { ChevronRightIcon, SmallLockIcon } from "../icons";
import { AGENT_MCP, CLICKUP, GITHUB, OUTLINE, SERVICE_NAMES } from "../mock";

/*
 * States of Settings → Интеграции from the Paper file:
 * - default: GitHub connected, Outline's key broken, ClickUp read-only
 * - confirm-disconnect: the "Отключить GitHub?" dialog over the window
 * - github-disconnected: GitHub back to "Не подключено", undo toast
 * In the app the rows follow the integrations store (`services`): GitHub
 * is «скоро» there; Outline and ClickUp offer «Подключить», then show their
 * team or workspace (ClickUp: whose token), when they last answered,
 * «не удалось обновить» with «Повторить» when they did not, and «Обновить
 * ключ» / «Обновить токен» when the secret no longer works.
 */
type IntegrationsScreenState =
  | "default"
  | "confirm-disconnect"
  | "github-disconnected"
  | "app-empty"
  | "clickup-revoked";

const SERVICE_ORDER: IntegrationService[] = ["github", "outline", "clickup"];

const SERVICE_ICONS: Record<IntegrationService, ReactNode> = {
  clickup: <ClickUpIcon />,
  github: <GitHubIcon />,
  outline: <OutlineIcon />,
};

const SERVICE_PITCH: Record<IntegrationService, string> = {
  clickup: CLICKUP.pitch,
  github: GITHUB.pitch,
  outline: OUTLINE.pitch,
};

/** The Paper states, for the previews. */
function previewServices(githubConnected: boolean): IntegrationsState {
  return {
    clickup: {
      account: CLICKUP.workspace,
      status: "connected",
      team: CLICKUP.workspace,
      user: CLICKUP.user,
    },
    github: { status: githubConnected ? "connected" : "disconnected" },
    outline: { account: OUTLINE.host, error: OUTLINE.error, status: "error" },
  };
}

/** The app's states: GitHub «скоро», Outline and ClickUp by a secret. */
const APP_PREVIEWS: Partial<
  Record<IntegrationsScreenState, IntegrationsState>
> = {
  "app-empty": {
    clickup: { status: "disconnected" },
    github: { available: false, status: "disconnected" },
    outline: { status: "disconnected" },
  },
  "clickup-revoked": {
    clickup: {
      account: CLICKUP.workspace,
      error: CLICKUP.error,
      errorKind: "unauthorized",
      status: "error",
      team: CLICKUP.workspace,
      user: CLICKUP.user,
    },
    github: { available: false, status: "disconnected" },
    outline: {
      account: OUTLINE.host,
      lastOkAt: Date.UTC(2026, 9, 14, 9, 30),
      status: "connected",
      team: "Pixel Agency",
    },
  },
};

/** "2 из 3 работают", "1 из 3 работает"; «скоро» doesn't count. */
export function workingSummary(services: IntegrationsState) {
  const available = SERVICE_ORDER.filter(
    (service) => services[service].available !== false
  );
  const working = available.filter(
    (service) => services[service].status === "connected"
  ).length;
  const verb = working === 1 ? "работает" : "работают";
  return `${working} из ${available.length} ${verb}`;
}

/** «14 октября, 09:30» or «5 мин назад». */
function since(at: number | null | undefined) {
  return at ? relativeTime(at) : "давно";
}

/** Connected by a key or a token: Outline and ClickUp. */
type KeyService = Exclude<IntegrationService, "github">;

function isKeyService(service: IntegrationService): service is KeyService {
  return service !== "github";
}

const KEY_WORDS: Record<
  KeyService,
  {
    error: string;
    impact: string;
    kept: string;
    reconnect: string;
    stale: string;
  }
> = {
  clickup: {
    error: CLICKUP.error,
    impact: CLICKUP.impact,
    kept: "задачи ClickUp в проектах",
    reconnect: "Обновить токен",
    stale: "задачи ClickUp не обновляются",
  },
  outline: {
    error: OUTLINE.error,
    impact: OUTLINE.impact,
    kept: "документы Outline в проектах",
    reconnect: "Обновить ключ",
    stale: "документы Outline не обновляются",
  },
};

/** What a broken Outline or ClickUp means for the projects. */
function brokenImpact(
  service: KeyService,
  state: IntegrationState,
  projects?: string[]
) {
  const words = KEY_WORDS[service];
  if (!projects) {
    return words.impact;
  }
  const where =
    projects.length > 0
      ? `${words.kept} (${projects.map((name) => `«${name}»`).join(", ")}) остаются с последним текстом`
      : words.stale;
  const last = state.lastOkAt
    ? ` Последний раз работало ${relativeTime(state.lastOkAt)}.`
    : "";
  const secret = service === "clickup" ? "токен" : "ключ";
  return `Пока ${secret} не обновлён, ${where}.${last}`;
}

export interface IntegrationHandlers {
  /** "Подключить" on a service that is not connected. */
  onConnect?: (service: IntegrationService) => void;
  onDisconnect?: (service: IntegrationService) => void;
  /** "Обновить ключ" / "Обновить токен" on a broken service. */
  onReconnect?: (service: IntegrationService) => void;
  /** «Повторить» after the service did not answer. */
  onRetry?: (service: IntegrationService) => void;
  /**
   * Projects that picked each service's documents; the previews leave it
   * out.
   */
  projects?: Partial<Record<IntegrationService, string[]>>;
  /** «Повторить» is running. */
  retrying?: boolean;
}

/** Second line of a connected service: repositories, host, read-only chip. */
function ConnectedDetails({
  service,
  state,
}: {
  service: IntegrationService;
  state: IntegrationState;
}) {
  if (service === "github") {
    return (
      <ul
        aria-label="Репозитории"
        className="flex flex-wrap items-center gap-1.5"
      >
        {GITHUB.repos.map((repo) => (
          <li key={repo}>
            <ServiceChip className="font-mono">{repo}</ServiceChip>
          </li>
        ))}
        <li className="text-muted-foreground pl-1.5 text-sm">
          и ещё {GITHUB.hiddenRepos}
        </li>
      </ul>
    );
  }
  if (service === "outline") {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs">{state.account ?? OUTLINE.host}</p>
        <FreshnessLine service={service} state={state} />
      </div>
    );
  }
  if (state.user !== undefined || state.lastOkAt !== undefined) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm">
          Токен {state.user ?? CLICKUP.user}, только чтение
        </p>
        <FreshnessLine service={service} state={state} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ServiceChip>
        <SmallLockIcon />
        Только чтение
      </ServiceChip>
      <p className="text-muted-foreground pl-1.5 text-sm">
        Задачи обновлены сегодня в{" "}
        <span className="font-mono text-xs">{CLICKUP.syncedAt}</span>
      </p>
    </div>
  );
}

/** When the service last answered, or why it did not. */
function FreshnessLine({
  service,
  state,
}: {
  service: KeyService;
  state: IntegrationState;
}) {
  if (state.lastOkAt === undefined) {
    return null;
  }
  const stale = state.errorKind === "unreachable";
  const failed = state.errorKind === "other" && state.error !== undefined;
  let line = `Обновлено ${since(state.lastOkAt)}`;
  if (stale) {
    line = `Не удалось обновить: ${SERVICE_NAMES[service]} не ответил. Последний раз отвечал ${since(state.lastOkAt)}`;
  } else if (failed) {
    line = `Не удалось обновить: ${state.error}`;
  }
  return (
    <p
      className={
        stale || failed
          ? "text-contradiction text-sm"
          : "text-muted-foreground text-sm"
      }
    >
      {line}
    </p>
  );
}

const CONNECTED_DESCRIPTION: Record<IntegrationService, string> = {
  clickup: CLICKUP.description,
  github: GITHUB.account,
  outline: OUTLINE.connected,
};

/** One service in its current state, with the actions of that state. */
function IntegrationServiceRow({
  handlers,
  service,
  state,
}: {
  handlers: IntegrationHandlers;
  service: IntegrationService;
  state: IntegrationState;
}) {
  const { onConnect, onDisconnect, onReconnect, onRetry, projects, retrying } =
    handlers;
  const name = SERVICE_NAMES[service];
  const icon = SERVICE_ICONS[service];

  const connect = useCallback(() => onConnect?.(service), [onConnect, service]);
  const disconnect = useCallback(
    () => onDisconnect?.(service),
    [onDisconnect, service]
  );
  const reconnect = useCallback(
    () => onReconnect?.(service),
    [onReconnect, service]
  );
  const retry = useCallback(() => onRetry?.(service), [onRetry, service]);

  if (state.available === false) {
    return (
      <ServiceRow
        description={`${SERVICE_PITCH[service]}. Подключится позже`}
        icon={icon}
        name={name}
        status={
          <Badge className="text-xs" size="sm" variant="neutral">
            скоро
          </Badge>
        }
      />
    );
  }

  if (state.status === "disconnected" || state.status === "connecting") {
    return (
      <ServiceRow
        description={SERVICE_PITCH[service]}
        icon={icon}
        name={name}
        status={
          state.status === "connecting" ? (
            <ServiceConnecting />
          ) : (
            <ServiceDisconnected onConnect={connect} />
          )
        }
      />
    );
  }

  if (state.status === "error") {
    return (
      <BrokenServiceRow
        onDisconnect={disconnect}
        onReconnect={reconnect}
        projects={projects}
        service={service}
        state={state}
      />
    );
  }

  return (
    <ServiceRow
      actions={
        <>
          {isKeyService(service) && state.errorKind === "unreachable" ? (
            <ServiceTextAction disabled={retrying} emphasis onClick={retry}>
              {retrying ? "Проверяем…" : "Повторить"}
            </ServiceTextAction>
          ) : null}
          <ServiceTextAction onClick={disconnect}>Отключить</ServiceTextAction>
        </>
      }
      description={connectedDescription(service, state)}
      details={<ConnectedDetails service={service} state={state} />}
      icon={icon}
      name={name}
      status={<ServiceConnected />}
    />
  );
}

function connectedDescription(
  service: IntegrationService,
  state: IntegrationState
) {
  if (service === "outline" && state.team) {
    return `Команда ${state.team}, только чтение документов`;
  }
  if (service === "clickup" && state.team) {
    return `Пространство ${state.team}, только чтение задач и комментариев`;
  }
  return CONNECTED_DESCRIPTION[service];
}

/** A service whose secret stopped working: why, and how to fix it. */
function BrokenServiceRow({
  onDisconnect,
  onReconnect,
  projects,
  service,
  state,
}: {
  onDisconnect: () => void;
  onReconnect: () => void;
  projects?: Partial<Record<IntegrationService, string[]>>;
  service: IntegrationService;
  state: IntegrationState;
}) {
  const keyed = isKeyService(service) ? service : null;
  return (
    <ServiceRow
      actions={
        <>
          <ServiceTextAction onClick={onDisconnect}>
            Отключить
          </ServiceTextAction>
          <Button className="h-9 px-4" onClick={onReconnect}>
            {keyed ? KEY_WORDS[keyed].reconnect : "Подключить заново"}
          </Button>
        </>
      }
      description={state.error ?? (keyed ? KEY_WORDS[keyed].error : "")}
      details={
        keyed ? (
          <div className="flex flex-col gap-1">
            {keyed === "outline" ? (
              <p className="font-mono text-xs">
                {state.account ?? OUTLINE.host}
              </p>
            ) : null}
            <p className="text-muted-foreground text-sm">
              {brokenImpact(keyed, state, projects?.[keyed])}
            </p>
          </div>
        ) : undefined
      }
      error
      icon={SERVICE_ICONS[service]}
      name={SERVICE_NAMES[service]}
      status={<ServiceBroken />}
    />
  );
}

/** "Интеграции": services available in every project, and the agent. */
export function IntegrationsSettings({
  agentVersion = AGENT_MCP.version,
  githubConnected = true,
  services = previewServices(githubConnected),
  ...handlers
}: IntegrationHandlers & {
  /** The version Claude Code reports, «не найден» without one. */
  agentVersion?: string;
  /** Preview only: GitHub connected or not, when `services` is not set. */
  githubConnected?: boolean;
  services?: IntegrationsState;
}) {
  return (
    <>
      <ServiceGroup
        className="pt-4"
        meta={workingSummary(services)}
        title="Сервисы"
      >
        {SERVICE_ORDER.map((service) => (
          <IntegrationServiceRow
            handlers={handlers}
            key={service}
            service={service}
            state={services[service]}
          />
        ))}
      </ServiceGroup>
      <ServiceGroup className="pt-12" title="Агент">
        <ServiceRow
          description={AGENT_MCP.description}
          icon={<ClaudeIcon />}
          meta={agentVersion}
          name="Claude Code"
          status={
            <Link
              className="hover:text-muted-foreground focus-visible:focus-ring flex items-center gap-1 rounded-full text-sm font-medium transition-colors"
              href={routes.settings("agent")}
            >
              Раздел «Агент»
              <ChevronRightIcon className="text-muted-foreground size-4" />
            </Link>
          }
        />
      </ServiceGroup>
    </>
  );
}

export function IntegrationsSettingsScreen({
  className,
  state = "default",
}: {
  className?: string;
  state?: IntegrationsScreenState;
}) {
  let overlay: ReactNode = null;
  if (state === "confirm-disconnect") {
    overlay = <DisconnectServiceDialog />;
  } else if (state === "github-disconnected") {
    overlay = (
      <div className="absolute right-2 bottom-10 left-2 z-10 flex justify-center @5xl/window:left-64">
        <ServiceDisconnectedToast />
      </div>
    );
  }

  return (
    <SettingsScreen
      alerts={["integrations"]}
      className={className}
      overlay={overlay}
      section="integrations"
    >
      <IntegrationsSettings
        githubConnected={state !== "github-disconnected"}
        services={APP_PREVIEWS[state]}
      />
    </SettingsScreen>
  );
}
