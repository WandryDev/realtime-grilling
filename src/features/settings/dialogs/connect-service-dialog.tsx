"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
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
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { connectWithKey, useIntegration } from "@/data/integrations";
import {
  ClickUpTokenFields,
  useClickUpConnect,
} from "@/features/connectors/clickup-connect";
import { MaskedKeyInput } from "@/features/connectors/masked-key-input";
import { connectDemoService } from "@/features/onboarding/integrations/api";
import { checkOutlineUrl } from "@/features/onboarding/integrations/outline-url";
import type { IntegrationService } from "@/lib/routes";

import { SERVICE_NAMES } from "../mock";

/*
 * Connecting a service from Settings → Интеграции (or from the project
 * wizard, over its Sources step).
 * - GitHub signs in through the browser: the dialog explains what Grill
 *   will read, "Продолжить в браузере" closes it and the row shows
 *   "Подключаем…" until the demo sign-in answers. In the app it is
 *   «скоро» and never opens it.
 * - Outline takes an address and an API key (`connectWithKey`); "Обновить
 *   ключ" on a broken Outline opens the same form with the address filled
 *   in. The key is checked inside the dialog: a refusal shows at the field
 *   it belongs to and the dialog stays, the key stays too.
 * - ClickUp takes a personal token (`useClickUpConnect`); a token that
 *   opens several workspaces shows them as radios, and «Подключить» sends
 *   the token again with the picked one. «Обновить токен» opens the same.
 */

const BROWSER_COPY: Record<"github", { description: string; icon: ReactNode }> =
  {
    github: {
      description:
        "Откроется браузер: войдите в GitHub и выберите репозитории. Grill будет только читать код, без права что-то менять.",
      icon: <GitHubIcon className="size-5" />,
    },
  };

function BrowserConnect({
  onDone,
  service,
}: {
  onDone: () => void;
  service: "github";
}) {
  const copy = BROWSER_COPY[service];

  const handleContinue = useCallback(async () => {
    onDone();
    // The connection outlives the dialog: the row shows its progress.
    await connectDemoService(service);
    toast.add({
      title: `${SERVICE_NAMES[service]} подключён`,
      type: "success",
    });
  }, [onDone, service]);

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

const KEY_REFUSED =
  "Ключ не подошёл. Скопируйте его целиком или создайте новый.";

function OutlineConnect({
  onConnected,
  onDone,
  reconnect,
}: {
  onConnected?: () => void;
  onDone: () => void;
  reconnect: boolean;
}) {
  const previous = useIntegration("outline");
  const hostId = useId();
  const keyId = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const [host, setHost] = useState(
    reconnect || previous.status === "connected" ? (previous.host ?? "") : ""
  );
  const [key, setKey] = useState("");
  const [hostError, setHostError] = useState<string>();
  const [keyError, setKeyError] = useState<string>();
  const [checking, setChecking] = useState(false);

  const handleHostChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setHost(event.target.value);
      setHostError(undefined);
    },
    []
  );
  const handleKeyChange = useCallback((value: string) => {
    setKey(value);
    setKeyError(undefined);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const address = checkOutlineUrl(host);
      if (!address.ok) {
        setHostError(address.message);
        return;
      }
      setHost(address.origin);
      setChecking(true);
      const result = await connectWithKey("outline", address.origin, key);
      setChecking(false);
      if (result.ok) {
        toast.add({ title: "Outline подключён", type: "success" });
        onConnected?.();
        onDone();
        return;
      }
      if (result.field === "workspace") {
        return;
      }
      if (result.field === "host") {
        setHostError(result.message);
        return;
      }
      setKeyError(
        result.message === "Ключ не подошёл" ? KEY_REFUSED : result.message
      );
      keyRef.current?.focus();
    },
    [host, key, onConnected, onDone]
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
        aria-label="Подключение Outline"
        className="flex flex-col gap-5"
        noValidate
        onSubmit={handleSubmit}
      >
        <Field invalid={Boolean(hostError)}>
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
          {hostError ? <FieldError>{hostError}</FieldError> : null}
        </Field>
        <Field invalid={Boolean(keyError)}>
          <FieldLabel htmlFor={keyId}>API-ключ</FieldLabel>
          <MaskedKeyInput
            autoFocus
            id={keyId}
            onValueChange={handleKeyChange}
            placeholder="ol_api_…"
            readOnly={checking}
            ref={keyRef}
            value={key}
          />
          {keyError ? <FieldError>{keyError}</FieldError> : null}
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

function ClickUpConnect({
  onConnected,
  onDone,
  reconnect,
}: {
  onConnected?: () => void;
  onDone: () => void;
  reconnect: boolean;
}) {
  const connected = useCallback(() => {
    toast.add({ title: "ClickUp подключён", type: "success" });
    onConnected?.();
    onDone();
  }, [onConnected, onDone]);
  const clickup = useClickUpConnect({ onConnected: connected });
  const { checking, submit, token, workspace, workspaces } = clickup;
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => submit(event),
    [submit]
  );

  return (
    <>
      <DialogHeader>
        <span className="bg-surface ring-foreground/6 flex size-11 items-center justify-center rounded-sm ring-1">
          <ClickUpIcon className="size-5" />
        </span>
        <DialogTitle>
          {reconnect ? "Новый токен ClickUp" : "Подключить ClickUp"}
        </DialogTitle>
        <DialogDescription>
          Личный токен создаётся в ClickUp: Settings → Apps → API Token. Grill
          будет только читать задачи и комментарии, токен ляжет в Keychain.
        </DialogDescription>
      </DialogHeader>
      <form
        aria-busy={checking || undefined}
        aria-label="Подключение ClickUp"
        className="flex flex-col gap-5"
        noValidate
        onSubmit={handleSubmit}
      >
        <ClickUpTokenFields {...clickup} />
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>
            Отмена
          </DialogClose>
          <Button
            disabled={
              checking || !token.trim() || (workspaces !== null && !workspace)
            }
            type="submit"
          >
            {checking ? <Spinner aria-hidden="true" /> : null}
            {checking ? "Проверяем токен…" : "Подключить"}
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
  onConnected,
  onOpenChange,
  target,
}: {
  /** Outline or ClickUp connected (the wizard opens its picker then). */
  onConnected?: () => void;
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
    body = (
      <OutlineConnect
        onConnected={onConnected}
        onDone={close}
        reconnect={shown.reconnect}
      />
    );
  } else if (shown?.service === "clickup") {
    body = (
      <ClickUpConnect
        onConnected={onConnected}
        onDone={close}
        reconnect={shown.reconnect}
      />
    );
  } else if (shown) {
    body = <BrowserConnect onDone={close} service={shown.service} />;
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={target !== null}>
      <DialogContent>{body}</DialogContent>
    </Dialog>
  );
}
