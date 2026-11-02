"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useId,
  useState,
} from "react";

import {
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  type IntegrationState,
  setIntegration,
  useIntegration,
} from "@/data/integrations";
import type { IntegrationService } from "@/lib/routes";

import { connectService } from "../api";
import { OUTLINE, SERVICE_NAMES } from "../mock";
import { showErrorToast } from "../toasts";

/*
 * Connecting a service from Settings → Интеграции.
 * - GitHub and ClickUp sign in through the browser: the dialog explains what
 *   Grill will read, "Продолжить в браузере" closes it and the row shows
 *   "Подключаем…" until the (simulated) OAuth answers.
 * - Outline takes an address and an API key; "Обновить ключ" on a broken
 *   Outline opens the same form with the address filled in. The key is
 *   checked inside the dialog, a rejected key stays on the form.
 */

const BROWSER_COPY: Record<
  Exclude<IntegrationService, "outline">,
  { description: string; icon: ReactNode }
> = {
  clickup: {
    description:
      "Откроется браузер: войдите в ClickUp и выберите пространство. Grill будет только читать задачи и комментарии.",
    icon: <ClickUpIcon className="size-5" />,
  },
  github: {
    description:
      "Откроется браузер: войдите в GitHub и выберите репозитории. Grill будет только читать код, без права что-то менять.",
    icon: <GitHubIcon className="size-5" />,
  },
};

/** Runs the connection and keeps the store in step; shared by both forms. */
async function connect(
  service: IntegrationService,
  previous: IntegrationState,
  input?: { host?: string; key?: string }
) {
  setIntegration(service, { ...previous, status: "connecting" });
  try {
    const next = await connectService(service, input);
    setIntegration(service, next);
    toast.add({
      title: `${SERVICE_NAMES[service]} подключён`,
      type: "success",
    });
    return true;
  } catch (error) {
    setIntegration(service, previous);
    return error instanceof Error ? error : new Error("Не получилось");
  }
}

function BrowserConnect({
  onDone,
  service,
}: {
  onDone: () => void;
  service: Exclude<IntegrationService, "outline">;
}) {
  const previous = useIntegration(service);
  const copy = BROWSER_COPY[service];

  const handleContinue = useCallback(async () => {
    onDone();
    // The connection outlives the dialog: the row shows its progress.
    const result = await connect(service, previous);
    if (result !== true) {
      showErrorToast(
        `Не получилось подключить ${SERVICE_NAMES[service]}`,
        result
      );
    }
  }, [onDone, previous, service]);

  return (
    <>
      <DialogHeader>
        <span className="bg-surface ring-foreground/6 flex size-11 items-center justify-center rounded-sm ring-1">
          {copy.icon}
        </span>
        <DialogTitle>Подключить {SERVICE_NAMES[service]}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button variant="secondary" />}>
          Отмена
        </DialogClose>
        <Button onClick={handleContinue}>Продолжить в браузере</Button>
      </DialogFooter>
    </>
  );
}

function OutlineConnect({
  onDone,
  reconnect,
}: {
  onDone: () => void;
  reconnect: boolean;
}) {
  const previous = useIntegration("outline");
  const hostId = useId();
  const keyId = useId();
  const [host, setHost] = useState(
    reconnect ? (previous.account ?? OUTLINE.host) : ""
  );
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);

  const handleHostChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setHost(event.target.value),
    []
  );
  const handleKeyChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setKey(event.target.value);
      setError(undefined);
    },
    []
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setChecking(true);
      const result = await connect("outline", previous, { host, key });
      if (result === true) {
        onDone();
        return;
      }
      setChecking(false);
      setError(result.message);
    },
    [host, key, onDone, previous]
  );

  return (
    <>
      <DialogHeader>
        <span className="bg-surface ring-foreground/6 flex size-11 items-center justify-center rounded-sm ring-1">
          <OutlineIcon className="size-5" />
        </span>
        <DialogTitle>
          {reconnect ? "Новый ключ Outline" : "Подключить Outline"}
        </DialogTitle>
        <DialogDescription>
          Ключ создаётся в Outline: Настройки → API. Grill будет только читать
          документы, ключ ляжет в Keychain.
        </DialogDescription>
      </DialogHeader>
      <form
        aria-busy={checking || undefined}
        className="flex flex-col gap-5"
        noValidate
        onSubmit={handleSubmit}
      >
        <Field>
          <FieldLabel htmlFor={hostId}>Адрес Outline</FieldLabel>
          <Input
            className="font-mono text-sm"
            id={hostId}
            inputMode="url"
            onChange={handleHostChange}
            placeholder="docs.example.com"
            readOnly={checking}
            spellCheck={false}
            value={host}
          />
        </Field>
        <Field invalid={Boolean(error)}>
          <FieldLabel htmlFor={keyId}>API-ключ</FieldLabel>
          <PasswordInput
            autoFocus
            id={keyId}
            onChange={handleKeyChange}
            placeholder="ol_api_…"
            readOnly={checking}
            value={key}
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>
            Отмена
          </DialogClose>
          <Button disabled={checking || !key.trim()} type="submit">
            {checking ? <Spinner aria-hidden="true" /> : null}
            {checking ? "Проверяем ключ…" : "Подключить"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export interface ConnectTarget {
  /** A broken service: the form opens with what is already known. */
  reconnect: boolean;
  service: IntegrationService;
}

export function ConnectServiceDialog({
  onOpenChange,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  /** `null` keeps the dialog closed. */
  target: ConnectTarget | null;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  // Keep the last service on screen while the dialog animates out.
  const [shown, setShown] = useState(target);
  if (target !== null && target !== shown) {
    setShown(target);
  }
  let body: ReactNode = null;
  if (shown?.service === "outline") {
    body = <OutlineConnect onDone={close} reconnect={shown.reconnect} />;
  } else if (shown) {
    body = <BrowserConnect onDone={close} service={shown.service} />;
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={target !== null}>
      <DialogContent>{body}</DialogContent>
    </Dialog>
  );
}
