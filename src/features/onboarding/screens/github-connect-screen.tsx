import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { InfoIcon } from "@/features/onboarding/components/icons";
import {
  OnboardingBackButton,
  OnboardingNextButton,
} from "@/features/onboarding/components/onboarding-actions";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "@/features/onboarding/components/onboarding-window";
import { ConnectedCard } from "@/features/onboarding/integrations/connected-card";
import {
  DeviceCodeCard,
  type DeviceCodeStatus,
  DeviceCodeTimer,
} from "@/features/onboarding/integrations/device-code";
import { Hint } from "@/features/onboarding/integrations/hint";
import {
  GITHUB_ACCOUNT,
  GITHUB_DEVICE,
} from "@/features/onboarding/integrations/mock";
import { PendingStatus } from "@/features/onboarding/integrations/pending-status";
import { BrowserButton } from "@/features/onboarding/integrations/step-actions";
import { ServiceStepHeading } from "@/features/onboarding/integrations/step-heading";
import { linkButtonProps } from "@/lib/link-button";

/*
 * Paper "05a GitHub", sign-in with a device code. The code is copied to the
 * clipboard as soon as the step opens.
 * - code: the code, "Скопировано", three steps, "Открыть github.com/login/device"
 * - waiting: the browser tab is open, Grill polls GitHub
 * - connected: account, repositories it can read, "Готово"
 * - expired: 15 minutes passed or Cancel on GitHub, "Получить новый код"
 * The app passes the handlers and the hrefs of "Назад" and "Готово".
 */
export type GitHubConnectState = "code" | "waiting" | "connected" | "expired";

const GITHUB_STEPS = [
  "Откройте страницу GitHub кнопкой ниже",
  "Вставьте код и нажмите Continue",
  "Нажмите Authorize и вернитесь сюда",
];

// The code is copied on open; while waiting the pill offers to copy again
const CODE_STATUS = {
  code: "copied",
  expired: "expired",
  waiting: "idle",
} as const satisfies Record<
  Exclude<GitHubConnectState, "connected">,
  DeviceCodeStatus
>;

const DESCRIPTION: Record<GitHubConnectState, string> = {
  code: "GitHub попросит ввести этот код. Пароль вводить не нужно, доступ только на чтение.",
  connected:
    "Если на звонке всплывёт что-то техническое, Grill заглянет в код и подскажет.",
  expired:
    "Код действует 15 минут, и этот уже не подойдёт. Получите новый, это пара секунд.",
  waiting:
    "Вкладка GitHub открыта в браузере. Вставьте там код и подтвердите доступ.",
};

export interface GitHubConnectActions {
  backHref?: string;
  doneHref?: string;
  /** "Скопировать" on the code. */
  onCopy?: () => void;
  /** "Получить новый код". */
  onNewCode?: () => void;
  /** "Открыть github.com/login/device" and "Открыть страницу ещё раз". */
  onOpenBrowser?: () => void;
}

export function GitHubConnectScreen({
  account = GITHUB_ACCOUNT,
  backHref,
  className,
  device = GITHUB_DEVICE,
  doneHref,
  onCopy,
  onNewCode,
  onOpenBrowser,
  state = "code",
}: GitHubConnectActions & {
  account?: typeof GITHUB_ACCOUNT;
  className?: string;
  device?: typeof GITHUB_DEVICE;
  state?: GitHubConnectState;
}) {
  return (
    <OnboardingWindow className={className} step="integrations">
      <OnboardingContent className="gap-7">
        <ServiceStepHeading
          description={DESCRIPTION[state]}
          service="github"
          title={
            state === "connected" ? "GitHub подключён" : "Подключение GitHub"
          }
        />
        {state === "connected" ? (
          <ConnectedCard
            chips={account.repositories}
            chipsMono
            description={account.summary}
            media={
              <Avatar aria-hidden="true" size="lg">
                <AvatarFallback className="bg-surface">
                  {account.initial}
                </AvatarFallback>
              </Avatar>
            }
            moreCount={account.moreCount}
            title={account.login}
            titleMono
          />
        ) : (
          <GitHubCodeBody device={device} onCopy={onCopy} state={state} />
        )}
      </OnboardingContent>
      <OnboardingFooter
        end={
          <GitHubFooterAction
            doneHref={doneHref}
            onNewCode={onNewCode}
            onOpenBrowser={onOpenBrowser}
            state={state}
            url={device.verificationUrl}
          />
        }
        start={<OnboardingBackButton {...linkButtonProps(backHref)} />}
      />
    </OnboardingWindow>
  );
}

function GitHubCodeBody({
  device,
  onCopy,
  state,
}: {
  device: typeof GITHUB_DEVICE;
  onCopy?: () => void;
  state: Exclude<GitHubConnectState, "connected">;
}) {
  const CARD: Record<typeof state, { caption: string; timer: ReactNode }> = {
    code: {
      caption: "Код уже скопирован, осталось вставить",
      timer: <DeviceCodeTimer remaining={device.remainingAtStart} />,
    },
    expired: { caption: "Код истёк", timer: "прошло 15 минут" },
    waiting: {
      caption: "Скопировано",
      timer: <DeviceCodeTimer remaining={device.remainingWhileWaiting} />,
    },
  };

  return (
    <>
      <DeviceCodeCard
        caption={CARD[state].caption}
        code={device.code}
        onCopy={onCopy}
        status={CODE_STATUS[state]}
        timer={CARD[state].timer}
      />
      {state === "code" ? <GitHubSteps /> : null}
      {state === "waiting" ? (
        <PendingStatus
          description="Как только нажмёте Authorize, Grill продолжит сам"
          title="Ждём подтверждения на github.com"
        />
      ) : null}
      {state === "expired" ? (
        <Hint icon={<InfoIcon strokeWidth={1.3} />}>
          Если на GitHub вы нажали Cancel или вошли не в тот аккаунт, тоже
          просто получите новый код.
        </Hint>
      ) : null}
    </>
  );
}

function GitHubSteps() {
  return (
    <ol aria-label="Как подключить" className="flex gap-6">
      {GITHUB_STEPS.map((step, index) => (
        <li className="flex flex-1 gap-2" key={step}>
          <span
            aria-hidden="true"
            className="text-muted-foreground text-xs/4.5 tabular-nums"
          >
            {index + 1}
          </span>
          <span className="text-sm">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function GitHubFooterAction({
  doneHref,
  onNewCode,
  onOpenBrowser,
  state,
  url,
}: Pick<GitHubConnectActions, "doneHref" | "onNewCode" | "onOpenBrowser"> & {
  state: GitHubConnectState;
  url: string;
}) {
  switch (state) {
    case "waiting":
      return (
        <BrowserButton onClick={onOpenBrowser} variant="secondary">
          Открыть страницу ещё раз
        </BrowserButton>
      );
    case "connected":
      return (
        <OnboardingNextButton {...linkButtonProps(doneHref)}>
          Готово
        </OnboardingNextButton>
      );
    case "expired":
      return (
        <OnboardingNextButton onClick={onNewCode}>
          Получить новый код
        </OnboardingNextButton>
      );
    default:
      return (
        <BrowserButton onClick={onOpenBrowser}>Открыть {url}</BrowserButton>
      );
  }
}
