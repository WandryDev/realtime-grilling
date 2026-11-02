"use client";

import Link from "next/link";
import { type ReactNode, useCallback } from "react";

import {
  ClaudeIcon,
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import type { IntegrationState, IntegrationsState } from "@/data/integrations";
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
 * In the app the rows follow the integrations store (`services`).
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

/** "2 из 3 работают", "1 из 3 работает". */
export function workingSummary(services: IntegrationsState) {
  const working = SERVICE_ORDER.filter(
    (service) => services[service].status === "connected"
  ).length;
  const verb = working === 1 ? "работает" : "работают";
  return `${working} из ${SERVICE_ORDER.length} ${verb}`;
}

export interface IntegrationHandlers {
  /** "Изменить доступ" (GitHub): the access page in the browser. */
  onChangeAccess?: (service: IntegrationService) => void;
  /** "Подключить" on a service that is not connected. */
  onConnect?: (service: IntegrationService) => void;
  onDisconnect?: (service: IntegrationService) => void;
  /** "Обновить ключ" / "Подключить заново" on a broken service. */
  onReconnect?: (service: IntegrationService) => void;
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
    return <p className="font-mono text-xs">{state.account ?? OUTLINE.host}</p>;
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
  const { onChangeAccess, onConnect, onDisconnect, onReconnect } = handlers;
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
              <p className="text-muted-foreground text-sm">{OUTLINE.impact}</p>
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
          <ServiceTextAction onClick={disconnect}>Отключить</ServiceTextAction>
        </>
      }
      description={CONNECTED_DESCRIPTION[service]}
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
