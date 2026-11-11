"use client";

import Link from "next/link";
import { type ReactNode, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import {
  ClaudeIcon,
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
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
 * and ClickUp are «скоро» there, Outline shows its team, when it last
 * answered, «не удалось обновить» with «Повторить» when it did not, and
 * «Обновить ключ» when the key no longer works.
 */
type IntegrationsScreenState =
  | "default"
  | "confirm-disconnect"
  | "github-disconnected";

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
    clickup: { status: "connected" },
    github: { status: githubConnected ? "connected" : "disconnected" },
    outline: { account: OUTLINE.host, error: OUTLINE.error, status: "error" },
  };
}

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

/** What a broken Outline means for the projects. */
function outlineImpact(state: IntegrationState, projects?: string[]) {
  if (!projects) {
    return OUTLINE.impact;
  }
  const where =
    projects.length > 0
      ? `документы Outline в проектах (${projects.map((name) => `«${name}»`).join(", ")}) остаются с последним текстом`
      : "документы Outline не обновляются";
  const last = state.lastOkAt
    ? ` Последний раз работало ${relativeTime(state.lastOkAt)}.`
    : "";
  return `Пока ключ не обновлён, ${where}.${last}`;
}

export interface IntegrationHandlers {
  /** "Изменить доступ" (GitHub): the access page in the browser. */
  onChangeAccess?: (service: IntegrationService) => void;
  /** "Подключить" on a service that is not connected. */
  onConnect?: (service: IntegrationService) => void;
  onDisconnect?: (service: IntegrationService) => void;
  /** "Обновить ключ" / "Подключить заново" on a broken service. */
  onReconnect?: (service: IntegrationService) => void;
  /** «Повторить» after the service did not answer. */
  onRetry?: (service: IntegrationService) => void;
  /** Projects that picked Outline's documents; the previews leave it out. */
  outlineProjects?: string[];
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
      <ul aria-label="Репозитории" className="flex items-center gap-1.5">
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
    const stale = state.errorKind === "unreachable";
    return (
      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs">{state.account ?? OUTLINE.host}</p>
        {state.lastOkAt === undefined ? null : (
          <p
            className={
              stale
                ? "text-contradiction text-sm"
                : "text-muted-foreground text-sm"
            }
          >
            {stale
              ? `Не удалось обновить: Outline не ответил. Последний раз отвечал ${since(state.lastOkAt)}`
              : `Обновлено ${since(state.lastOkAt)}`}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
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
  const {
    onChangeAccess,
    onConnect,
    onDisconnect,
    onReconnect,
    onRetry,
    outlineProjects,
    retrying,
  } = handlers;
  const name = SERVICE_NAMES[service];
  const icon = SERVICE_ICONS[service];

  const changeAccess = useCallback(
    () => onChangeAccess?.(service),
    [onChangeAccess, service]
  );
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
      <ServiceRow
        actions={
          <>
            <ServiceTextAction onClick={disconnect}>
              Отключить
            </ServiceTextAction>
            <Button className="h-9 px-4" onClick={reconnect}>
              {service === "outline" ? "Обновить ключ" : "Подключить заново"}
            </Button>
          </>
        }
        description={state.error ?? OUTLINE.error}
        details={
          service === "outline" ? (
            <div className="flex flex-col gap-1">
              <p className="font-mono text-xs">
                {state.account ?? OUTLINE.host}
              </p>
              <p className="text-muted-foreground text-sm">
                {outlineImpact(state, outlineProjects)}
              </p>
            </div>
          ) : undefined
        }
        error
        icon={icon}
        name={name}
        status={<ServiceBroken />}
      />
    );
  }

  return (
    <ServiceRow
      actions={
        <>
          {service === "github" ? (
            <ServiceTextAction emphasis onClick={changeAccess}>
              Изменить доступ
            </ServiceTextAction>
          ) : null}
          {service === "outline" && state.errorKind === "unreachable" ? (
            <ServiceTextAction disabled={retrying} emphasis onClick={retry}>
              {retrying ? "Проверяем…" : "Повторить"}
            </ServiceTextAction>
          ) : null}
          <ServiceTextAction onClick={disconnect}>Отключить</ServiceTextAction>
        </>
      }
      description={
        service === "outline" && state.team
          ? `Команда ${state.team}, только чтение документов`
          : CONNECTED_DESCRIPTION[service]
      }
      details={<ConnectedDetails service={service} state={state} />}
      icon={icon}
      name={name}
      status={<ServiceConnected />}
    />
  );
}

/** "Интеграции": services available in every project, and the agent. */
export function IntegrationsSettings({
  githubConnected = true,
  services = previewServices(githubConnected),
  ...handlers
}: IntegrationHandlers & {
  /** Preview only: GitHub connected or not, when `services` is not set. */
  githubConnected?: boolean;
  services?: IntegrationsState;
}) {
  return (
    <>
      <ServiceGroup meta={workingSummary(services)} title="Сервисы">
        {SERVICE_ORDER.map((service) => (
          <IntegrationServiceRow
            handlers={handlers}
            key={service}
            service={service}
            state={services[service]}
          />
        ))}
      </ServiceGroup>
      <ServiceGroup title="Агент">
        <ServiceRow
          description={AGENT_MCP.description}
          icon={<ClaudeIcon />}
          meta={AGENT_MCP.version}
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
      <div className="absolute right-2 bottom-10 left-64 z-10 flex justify-center">
        <ServiceDisconnectedToast />
      </div>
    );
  }

  return (
    <SettingsScreen
      alerts={["integrations"]}
      className={className}
      navigation="panel"
      overlay={overlay}
      section="integrations"
    >
      <IntegrationsSettings githubConnected={state !== "github-disconnected"} />
    </SettingsScreen>
  );
}
