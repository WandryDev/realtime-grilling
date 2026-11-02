"use client";

import { type FormEvent, useId } from "react";

import { Button } from "@/components/ui/button";
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
  OUTLINE_CONNECTION,
  OUTLINE_KEYS,
} from "@/features/onboarding/integrations/mock";
import { OutlineKeyForm } from "@/features/onboarding/integrations/outline-key-form";
import { ServiceStepHeading } from "@/features/onboarding/integrations/step-heading";
import { linkButtonProps } from "@/lib/link-button";

/*
 * Paper "05b Outline", address and API key.
 * - form: address filled in, the key field has focus
 * - checking: one auth.info request, fields locked, "Проверяем ключ"
 * - rejected: 401, red key field with the reason
 * - connected: team, collections Grill can read, "Готово"
 * Without `form` the fields show the static values of the state (previews);
 * the app passes `form` with the controlled values, field errors and submit.
 */
export type OutlineConnectState =
  | "form"
  | "checking"
  | "rejected"
  | "connected";

const ACTION_LABEL: Record<OutlineConnectState, string> = {
  checking: "Проверяем ключ",
  connected: "Готово",
  form: "Подключить",
  rejected: "Подключить",
};

export interface OutlineConnectForm {
  apiKey: string;
  /** Why the key was rejected, shown in the "rejected" state. */
  keyError?: string;
  onApiKeyChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUrlChange: (value: string) => void;
  url: string;
  urlError?: string;
}

export function OutlineConnectScreen({
  backHref,
  className,
  connection = OUTLINE_CONNECTION,
  doneHref,
  form,
  state = "form",
}: {
  backHref?: string;
  className?: string;
  connection?: typeof OUTLINE_CONNECTION;
  doneHref?: string;
  form?: OutlineConnectForm;
  state?: OutlineConnectState;
}) {
  const connected = state === "connected";
  const formId = useId();

  return (
    <OnboardingWindow className={className} step="integrations">
      <OnboardingContent className="gap-6">
        <ServiceStepHeading
          description={
            connected
              ? `Grill видит коллекции на ${connection.host}. Какие из них относятся к проекту, выберете при его создании.`
              : "Grill будет читать документацию проектов. Нужны адрес вашего Outline и ключ доступа."
          }
          service="outline"
          title={connected ? "Outline подключён" : "Подключение Outline"}
        />
        {connected ? (
          <ConnectedCard
            chips={connection.collections}
            description={connection.host}
            descriptionMono
            meta={connection.collectionsCount}
            moreCount={connection.moreCount}
            title={connection.team}
          />
        ) : (
          <>
            <OutlineKeyForm
              apiKey={
                form?.apiKey ??
                (state === "rejected"
                  ? OUTLINE_KEYS.rejected
                  : OUTLINE_KEYS.valid)
              }
              error={form?.keyError}
              id={formId}
              onApiKeyChange={form?.onApiKeyChange}
              onSubmit={form?.onSubmit}
              onUrlChange={form?.onUrlChange}
              state={state === "form" ? "editing" : state}
              url={form?.url ?? connection.url}
              urlError={form?.urlError}
            />
            <Hint icon={<HelpIcon />} variant="panel">
              В Outline откройте «Настройки», раздел «API», и нажмите «Новый
              ключ». Назовите его Grill и вставьте сюда.
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
