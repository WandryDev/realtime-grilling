import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AgentCard,
  AgentCardHeader,
  AgentCardSection,
  AgentCheck,
  AgentCheckList,
  AgentCheckMarkIcon,
  AgentCheckMeta,
  AgentErrorLog,
  AgentStatusBadge,
  AgentStepNumber,
} from "../components/agent-card";
import { ExternalArrowIcon, InfoIcon, SwapIcon } from "../components/icons";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "../components/onboarding-window";
import { StepHeading } from "../components/step-heading";
import { StepBackButton, StepNextButton } from "../components/step-links";
import { StepNote } from "../components/step-note";
import { type AgentInfo, CLAUDE_CODE } from "../mock";

/*
 * 04 Агент.
 * - checking: looking for Claude Code, its login and subscription
 * - ready: found, logged in, subscription active
 * - needs-login: installed, "Войти" opens the browser
 * - not-installed: the install plan and "Установить"
 * - installing: steps 1–3 with progress
 * - install-error: what failed, the log, "Повторить"
 *
 * The app passes `handlers`; `loginPending` spins "Войти" while the browser
 * login is open.
 */
export type AgentState =
  | "checking"
  | "ready"
  | "needs-login"
  | "not-installed"
  | "installing"
  | "install-error";

export interface AgentHandlers {
  onCopyLog?: () => void;
  onInstall?: () => void;
  onLogin?: () => void;
  onRecheck?: () => void;
  onRetry?: () => void;
}

function VersionMeta({ agent }: { agent: AgentInfo }) {
  return <AgentCheckMeta mono>версия {agent.version}</AgentCheckMeta>;
}

function AgentChecks({
  agent,
  handlers,
  loginPending,
  state,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
  loginPending: boolean;
  state: "checking" | "ready" | "needs-login";
}) {
  if (state === "checking") {
    return (
      <AgentCheckList>
        <AgentCheck
          mark={<AgentCheckMarkIcon mark="done" />}
          trailing={<VersionMeta agent={agent} />}
        >
          Нашли на компьютере
        </AgentCheck>
        <AgentCheck mark={<AgentCheckMarkIcon mark="progress" />}>
          Проверяем вход в аккаунт
        </AgentCheck>
        <AgentCheck
          emphasis="muted"
          mark={<AgentCheckMarkIcon mark="pending" />}
        >
          Подписка
        </AgentCheck>
      </AgentCheckList>
    );
  }
  if (state === "needs-login") {
    return (
      <AgentCheckList>
        <AgentCheck
          mark={<AgentCheckMarkIcon mark="done" />}
          trailing={<VersionMeta agent={agent} />}
        >
          Установлен на компьютере
        </AgentCheck>
        <AgentCheck
          mark={<AgentCheckMarkIcon mark="attention" />}
          trailing={
            <Button
              className="gap-1.5"
              loading={loginPending}
              onClick={handlers.onLogin}
            >
              Войти
              <ExternalArrowIcon className="size-3" />
            </Button>
          }
        >
          Вход не выполнен
        </AgentCheck>
        <AgentCheck
          emphasis="muted"
          mark={<AgentCheckMarkIcon mark="pending" />}
          trailing={<AgentCheckMeta>проверим после входа</AgentCheckMeta>}
        >
          Подписка
        </AgentCheck>
      </AgentCheckList>
    );
  }
  return (
    <AgentCheckList>
      <AgentCheck
        mark={<AgentCheckMarkIcon mark="done" />}
        trailing={<VersionMeta agent={agent} />}
      >
        Установлен на компьютере
      </AgentCheck>
      <AgentCheck
        mark={<AgentCheckMarkIcon mark="done" />}
        trailing={<AgentCheckMeta>{agent.account}</AgentCheckMeta>}
      >
        Вход выполнен
      </AgentCheck>
      <AgentCheck
        mark={<AgentCheckMarkIcon mark="done" />}
        trailing={<AgentCheckMeta>{agent.plan}</AgentCheckMeta>}
      >
        Подписка активна
      </AgentCheck>
    </AgentCheckList>
  );
}

function InstallPlan({
  agent,
  handlers,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
}) {
  return (
    <AgentCardSection className="gap-1 pt-3.5 pb-4">
      <p className="text-muted-foreground pb-1.5 text-sm">
        Не нашли Claude Code на компьютере. Установим сами, за минуту:
      </p>
      <AgentCheckList className="gap-1">
        <AgentCheck
          className="py-1.5"
          mark={<AgentStepNumber value={1} />}
          trailing={
            <AgentCheckMeta className="text-xs tabular-nums">
              {agent.downloadSize}
            </AgentCheckMeta>
          }
        >
          Скачаем Claude Code с сайта Anthropic
        </AgentCheck>
        <AgentCheck className="py-1.5" mark={<AgentStepNumber value={2} />}>
          Установим, пароль от компьютера не нужен
        </AgentCheck>
        <AgentCheck className="py-1.5" mark={<AgentStepNumber value={3} />}>
          Попросим войти в аккаунт Claude
        </AgentCheck>
      </AgentCheckList>
      <div className="flex items-center gap-3 pt-3">
        <Button className="h-9 px-[18px]" onClick={handlers.onInstall}>
          Установить
        </Button>
        <Button
          className="-mx-2.5"
          onClick={handlers.onRecheck}
          size="sm"
          variant="ghost"
        >
          Уже установлен? Проверить снова
        </Button>
      </div>
    </AgentCardSection>
  );
}

