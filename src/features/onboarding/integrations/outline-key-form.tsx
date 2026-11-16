"use client";

import { type ChangeEvent, type FormEvent, type Ref, useCallback } from "react";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MaskedKeyInput } from "@/features/connectors/masked-key-input";
import { ExternalArrowIcon } from "@/features/onboarding/components/icons";
import { cn } from "@/lib/utils";

import { normalizeOutlineUrl } from "./outline-url";

/*
 * Paper "05b Outline": the Outline address and the API key, 44px fields.
 * - editing: the key field has focus
 * - checking: both fields are locked and dimmed while auth.info answers
 * - rejected: red key field with the reason under it
 * "Открыть страницу ключей" leads to <address>/settings/api-and-apps and is
 * inactive while the address is empty. The key shows its start and its
 * last 4 characters, the eye shows it whole.
 */
export type OutlineKeyFormState = "editing" | "checking" | "rejected";

// Onboarding fields are 4px taller than the 40px default
const FIELD_CLASS = "h-11";

export function OutlineKeyForm({
  apiKey,
  className,
  error = "Ключ не подошёл. Скопируйте его целиком или создайте новый.",
  id,
  keyRef,
  onApiKeyChange,
  onSubmit,
  onUrlChange,
  state,
  url,
  urlError,
}: {
  apiKey: string;
  className?: string;
  error?: string;
  /** Lets a submit button outside the form (the footer) point at it. */
  id?: string;
  /** The key field: focus stays in it after a refusal. */
  keyRef?: Ref<HTMLInputElement>;
  /** Makes the fields controlled; without it they show the static values. */
  onApiKeyChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onUrlChange?: (value: string) => void;
  state: OutlineKeyFormState;
  url: string;
  /** The address doesn't answer or isn't an address. */
  urlError?: string;
}) {
  const checking = state === "checking";
  const interactive = onApiKeyChange !== undefined;
  const keysPage = normalizeOutlineUrl(url);

  const handleUrlChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onUrlChange?.(event.target.value),
    [onUrlChange]
  );
  const handleApiKeyChange = useCallback(
    (value: string) => onApiKeyChange?.(value),
    [onApiKeyChange]
  );

  return (
    <form
      aria-busy={checking || undefined}
      aria-label="Подключение Outline"
      className={cn(
        "flex flex-col gap-3.5",
        checking && "opacity-55",
        className
      )}
      id={id}
      inert={checking}
      noValidate
      onSubmit={onSubmit}
    >
      <Field invalid={Boolean(urlError)}>
        <FieldLabel>Адрес Outline</FieldLabel>
        <Input
          className={cn(FIELD_CLASS, "px-3.5 font-mono text-sm")}
          inputMode="url"
          onChange={onUrlChange ? handleUrlChange : undefined}
          placeholder="https://docs.example.com"
          readOnly={checking}
          spellCheck={false}
          {...(onUrlChange ? { value: url } : { defaultValue: url })}
        />
        {urlError ? (
          <FieldError className="pt-0.5">{urlError}</FieldError>
        ) : null}
      </Field>
      <Field invalid={state === "rejected"}>
        <div className="flex items-center justify-between">
          <FieldLabel>API-ключ</FieldLabel>
          {keysPage ? (
            <a
              className="text-muted-foreground hover:text-foreground focus-visible:focus-ring -mx-2 -my-1 flex h-7 items-center gap-1 rounded-full px-2 text-sm font-medium transition-colors"
              href={`${keysPage}/settings/api-and-apps`}
              rel="noopener noreferrer"
              target="_blank"
            >
              Открыть страницу ключей
              <ExternalArrowIcon className="size-3" />
            </a>
          ) : (
            <span className="text-subtle -mx-2 -my-1 flex h-7 items-center gap-1 px-2 text-sm font-medium">
              Открыть страницу ключей
              <ExternalArrowIcon className="size-3" />
            </span>
          )}
        </div>
        <MaskedKeyInput
          className={FIELD_CLASS}
          onValueChange={handleApiKeyChange}
          placeholder="ol_api_…"
          readOnly={checking || !interactive}
          ref={keyRef}
          value={apiKey}
        />
        {state === "rejected" ? (
          <FieldError className="pt-0.5">{error}</FieldError>
        ) : null}
      </Field>
    </form>
  );
}
