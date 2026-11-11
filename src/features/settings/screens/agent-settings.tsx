"use client";

import type { ReactNode } from "react";

import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
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
import { RefreshIcon } from "../icons";
import {
  AGENT,
  FINAL_CHECK,
  QUESTION_COUNT,
  QUESTION_FREQUENCY,
} from "../mock";

/** Muted text action at the end of a fact row ("Указать другой", "Выйти"). */
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

/** Label in a 180px column, the value, an optional note or action right. */
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
    <div
      className={cn(
        "border-border flex items-center gap-6 border-b py-3.5 last:border-b-0",
        className
      )}
    >
      <dt className="text-muted-foreground w-45 shrink-0 text-base">{label}</dt>
      <dd className="min-w-0 flex-1 text-base">{children}</dd>
      {trailing ? <dd className="shrink-0">{trailing}</dd> : null}
    </div>
  );
}

/**
 * Agent tile, name and the status line, "Проверить снова" right. Green when
 * ready, red when signed out.
 */
function AgentSummary({
  agent,
  checking,
  onCheck,
  signedIn,
}: {
  agent: typeof AGENT;
  checking: boolean;
  onCheck?: () => void;
  signedIn: boolean;
}) {
  return (
    <div className="border-border flex items-center gap-3.5 border-b py-4.5">
      <span className="bg-surface flex size-10 shrink-0 items-center justify-center rounded-sm">
        <ClaudeIcon className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-lg font-semibold">{agent.name}</p>
        <p
          className={cn(
            "flex items-center gap-1.5 text-sm",
            signedIn ? "text-confirmed" : "text-contradiction"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              signedIn ? "bg-confirmed" : "bg-contradiction"
            )}
          />
          {signedIn
            ? agent.status
            : "Найден, но вход не выполнен: звонок пройдёт без вопросов"}
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

/**
 * "Агент": the CLI and its subscription, how questions are suggested.
 * `limitLow`: less than one call left, the bar and the caption turn red.
 */
export function AgentSettings({
  agent = AGENT,
  checking = false,
  limitLow = false,
  onChange,
  onChangePath,
  onCheck,
  onSignIn,
  onSignOut,
  signingIn = false,
  values = DEFAULT_SETTINGS,
}: {
  agent?: typeof AGENT;
  /** "Проверить снова" is running. */
  checking?: boolean;
  limitLow?: boolean;
  onChange?: SettingChange;
  onChangePath?: () => void;
  onCheck?: () => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  signingIn?: boolean;
  values?: SettingsValues;
}) {
  const signedIn = values.agentSignedIn;
  return (
    <>
      <section aria-label="Claude Code" className="flex flex-col pt-4">
        <AgentSummary
          agent={agent}
          checking={checking}
          onCheck={onCheck}
          signedIn={signedIn}
        />
        <dl className="flex flex-col">
          <AgentFact
            label="Путь"
            trailing={
              <FactAction onClick={onChangePath}>Указать другой</FactAction>
            }
          >
            <span className="font-mono text-sm">{values.agentPath}</span>
          </AgentFact>
          <AgentFact
            label="Версия"
            trailing={
              <span className="text-muted-foreground text-sm">
                {agent.versionNote}
              </span>
            }
          >
            <span className="font-mono text-sm">{agent.version}</span>
          </AgentFact>
          <AgentFact
            label="Вход"
            trailing={
              signedIn ? (
                <FactAction onClick={onSignOut}>Выйти</FactAction>
              ) : (
                <FactAction disabled={signingIn} onClick={onSignIn}>
                  {signingIn ? (
                    <Spinner aria-hidden="true" className="size-3.5" />
                  ) : null}
                  Войти
                </FactAction>
              )
            }
          >
            {signedIn ? (
              agent.account
            ) : (
              <span className="text-muted-foreground">Не выполнен</span>
            )}
          </AgentFact>
          <AgentFact className="items-start" label="Лимит подписки">
            <Progress
              className={cn(
                "[&_[data-slot=progress-track]]:bg-border gap-y-2",
                limitLow
                  ? "[&_[data-slot=progress-indicator]]:bg-contradiction"
                  : "[&_[data-slot=progress-indicator]]:bg-foreground"
              )}
              locale="ru-RU"
              size="sm"
              tone="active"
              value={agent.limitUsed}
            >
              <ProgressLabel className="font-normal">
                {agent.limitLabel}
              </ProgressLabel>
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                {agent.limitReset}
              </span>
            </Progress>
            <p
              className={cn(
                "mt-2 text-sm",
                limitLow ? "text-contradiction" : "text-muted-foreground"
              )}
            >
              {agent.limitCaption}
            </p>
          </AgentFact>
        </dl>
      </section>
      <SettingsSection className="pt-8" title="Вопросы во время звонка">
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
        <SettingsRow
          control={
            <SettingsSegments
              defaultValue={values.finalCheck}
              label="Финальная проверка"
              onSettingChange={onChange}
              options={FINAL_CHECK}
              setting="finalCheck"
            />
          }
          description="За сколько до конца собрать главные незакрытые вопросы"
          title="Финальная проверка"
        />
      </SettingsSection>
    </>
  );
}

export function AgentSettingsScreen({ className }: { className?: string }) {
  return (
    <SettingsScreen className={className} section="agent">
      <AgentSettings />
    </SettingsScreen>
  );
}
