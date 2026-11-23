"use client";

import { ClaudeIcon } from "@grill/ui/brand-icons";
import { Button } from "@grill/ui/button";
import { Progress, ProgressLabel } from "@grill/ui/progress";
import { Spinner } from "@grill/ui/spinner";
import type { ReactNode } from "react";
import type { AgentState, AgentUsage } from "@/bindings";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
} from "@/data/settings";
import { cn } from "@/lib/utils";

import {
  SettingsRow,
  SettingsSection,
  SettingsSegments,
} from "../components/settings-rows";
import { SettingsScreen } from "../components/settings-screen";
import { agentStatusLine, momentLabel, subscriptionName } from "../format";
import { RefreshIcon } from "../icons";
import {
  AGENT,
  AGENT_LIMIT_LOW,
  AGENT_UTILIZATION,
  QUESTION_COUNT,
  QUESTION_FREQUENCY,
} from "../mock";

/** Muted text action at the end of a fact row ("Указать другой", "Войти"). */
function FactAction({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      className="-mx-2.5 -my-1.5"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      variant="ghost"
    >
      {children}
    </Button>
  );
}

/**
 * Label in a 180px column (128px on a narrow panel), the value, an optional
 * note or action right.
 */
function AgentFact({
  children,
  className,
  label,
  trailing,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-4 @2xl/panel:gap-6", className)}>
      <dt className="text-muted-foreground w-32 shrink-0 text-base @2xl/panel:w-45">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-base">{children}</dd>
      {trailing ? <dd className="shrink-0">{trailing}</dd> : null}
    </div>
  );
}

/**
 * Agent tile, name and the status line, "Проверить снова" right; under them
 * when the row is too narrow.
 */
function AgentSummary({
  agent,
  checking,
  onCheck,
}: {
  agent: AgentState | null;
  checking: boolean;
  onCheck?: () => void;
}) {
  const ready = agent?.status === "ready";
  const unknown = agent === null;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
      <span className="bg-surface flex size-10 shrink-0 items-center justify-center rounded-sm">
        <ClaudeIcon className="size-5" />
      </span>
      <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-0.5">
        <p className="text-lg font-semibold">Claude Code</p>
        <p
          className={cn(
            "flex items-center gap-1.5 text-sm",
            ready && "text-confirmed",
            !(ready || unknown) && "text-contradiction",
            unknown && "text-muted-foreground"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              ready && "bg-confirmed",
              !(ready || unknown) && "bg-contradiction",
              unknown && "bg-muted-foreground"
            )}
          />
          {agentStatusLine(agent)}
        </p>
      </div>
      <Button disabled={checking} onClick={onCheck} variant="secondary">
        {checking ? (
          <Spinner aria-hidden="true" className="size-3.5" />
        ) : (
          <RefreshIcon className="size-3.5" />
        )}
        {checking ? "Проверяем…" : "Проверить снова"}
      </Button>
    </div>
  );
}

/** The login row's value: the subscription, «нужен вход» or why not. */
function loginLabel(agent: AgentState | null) {
  if (!agent) {
    return <span className="text-muted-foreground">Проверяем…</span>;
  }
  switch (agent.status) {
    case "ready": {
      const plan = subscriptionName(agent.subscriptionType);
      return plan ? `Выполнен, подписка ${plan}` : "Выполнен";
    }
    case "needsLogin":
      return <span className="text-contradiction">нужен вход</span>;
    case "notInstalled":
      return (
        <span className="text-muted-foreground">Claude Code не найден</span>
      );
    default:
      return (
        <span className="text-contradiction">
          {agent.message.split("\n")[0]}
        </span>
      );
  }
}

const PERCENT = 100;