function InstallProgress({ agent }: { agent: AgentInfo }) {
  return (
    <AgentCardSection className="gap-1 pt-3.5 pb-4">
      <AgentCheckList className="gap-1">
        <AgentCheck
          className="py-1.5"
          emphasis="muted"
          mark={<AgentCheckMarkIcon mark="done" />}
          trailing={
            <AgentCheckMeta mono>{agent.downloadedSize}</AgentCheckMeta>
          }
        >
          Скачали Claude Code
        </AgentCheck>
        <li className="flex items-start gap-3 py-1.5">
          <AgentCheckMarkIcon mark="progress" />
          <Progress
            aria-label="Устанавливаем"
            className="[&_[data-slot=progress-track]]:bg-border min-w-0 flex-1 gap-y-2"
            locale="ru-RU"
            size="sm"
            tone="active"
            value={agent.installPercent}
          >
            <span className="flex w-full items-center justify-between gap-3">
              <span className="text-base font-medium">Устанавливаем</span>
              <span className="text-muted-foreground font-mono text-xs">
                {agent.installPercent}%
              </span>
            </span>
          </Progress>
        </li>
        <AgentCheck
          className="py-1.5"
          emphasis="muted"
          mark={<AgentCheckMarkIcon mark="pending" />}
        >
          Вход в аккаунт Claude
        </AgentCheck>
      </AgentCheckList>
      <p className="text-muted-foreground pt-2.5 text-sm">
        Не закрывайте окно, осталось меньше минуты
      </p>
    </AgentCardSection>
  );
}

function InstallError({
  agent,
  handlers,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
}) {
  return (
    <AgentCardSection className="gap-3 py-4">
      <div className="flex items-start gap-3">
        <AgentCheckMarkIcon mark="failed" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-base font-semibold">
            Не получилось скачать Claude Code
          </h3>
          <p className="text-muted-foreground text-sm">
            Сайт Anthropic не ответил. Чаще всего мешает VPN или рабочий
            файрвол, попробуйте отключить VPN.
          </p>
        </div>
      </div>
      <AgentErrorLog className="ml-8" lines={agent.errorLog} />
      <div className="flex gap-2 pl-8">
        <Button className="h-9 px-4" onClick={handlers.onRetry}>
          Повторить
        </Button>
        <Button
          className="h-9 px-4"
          onClick={handlers.onCopyLog}
          variant="secondary"
        >
          Скопировать для поддержки
        </Button>
      </div>
    </AgentCardSection>
  );
}

const STATUS: Record<AgentState, ReactNode> = {
  checking: (
    <AgentStatusBadge dot={false} tone="neutral">
      Проверяем
    </AgentStatusBadge>
  ),
  "install-error": (
    <AgentStatusBadge tone="error">Не установлен</AgentStatusBadge>
  ),
  installing: (
    <AgentStatusBadge
      className="font-mono text-xs font-normal"
      dot={false}
      tone="neutral"
    >
      2 из 3
    </AgentStatusBadge>
  ),
  "needs-login": (
    <AgentStatusBadge tone="attention">Нужен вход</AgentStatusBadge>
  ),
  "not-installed": (
    <AgentStatusBadge tone="neutral">Не установлен</AgentStatusBadge>
  ),
  ready: <AgentStatusBadge tone="confirmed">Готов к работе</AgentStatusBadge>,
};

function AgentCardBody({
  agent,
  handlers,
  loginPending,
  state,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
  loginPending: boolean;
  state: AgentState;
}) {
  switch (state) {
    case "not-installed":
      return <InstallPlan agent={agent} handlers={handlers} />;
    case "installing":
      return <InstallProgress agent={agent} />;
    case "install-error":
      return <InstallError agent={agent} handlers={handlers} />;
    default:
      return (
        <AgentCardSection>
          <AgentChecks
            agent={agent}
            handlers={handlers}
            loginPending={loginPending}
            state={state}
          />
        </AgentCardSection>
      );
  }
}

const NO_HANDLERS: AgentHandlers = {};

export function AgentScreen({
  agent = CLAUDE_CODE,
  backHref,
  className,
  handlers = NO_HANDLERS,
  loginPending = false,
  nextHref,
  state = "checking",
}: {
  agent?: AgentInfo;
  backHref?: string;
  className?: string;
  handlers?: AgentHandlers;
  /** "Войти" opened the browser, waiting for the login. */
  loginPending?: boolean;
  nextHref?: string;
  state?: AgentState;
}) {
  return (
    <OnboardingWindow className={className} step="agent">
      <OnboardingContent className="gap-7">
        <StepHeading
          description="Grill думает с помощью Claude Code, приложения Anthropic на вашем компьютере. Проверим, что всё на месте."
          title="Агент, который придумывает вопросы"
        />
        <AgentCard aria-label={agent.name}>
          <AgentCardHeader
            description={
              state === "installing" ? "Устанавливаем агента" : agent.vendor
            }
            name={agent.name}
            status={STATUS[state]}
          />
          <AgentCardBody
            agent={agent}
            handlers={handlers}
            loginPending={loginPending}
            state={state}
          />
        </AgentCard>
        {state === "needs-login" ? (
          <StepNote icon={<InfoIcon strokeWidth={1.3} />}>
            Откроется браузер. Войдите в Claude и вернитесь, Grill заметит сам
          </StepNote>
        ) : (
          <StepNote icon={<SwapIcon />} iconTone="subtle">
            Агента можно поменять позже в настройках
          </StepNote>
        )}
      </OnboardingContent>
      <OnboardingFooter
        end={<StepNextButton disabled={state !== "ready"} href={nextHref} />}
        start={<StepBackButton href={backHref} />}
      />
    </OnboardingWindow>
  );
}
