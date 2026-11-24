import { Button } from "@grill/ui/button";
import { Progress } from "@grill/ui/progress";
import type { ReactNode } from "react";
import {
  AgentCard,
  AgentCardHeader,
  AgentCardSection,
  AgentCheck,
  AgentCheckDetails,
  AgentCheckList,
  AgentCheckMarkIcon,
  AgentCheckMeta,
  AgentErrorLog,
  AgentStatusBadge,
  AgentStepNumber,
} from "../components/agent-card";
import { AgentLoginForm } from "../components/agent-login-form";
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
 * - awaiting-code: the browser login runs, "Код из браузера" takes the code
 *   the page shows; `loginError` when the CLI didn't take it
 * - not-installed: the install plan and "Установить"
 * - installing: steps 1–3 with progress
 * - install-error: what failed, the log, "Повторить"
 * - error: the check or the login start failed, "Проверить снова"
 *
 * The app passes `handlers`; `loginPending` spins "Войти" while the browser
 * login starts, `loginSubmitting` spins "Подтвердить".
 */
export type AgentState =
  | "checking"
  | "ready"
  | "needs-login"
  | "awaiting-code"
  | "not-installed"
  | "installing"
  | "install-error"
  | "error";

export interface AgentHandlers {
  /** "Отменить" under the install progress. */
  onCancelInstall?: () => void;
  /** "Отменить" in the login. */
  onCancelLogin?: () => void;
  onCopyLog?: () => void;
  onInstall?: () => void;
  /** "Войти", also "Войти ещё раз" after a rejected code. */
  onLogin?: () => void;
  onRecheck?: () => void;
  /** "Открыть страницу ещё раз". */
  onReopenLogin?: () => void;
  onRetry?: () => void;
  /** "Подтвердить" with the code from the browser. */
  onSubmitCode?: (code: string) => void;
}

/** What failed: a title, one line for people, the log for support. */
export interface AgentFailure {
  log?: readonly string[];
  summary?: string;
  title?: string;
}

/** Where the browser login is. */
interface AgentLogin {
  /** The CLI didn't take the code. */
  error?: string;
  /** "Войти" is starting the login. */
  pending: boolean;
  /** "Подтвердить" is passing the code. */
  submitting: boolean;
}

function VersionMeta({ agent }: { agent: AgentInfo }) {
  return <AgentCheckMeta mono>версия {agent.version}</AgentCheckMeta>;
}

function AgentChecks({
  agent,
  handlers,
  login,
  state,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
  login: AgentLogin;
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
              loading={login.pending}
              onClick={handlers.onLogin}
            >
              Войти
              <ExternalArrowIcon className="size-3" />
            </Button>
          }
        >
          Вход не выполнен
        </AgentCheck>
        {login.error ? (
          <li
            className="text-destructive -mt-1.5 pb-1 pl-8 text-sm"
            role="alert"
          >
            {login.error}
          </li>
        ) : null}
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
        trailing={
          agent.account ? (
            <AgentCheckMeta>{agent.account}</AgentCheckMeta>
          ) : null
        }
      >
        Вход выполнен
      </AgentCheck>
      <AgentCheck
        mark={<AgentCheckMarkIcon mark="done" />}
        trailing={
          agent.plan ? <AgentCheckMeta>{agent.plan}</AgentCheckMeta> : null
        }
      >
        Подписка активна
      </AgentCheck>
    </AgentCheckList>
  );
}

