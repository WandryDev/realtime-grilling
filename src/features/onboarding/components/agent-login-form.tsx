"use client";

import { Button } from "@grill/ui/button";
import { Field, FieldError, FieldLabel } from "@grill/ui/field";
import { Input } from "@grill/ui/input";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { ExternalArrowIcon } from "./icons";

/*
 * The browser login of the "Агент" step: the user logs in to Claude in the
 * browser, the page shows a code, the code goes into "Код из браузера".
 * - waiting: "Подтвердить", "Открыть страницу ещё раз", "Отменить"
 * - submitting: "Подтвердить" spins, the field is read-only
 * - rejected (`error`): red field with the reason; the login session is
 *   over, so "Войти ещё раз" starts a new one
 */
export function AgentLoginForm({
  className,
  error,
  onCancel,
  onRelogin,
  onReopen,
  onSubmit,
  relogging = false,
  submitting = false,
}: {
  className?: string;
  /** The CLI didn't take the code. */
  error?: string;
  onCancel?: () => void;
  /** "Войти ещё раз" after a rejected code. */
  onRelogin?: () => void;
  /** "Открыть страницу ещё раз". */
  onReopen?: () => void;
  onSubmit?: (code: string) => void;
  /** "Войти ещё раз" is starting a new login. */
  relogging?: boolean;
  submitting?: boolean;
}) {
  const [code, setCode] = useState("");
  const [empty, setEmpty] = useState(false);
  const rejected = Boolean(error);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setCode(event.target.value);
    setEmpty(false);
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (rejected || submitting) {
        return;
      }
      if (!code.trim()) {
        setEmpty(true);
        return;
      }
      onSubmit?.(code);
    },
    [code, onSubmit, rejected, submitting]
  );

  const handleRelogin = useCallback(() => {
    setCode("");
    onRelogin?.();
  }, [onRelogin]);

  let fieldError: string | undefined = error;
  if (!fieldError && empty) {
    fieldError = "Вставьте код со страницы входа";
  }

  return (
    <form
      aria-label="Вход в Claude"
      className={cn("flex flex-col gap-3", className)}
      noValidate
      onSubmit={handleSubmit}
    >
      <Field invalid={Boolean(fieldError)}>
        <FieldLabel>Код из браузера</FieldLabel>
        <Input
          autoComplete="off"
          className="h-11 px-3.5 font-mono text-sm"
          onChange={handleChange}
          readOnly={submitting}
          spellCheck={false}
          value={code}
        />
        {fieldError ? (
          <FieldError className="pt-0.5">{fieldError}</FieldError>
        ) : null}
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        {rejected ? (
          <Button
            className="h-9 px-4"
            loading={relogging}
            onClick={handleRelogin}
          >
            Войти ещё раз
          </Button>
        ) : (
          <>
            <Button className="h-9 px-4" loading={submitting} type="submit">
              Подтвердить
            </Button>
            <Button
              className="h-9 gap-1.5 px-4"
              disabled={submitting}
              onClick={onReopen}
              variant="secondary"
            >
              Открыть страницу ещё раз
              <ExternalArrowIcon className="size-3" />
            </Button>
          </>
        )}
        <Button
          className="h-9 px-3"
          disabled={submitting}
          onClick={onCancel}
          variant="ghost"
        >
          Отменить
        </Button>
      </div>
    </form>
  );
}