/** The last known share of the limit, or «нет данных». */
function UsageFact({ usage }: { usage: AgentUsage | null }) {
  if (!usage) {
    return (
      <AgentFact label="Лимит подписки">
        <span className="text-muted-foreground">нет данных</span>
      </AgentFact>
    );
  }
  const used = Math.round(usage.utilization * PERCENT);
  const low = usage.utilization >= AGENT_LIMIT_LOW;
  return (
    <AgentFact className="items-start" label="Лимит подписки">
      <Progress
        className={cn(
          "[&_[data-slot=progress-track]]:bg-border gap-y-2",
          low
            ? "[&_[data-slot=progress-indicator]]:bg-contradiction"
            : "[&_[data-slot=progress-indicator]]:bg-foreground"
        )}
        locale="ru-RU"
        size="sm"
        tone="active"
        value={Math.min(PERCENT, used)}
      >
        <ProgressLabel className="font-normal">
          Использовано {used} %
        </ProgressLabel>
        <span className="text-muted-foreground ml-auto font-mono text-xs">
          {momentLabel(usage.measuredAt)}
        </span>
      </Progress>
      <p
        className={cn(
          "mt-2 text-sm",
          low ? "text-contradiction" : "text-muted-foreground"
        )}
      >
        {low
          ? "Почти исчерпан: вопросы могут перестать приходить посреди разговора"
          : "По последнему ответу агента, время замера справа"}
      </p>
    </AgentFact>
  );
}

/** «Проверить снова», «Указать другой», «Войти». */
export interface AgentHandlers {
  onChangePath?: () => void;
  onCheck?: () => void;
  onSignIn?: () => void;
}

/**
 * "Агент": the CLI and its subscription, how questions are suggested.
 * `agent` is what Claude Code answered, `null` while the first check
 * runs; `usage` the last known share of the limit (red from 90 %).
 */
export function AgentSettings({
  agent = AGENT,
  checking = false,
  onChange,
  onChangePath,
  onCheck,
  onSignIn,
  signingIn = false,
  usage = { measuredAt: DEMO_MEASURED_AT, utilization: AGENT_UTILIZATION },
  values = DEFAULT_SETTINGS,
}: AgentHandlers & {
  agent?: AgentState | null;
  /** "Проверить снова" is running. */
  checking?: boolean;
  onChange?: SettingChange;
  /** The login dialog is open. */
  signingIn?: boolean;
  usage?: AgentUsage | null;
  values?: SettingsValues;
}) {
  const version =
    agent?.status === "ready" || agent?.status === "needsLogin"
      ? agent.version
      : null;
  return (
    <>
      <section aria-label="Claude Code" className="flex flex-col gap-7 pt-4">
        <AgentSummary agent={agent} checking={checking} onCheck={onCheck} />
        <dl className="flex flex-col gap-4">
          <AgentFact
            label="Путь"
            trailing={
              <FactAction onClick={onChangePath}>Указать другой</FactAction>
            }
          >
            {values.agentPath ? (
              <span className="font-mono text-sm wrap-anywhere">
                {values.agentPath}
              </span>
            ) : (
              <span className="text-muted-foreground">
                найден автоматически
              </span>
            )}
          </AgentFact>
          <AgentFact label="Версия">
            <span className="font-mono text-sm">{version ?? "—"}</span>
          </AgentFact>
          <AgentFact
            label="Вход"
            trailing={
              agent?.status === "needsLogin" ? (
                <FactAction disabled={signingIn} onClick={onSignIn}>
                  {signingIn ? (
                    <Spinner aria-hidden="true" className="size-3.5" />
                  ) : null}
                  Войти
                </FactAction>
              ) : null
            }
          >
            {loginLabel(agent)}
          </AgentFact>
          <UsageFact usage={usage} />
        </dl>
      </section>
      <SettingsSection className="pt-12" title="Вопросы во время звонка">
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.questionFrequency}
              label="Как часто предлагать вопросы"
              onSettingChange={onChange}
              options={QUESTION_FREQUENCY}
              setting="questionFrequency"
            />
          }
          description="Обычно агент смотрит разговор, как только клиент договорил. Реже — не чаще раза в полминуты, лимит подписки расходуется медленнее"
          title="Как часто предлагать вопросы"
        />
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.questionCount}
              itemClassName="w-10 px-0"
              label="Сколько вопросов показывать"
              onSettingChange={onChange}
              options={QUESTION_COUNT}
              setting="questionCount"
            />
          }
          description="Главный крупно, остальные очередью под ним"
          title="Сколько вопросов показывать"
        />
      </SettingsSection>
    </>
  );
}

/** The demo's last measure of the limit, 12 November 12:41. */
const DEMO_MEASURED_AT = new Date(2026, 10, 12, 12, 41).getTime();

export function AgentSettingsScreen({ className }: { className?: string }) {
  return (
    <SettingsScreen className={className} section="agent">
      <AgentSettings />
    </SettingsScreen>
  );
}