/** The login started: the code from the browser, between the checks. */
function LoginChecks({
  agent,
  handlers,
  login,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
  login: AgentLogin;
}) {
  return (
    <AgentCheckList>
      <AgentCheck
        mark={<AgentCheckMarkIcon mark="done" />}
        trailing={<VersionMeta agent={agent} />}
      >
        Установлен на компьютере
      </AgentCheck>
      <AgentCheckDetails
        label="Вход в аккаунт Claude"
        mark={<AgentCheckMarkIcon mark="attention" />}
      >
        <AgentLoginForm
          className="pb-2"
          error={login.error}
          onCancel={handlers.onCancelLogin}
          onRelogin={handlers.onLogin}
          onReopen={handlers.onReopenLogin}
          onSubmit={handlers.onSubmitCode}
          relogging={login.pending}
          submitting={login.submitting}
        />
      </AgentCheckDetails>
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

function InstallPlan({
  agent,
  handlers,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
}) {
  return (
    <AgentCardSection className="gap-1 pt-5 pb-4">
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

function InstallProgress({
  agent,
  handlers,
}: {
  agent: AgentInfo;
  handlers: AgentHandlers;
}) {
  return (
    <AgentCardSection className="gap-1 pt-5 pb-4">
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
      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-muted-foreground text-sm">
          Не закрывайте окно, осталось меньше минуты
        </p>
        <Button
          className="-mr-2.5"
          onClick={handlers.onCancelInstall}
          size="sm"
          variant="ghost"
        >
          Отменить
        </Button>
      </div>
    </AgentCardSection>
  );
}

/** The Paper frame of a failed install: the site didn't answer. */
const DOWNLOAD_FAILED = {
  summary:
    "Сайт Anthropic не ответил. Чаще всего мешает VPN или рабочий файрвол, попробуйте отключить VPN.",
  title: "Не получилось скачать Claude Code",
};

/** What failed, the technical log, the next step and the support copy. */
function AgentFailureSection({
  action,
  failure,
  onCopyLog,
}: {
  action: ReactNode;
  failure: Required<AgentFailure>;
  onCopyLog?: () => void;
}) {
  return (
    <AgentCardSection className="gap-3 pt-5 pb-4">
      <div className="flex items-start gap-3">
        <AgentCheckMarkIcon mark="failed" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-base font-semibold">{failure.title}</h3>
          <p className="text-muted-foreground text-sm">{failure.summary}</p>
        </div>
      </div>
      {failure.log.length > 0 ? (
        <AgentErrorLog className="ml-8" lines={failure.log} />
      ) : null}
      <div className="flex gap-2 pl-8">
        {action}
        <Button className="h-9 px-4" onClick={onCopyLog} variant="secondary">
          Скопировать для поддержки
        </Button>
      </div>
    </AgentCardSection>
  );
}

function InstallError({
  agent,
  failure,
  handlers,
}: {
  agent: AgentInfo;
  failure?: AgentFailure;
  handlers: AgentHandlers;
}) {
  return (
    <AgentFailureSection
      action={
        <Button className="h-9 px-4" onClick={handlers.onRetry}>
          Повторить
        </Button>
      }
      failure={{
        log: failure?.log ?? agent.errorLog,
        summary: failure?.summary ?? DOWNLOAD_FAILED.summary,
        title: failure?.title ?? DOWNLOAD_FAILED.title,
      }}
      onCopyLog={handlers.onCopyLog}
    />
  );
}

/** The check or the login start failed: "Claude Code не отвечает". */
function AgentError({
  failure,
  handlers,
}: {
  failure?: AgentFailure;
  handlers: AgentHandlers;
}) {
  return (
    <AgentFailureSection
      action={
        <Button className="h-9 px-4" onClick={handlers.onRecheck}>
          Проверить снова
        </Button>
      }
      failure={{
        log: failure?.log ?? [],
        summary: failure?.summary ?? "Claude Code не отвечает",
        title: failure?.title ?? "Не получилось проверить Claude Code",
      }}
      onCopyLog={handlers.onCopyLog}
    />
  );
}

const STATUS: Record<AgentState, ReactNode> = {
  "awaiting-code": (
    <AgentStatusBadge tone="attention">Ждём код</AgentStatusBadge>
  ),
  checking: (
    <AgentStatusBadge dot={false} tone="neutral">
      Проверяем
    </AgentStatusBadge>
  ),
  error: <AgentStatusBadge tone="error">Не отвечает</AgentStatusBadge>,
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
  // The «Вход не выполнен» row says it already.
  "needs-login": null,
  "not-installed": (
    <AgentStatusBadge tone="neutral">Не установлен</AgentStatusBadge>
  ),
  ready: <AgentStatusBadge tone="confirmed">Готов к работе</AgentStatusBadge>,
};

function AgentCardBody({
  agent,
  failure,
  handlers,
  login,
  state,
}: {
  agent: AgentInfo;
  failure?: AgentFailure;
  handlers: AgentHandlers;
  login: AgentLogin;
  state: AgentState;
}) {
  switch (state) {
    case "awaiting-code":
      return (
        <AgentCardSection>
          <LoginChecks agent={agent} handlers={handlers} login={login} />
        </AgentCardSection>
      );
    case "not-installed":
      return <InstallPlan agent={agent} handlers={handlers} />;
    case "installing":
      return <InstallProgress agent={agent} handlers={handlers} />;
    case "install-error":
      return (
        <InstallError agent={agent} failure={failure} handlers={handlers} />
      );
    case "error":
      return <AgentError failure={failure} handlers={handlers} />;
    default:
      return (
        <AgentCardSection>
          <AgentChecks
            agent={agent}
            handlers={handlers}
            login={login}
            state={state}
          />
        </AgentCardSection>
      );
  }
}

/** The line under the card. */
function AgentNote({ state }: { state: AgentState }) {
  switch (state) {
    case "needs-login":
      return (
        <StepNote icon={<InfoIcon strokeWidth={1.3} />}>
          Откроется браузер. Войдите в Claude и скопируйте код со страницы
        </StepNote>
      );
    case "awaiting-code":
      return (
        <StepNote icon={<InfoIcon strokeWidth={1.3} />}>
          Войдите в Claude в открывшемся браузере и скопируйте код со страницы
        </StepNote>
      );
    default:
      return (
        <StepNote icon={<SwapIcon />} iconTone="subtle">
          Агента можно поменять позже в настройках
        </StepNote>
      );
  }
}

const NO_HANDLERS: AgentHandlers = {};

export function AgentScreen({
  agent = CLAUDE_CODE,
  backHref,
  className,
  failure,
  handlers = NO_HANDLERS,
  loginError,
  loginPending = false,
  loginSubmitting = false,
  nextHref,
  state = "checking",
}: {
  agent?: AgentInfo;
  backHref?: string;
  className?: string;
  /** install-error / error: what failed, instead of the Paper texts. */
  failure?: AgentFailure;
  handlers?: AgentHandlers;
  /**
   * awaiting-code: under the code field (the CLI didn't take the code);
   * needs-login: next to "Войти" (the login expired).
   */
  loginError?: string;
  /** "Войти" is starting the browser login. */
  loginPending?: boolean;
  /** "Подтвердить" is passing the code to the CLI. */
  loginSubmitting?: boolean;
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
            failure={failure}
            handlers={handlers}
            login={{
              error: loginError,
              pending: loginPending,
              submitting: loginSubmitting,
            }}
            state={state}
          />
        </AgentCard>
        <AgentNote state={state} />
      </OnboardingContent>
      <OnboardingFooter
        end={<StepNextButton disabled={state !== "ready"} href={nextHref} />}
        start={<StepBackButton href={backHref} />}
      />
    </OnboardingWindow>
  );
}
