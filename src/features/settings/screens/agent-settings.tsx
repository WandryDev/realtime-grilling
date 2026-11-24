"use client";

import { ClaudeIcon } from "@grill/ui/brand-icons";
import { Button } from "@grill/ui/button";
import { Progress, ProgressLabel } from "@grill/ui/progress";
import { Spinner } from "@grill/ui/spinner";
import type { ReactNode } from "react";
import type {
  AgentState,
  LimitWindow,
  SubscriptionLimitView,
  WindowMeasure,
} from "@/bindings";
import {
  DEFAULT_SETTINGS,
  type SettingChange,
  type SettingsValues,
} from "@/data/settings";
import { resetLine } from "@/lib/agent-limit";
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
  AGENT_LIMIT,
  AGENT_LIMIT_OPTIONS,
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

const WINDOW_LABELS: Record<LimitWindow, string> = {
  session: "Сессия, 5 часов",
  week: "Неделя",
};

/** Where the outlook puts a window: at its threshold, close to it, or not. */
function windowTone(limit: SubscriptionLimitView, window: LimitWindow) {
  const { outlook } = limit;
  if (outlook.kind === "ok" || outlook.hit.window !== window) {
    return "ok";
  }
  return outlook.kind;
}

/** «Порог Grill 90 %, замер 12:41»; the reset when known. */
function measureNote(
  measure: WindowMeasure,
  threshold: number | null,
  tone: "ok" | "near" | "reached"
) {
  const measured = `замер ${momentLabel(measure.measuredAt)}`;
  if (tone === "reached") {
    return `Порог Grill ${threshold} % пройден: агент ждёт сброса, ${measured}`;
  }
  if (threshold === null) {
    return `Без порога Grill, ${measured}`;
  }
  return `Порог Grill ${threshold} %, ${measured}`;
}

/**
 * One window of the subscription limit: its share with the reset and the
 * time of the measure, or «нет данных».
 */
function WindowFact({
  limit,
  window,
}: {
  limit: SubscriptionLimitView;
  window: LimitWindow;
}) {
  const label = WINDOW_LABELS[window];
  const measure = limit[window];
  if (!measure) {
    return (
      <AgentFact label={label}>
        <span className="text-muted-foreground">нет данных</span>
      </AgentFact>
    );
  }
  const tone = windowTone(limit, window);
  const threshold = limit.thresholds[window];
  return (
    <AgentFact className="items-start" label={label}>
      <Progress
        className={cn(
          "[&_[data-slot=progress-track]]:bg-border gap-y-2",
          tone === "ok"
            ? "[&_[data-slot=progress-indicator]]:bg-foreground"
            : "[&_[data-slot=progress-indicator]]:bg-contradiction"
        )}
        locale="ru-RU"
        size="sm"
        tone="active"
        value={Math.min(PERCENT, measure.used)}
      >
        <ProgressLabel className="font-normal">
          Использовано {measure.used} %
        </ProgressLabel>
        <span className="text-muted-foreground ml-auto text-xs">
          {resetLine(measure.resetsAt)}
        </span>
      </Progress>
      <p
        className={cn(
          "mt-2 text-sm",
          tone === "ok" ? "text-muted-foreground" : "text-contradiction"
        )}
      >
        {measureNote(measure, threshold, tone)}
      </p>
    </AgentFact>
  );
}

/** Both windows; «нет данных» before the backend answered. */
function LimitFacts({ limit }: { limit: SubscriptionLimitView | null }) {
  if (!limit) {
    return (
      <AgentFact label="Лимит подписки">
        <span className="text-muted-foreground">нет данных</span>
      </AgentFact>
    );
  }
  return (
    <>
      <WindowFact limit={limit} window="session" />
      <WindowFact limit={limit} window="week" />
    </>
  );
}

/** «Проверить снова», «Указать другой», «Войти». */
export interface AgentHandlers {
  onChangePath?: () => void;
  onCheck?: () => void;
  onSignIn?: () => void;
}

/**
 * "Агент": the CLI and its subscription, the share of the limit of both
 * windows and the thresholds of Grill, how questions are suggested.
 * `agent` is what Claude Code answered, `null` while the first check
 * runs; `limit` the share of the limit, `null` before it is known.
 */
export function AgentSettings({
  agent = AGENT,
  checking = false,
  onChange,
  onChangePath,
  onCheck,
  onSignIn,
  limit = AGENT_LIMIT,
  signingIn = false,
  values = DEFAULT_SETTINGS,
}: AgentHandlers & {
  agent?: AgentState | null;
  /** "Проверить снова" is running. */
  checking?: boolean;
  limit?: SubscriptionLimitView | null;
  onChange?: SettingChange;
  /** The login dialog is open. */
  signingIn?: boolean;
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
          <LimitFacts limit={limit} />
        </dl>
      </section>
      <SettingsSection className="pt-12" title="Лимит Grill">
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.agentLimitSession}
              label="Порог сессии"
              onSettingChange={onChange}
              options={AGENT_LIMIT_OPTIONS}
              setting="agentLimitSession"
            />
          }
          description="Сколько 5-часового окна подписки может занять Grill. На пороге вопросы встают, запись и расшифровка идут, остаток остаётся вам"
          title="Порог сессии"
        />
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.agentLimitWeek}
              label="Порог недели"
              onSettingChange={onChange}
              options={AGENT_LIMIT_OPTIONS}
              setting="agentLimitWeek"
            />
          }
          description="Недельное окно всех моделей. В звонке можно продолжить сверх порога, итоги и бриф собираются по кнопке"
          title="Порог недели"
        />
      </SettingsSection>
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

export function AgentSettingsScreen({
  className,
  limit,
}: {
  className?: string;
  /** The share of the limit; the demo's below the thresholds by default. */
  limit?: SubscriptionLimitView;
}) {
  return (
    <SettingsScreen className={className} section="agent">
      <AgentSettings limit={limit} />
    </SettingsScreen>
  );
}
