import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CrossIcon } from "@/features/onboarding/components/icons";
import {
  OnboardingBackButton,
  OnboardingNextButton,
} from "@/features/onboarding/components/onboarding-actions";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "@/features/onboarding/components/onboarding-window";
import { CapabilityList } from "@/features/onboarding/integrations/capability-list";
import { ConnectedCard } from "@/features/onboarding/integrations/connected-card";
import {
  CLICKUP_CAPABILITIES,
  CLICKUP_WORKSPACE,
} from "@/features/onboarding/integrations/mock";
import { BrowserButton } from "@/features/onboarding/integrations/step-actions";
import { ServiceStepHeading } from "@/features/onboarding/integrations/step-heading";
import { linkButtonProps } from "@/lib/link-button";

/*
 * Paper "05c ClickUp", OAuth in the default browser.
 * - intro: what Grill may do, "Продолжить в браузере"
 * - waiting: the tab is open, the answer comes to a local address
 * - connected: the workspace and the people Grill will recognize
 * - error: cancelled, closed tab or 10 minutes of silence, with the code
 * The app passes the handlers and the hrefs of "Назад" and "Готово".
 */
export type ClickUpConnectState = "intro" | "waiting" | "connected" | "error";

const HEADING: Record<
  ClickUpConnectState,
  { description: string; title: string }
> = {
  connected: {
    description:
      "Grill увидит задачи и подскажет, если разработчик или дизайнер ждёт ответа от клиента.",
    title: "ClickUp подключён",
  },
  error: {
    description:
      "Вход в браузере отменили или закрыли вкладку раньше времени. Ничего страшного, попробуйте ещё раз.",
    title: "ClickUp не подключился",
  },
  intro: {
    description:
      "Откроем ClickUp в браузере. Войдите и выберите рабочее пространство агентства.",
    title: "Подключение ClickUp",
  },
  waiting: {
    description:
      "Вкладка ClickUp открыта в браузере. Войдите, выберите пространство и нажмите Connect Workspace.",
    title: "Подключение ClickUp",
  },
};

export interface ClickUpConnectActions {
  backHref?: string;
  doneHref?: string;
  /** "Отменить" while waiting for the browser. */
  onCancel?: () => void;
  /** "Открыть вкладку ещё раз". */
  onOpenBrowser?: () => void;
  /** "Продолжить в браузере" and "Попробовать снова". */
  onStart?: () => void;
}

export function ClickUpConnectScreen({
  backHref,
  className,
  doneHref,
  onCancel,
  onOpenBrowser,
  onStart,
  state = "intro",
  workspace = CLICKUP_WORKSPACE,
}: ClickUpConnectActions & {
  className?: string;
  state?: ClickUpConnectState;
  workspace?: typeof CLICKUP_WORKSPACE;
}) {
  return (
    <OnboardingWindow className={className} step="integrations">
      <OnboardingContent className="gap-6">
        <ServiceStepHeading
          description={HEADING[state].description}
          service="clickup"
          title={HEADING[state].title}
        />
        <ClickUpBody onCancel={onCancel} state={state} workspace={workspace} />
      </OnboardingContent>
      <OnboardingFooter
        end={
          <ClickUpFooterAction
            doneHref={doneHref}
            onOpenBrowser={onOpenBrowser}
            onStart={onStart}
            state={state}
          />
        }
        start={<OnboardingBackButton {...linkButtonProps(backHref)} />}
      />
    </OnboardingWindow>
  );
}

function ClickUpBody({
  onCancel,
  state,
  workspace,
}: {
  onCancel?: () => void;
  state: ClickUpConnectState;
  workspace: typeof CLICKUP_WORKSPACE;
}) {
  switch (state) {
    case "waiting":
      return (
        <Alert className="*:[svg]:text-foreground gap-x-3.5 gap-y-0.5 px-5 py-4.5">
          <Spinner
            aria-hidden="true"
            aria-label={undefined}
            className="size-5.5"
            role="presentation"
          />
          <AlertTitle>Ждём ответа от ClickUp</AlertTitle>
          <AlertDescription>
            Это окно трогать не нужно, Grill продолжит сам
          </AlertDescription>
          <AlertAction>
            <Button onClick={onCancel} variant="secondary">
              Отменить
            </Button>
          </AlertAction>
        </Alert>
      );
    case "connected":
      return (
        <ConnectedCard
          chips={workspace.people}
          description={workspace.summary}
          meta={workspace.listsCount}
          moreCount={workspace.moreCount}
          title={workspace.name}
        />
      );
    case "error":
      return (
        <Alert
          className="items-start gap-y-0.5 py-4 pr-4.5"
          variant="destructive"
        >
          {/* 14px mark centered in a 20px lane, like the title row */}
          <CrossIcon className="mx-[3px] mt-[3px] size-3.5" strokeWidth={1.6} />
          <AlertTitle className="text-foreground font-semibold">
            Доступ не выдан
          </AlertTitle>
          <AlertDescription>
            <p>
              Если пространство агентства не видно в списке, попросите
              администратора ClickUp добавить вас в него.
            </p>
            <p className="text-contradiction mt-1 font-mono text-xs">
              {workspace.errorCode}
            </p>
          </AlertDescription>
        </Alert>
      );
    default:
      return <CapabilityList items={CLICKUP_CAPABILITIES} />;
  }
}

function ClickUpFooterAction({
  doneHref,
  onOpenBrowser,
  onStart,
  state,
}: Pick<ClickUpConnectActions, "doneHref" | "onOpenBrowser" | "onStart"> & {
  state: ClickUpConnectState;
}) {
  switch (state) {
    case "waiting":
      return (
        <BrowserButton onClick={onOpenBrowser} variant="secondary">
          Открыть вкладку ещё раз
        </BrowserButton>
      );
    case "connected":
      return (
        <OnboardingNextButton {...linkButtonProps(doneHref)}>
          Готово
        </OnboardingNextButton>
      );
    case "error":
      return (
        <OnboardingNextButton onClick={onStart}>
          Попробовать снова
        </OnboardingNextButton>
      );
    default:
      return (
        <BrowserButton onClick={onStart}>Продолжить в браузере</BrowserButton>
      );
  }
}
