"use client";

import { Button } from "@grill/ui/button";
import { useId } from "react";
import {
  type ClickUpConnectState as ClickUpConnectForm,
  ClickUpTokenFields,
} from "@/features/connectors/clickup-connect";
import { OnboardingBackButton } from "@/features/onboarding/components/onboarding-actions";
import {
  OnboardingContent,
  OnboardingFooter,
  OnboardingWindow,
} from "@/features/onboarding/components/onboarding-window";
import { ConnectedCard } from "@/features/onboarding/integrations/connected-card";
import { Hint } from "@/features/onboarding/integrations/hint";
import { HelpIcon } from "@/features/onboarding/integrations/icons";
import {
  CLICKUP_CONNECTION,
  CLICKUP_TOKENS,
  CLICKUP_WORKSPACES,
} from "@/features/onboarding/integrations/mock";
import { ServiceStepHeading } from "@/features/onboarding/integrations/step-heading";
import { linkButtonProps } from "@/lib/link-button";
import { cn } from "@/lib/utils";

/*
 * Step 05c, ClickUp by a personal token (clickup-connector spec, «Вход по
 * личному токену», «Выбор рабочего пространства»).
 * - form: the token field has focus, «Открыть страницу токена» leads to
 *   ClickUp's Settings → Apps
 * - checking: one check with ClickUp, the field locked, «Проверяем токен»
 * - rejected: red token field with the reason, the focus stays in it
 * - choose: the token opens several workspaces, one is picked, then
 *   «Подключить»
 * - connected: the workspace, whose token it is, the spaces Grill sees
 * Without `form` the fields show the static values of the state (previews);
 * the app passes `form` with the controlled values, the error and submit.
 */
export type ClickUpConnectState =
  | "form"
  | "checking"
  | "rejected"
  | "choose"
  | "connected";

const ACTION_LABEL: Record<ClickUpConnectState, string> = {
  checking: "Проверяем токен",
  choose: "Подключить",
  connected: "Готово",
  form: "Подключить",
  rejected: "Подключить",
};

const DESCRIPTION: Record<Exclude<ClickUpConnectState, "connected">, string> = {
  checking:
    "Grill будет читать задачи и комментарии, ничего не меняя в ClickUp. Нужен ваш личный токен ClickUp.",
  choose:
    "Токен открывает несколько рабочих пространств. Выберите то, где задачи агентства: Grill подключится к нему.",
  form: "Grill будет читать задачи и комментарии, ничего не меняя в ClickUp. Нужен ваш личный токен ClickUp.",
  rejected:
    "Grill будет читать задачи и комментарии, ничего не меняя в ClickUp. Нужен ваш личный токен ClickUp.",
};

const noop = () => undefined;

/** The static fields of a preview state. */
function previewForm(state: ClickUpConnectState): ClickUpConnectForm {
  return {
    checking: state === "checking",
    error:
      state === "rejected"
        ? "Токен не подошёл. Скопируйте его целиком или создайте новый."
        : undefined,
    keyRef: null,
    onTokenChange: noop,
    onWorkspaceChange: noop,
    submit: () => Promise.resolve(),
    token:
      state === "rejected" ? CLICKUP_TOKENS.rejected : CLICKUP_TOKENS.valid,
    workspace: state === "choose" ? (CLICKUP_WORKSPACES[0]?.id ?? null) : null,
    workspaces: state === "choose" ? CLICKUP_WORKSPACES : null,
  };
}

export function ClickUpConnectScreen({
  backHref,
  className,
  connection = CLICKUP_CONNECTION,
  doneHref,
  form,
  state = "form",
}: {
  backHref?: string;
  className?: string;
  connection?: typeof CLICKUP_CONNECTION;
  doneHref?: string;
  form?: ClickUpConnectForm;
  state?: ClickUpConnectState;
}) {
  const connected = state === "connected";
  const formId = useId();
  const fields = form ?? previewForm(state);
  const blocked =
    fields.checking ||
    (fields.workspaces !== null && fields.workspace === null);

  return (
    <OnboardingWindow className={className} step="integrations">
      <OnboardingContent className="gap-6">
        <ServiceStepHeading
          description={
            connected
              ? `Grill видит задачи пространства «${connection.workspace}». Какие списки относятся к проекту, выберете при его создании.`
              : DESCRIPTION[state]
          }
          service="clickup"
          title={connected ? "ClickUp подключён" : "Подключение ClickUp"}
        />
        {connected ? (
          <ConnectedCard
            chips={connection.spaces}
            description={connection.user}
            meta={connection.spacesCount}
            moreCount={connection.moreCount}
            title={connection.workspace}
          />
        ) : (
          <>
            <form
              aria-busy={fields.checking || undefined}
              aria-label="Подключение ClickUp"
              className={cn(
                "flex flex-col gap-5",
                fields.checking && "opacity-55"
              )}
              id={formId}
              inert={fields.checking}
              noValidate
              onSubmit={form?.submit}
            >
              <ClickUpTokenFields
                {...fields}
                fieldClassName="h-11"
                readOnly={!form}
              />
            </form>
            <Hint icon={<HelpIcon />} variant="panel">
              В ClickUp откройте Settings → Apps, раздел «API Token», и нажмите
              «Generate». Скопируйте токен (он начинается с pk_) и вставьте
              сюда. Токен ляжет в Keychain, Grill только читает ClickUp.
            </Hint>
          </>
        )}
      </OnboardingContent>
      <OnboardingFooter
        end={
          connected ? (
            <Button className="px-5" size="lg" {...linkButtonProps(doneHref)}>
              {ACTION_LABEL[state]}
            </Button>
          ) : (
            <Button
              className={state === "checking" ? "pr-5 pl-4" : "px-5"}
              disabled={Boolean(form) && blocked && !fields.checking}
              form={form ? formId : undefined}
              loading={state === "checking"}
              size="lg"
              type={form ? "submit" : "button"}
            >
              {ACTION_LABEL[state]}
            </Button>
          )
        }
        start={<OnboardingBackButton {...linkButtonProps(backHref)} />}
      />
    </OnboardingWindow>
  );
}
