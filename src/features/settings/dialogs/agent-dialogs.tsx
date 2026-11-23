"use client";

import { Button } from "@grill/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grill/ui/dialog";
import { Field, FieldError, FieldLabel } from "@grill/ui/field";
import { Input } from "@grill/ui/input";
import { Spinner } from "@grill/ui/spinner";
import { toast } from "@grill/ui/toast";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AgentState } from "@/bindings";
import {
  cancelAgentLogin,
  getAgentSetup,
  loginAgent,
  submitAgentLoginCode,
  useAgentSetup,
} from "@/data/onboarding-setup";
import { updateSetting } from "@/data/settings";
import { openLoginPage } from "@/features/onboarding/api";
import { AgentLoginForm } from "@/features/onboarding/components/agent-login-form";

import { checkAgent, isAbortError } from "../api";
import { useAbortSignal } from "../use-abort-signal";

/*
 * Another path to the CLI in Settings → Агент: Rust checks it
 * (`agent_check_path`, nothing saved), and only a CLI that answers is
 * saved as `agentPath`.
 */

/** Why a checked path can't be saved, or `null` when it can. */
function pathProblem(path: string, agent: AgentState) {
  if (agent.status === "notInstalled") {
    return `По пути ${path} нет Claude Code`;
  }
  if (agent.status === "error") {
    return `Claude Code по этому пути не отвечает: ${agent.message.split("\n")[0]}`;
  }
  return null;
}

function AgentPathForm({
  current,
  onDone,
}: {
  current: string;
  /** The path was saved; what the CLI there is. */
  onDone: (agent: AgentState) => void;
}) {
  const nextSignal = useAbortSignal();
  const [path, setPath] = useState(current);
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPath(event.target.value);
    setError(undefined);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const next = path.trim();
      if (!next) {
        setError("Укажите путь к claude");
        return;
      }
      setChecking(true);
      try {
        const agent = await checkAgent(next, nextSignal());
        const problem = pathProblem(next, agent);
        if (problem) {
          setChecking(false);
          setError(problem);
          return;
        }
        updateSetting("agentPath", next);
        toast.add({
          description: next,
          title: "Claude Code найден",
          type: "success",
        });
        onDone(agent);
      } catch (checkError) {
        if (isAbortError(checkError)) {
          return;
        }
        setChecking(false);
        setError(
          checkError instanceof Error ? checkError.message : "Не нашли CLI"
        );
      }
    },
    [nextSignal, onDone, path]
  );

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={handleSubmit}>
      <Field invalid={Boolean(error)}>
        <FieldLabel>Путь к CLI</FieldLabel>
        <Input
          autoFocus
          className="font-mono text-sm"
          onChange={handleChange}
          placeholder="/usr/local/bin/claude"
          readOnly={checking}
          spellCheck={false}
          value={path}
        />
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="secondary" />}>
          Отмена
        </DialogClose>
        <Button disabled={checking} type="submit">
          {checking ? <Spinner aria-hidden="true" /> : null}
          {checking ? "Проверяем…" : "Проверить и сохранить"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AgentPathDialog({
  current,
  onOpenChange,
  onSaved,
  open,
}: {
  current: string;
  onOpenChange: (open: boolean) => void;
  /** The path was saved; what the CLI there is. */
  onSaved: (agent: AgentState) => void;
  open: boolean;
}) {
  const close = useCallback(
    (agent: AgentState) => {
      onSaved(agent);
      onOpenChange(false);
    },
    [onOpenChange, onSaved]
  );
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Где лежит Claude Code</DialogTitle>
          <DialogDescription>
            Grill проверит, что по этому пути отвечает Claude Code, и только
            потом сохранит путь
          </DialogDescription>
        </DialogHeader>
        <AgentPathForm current={current} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

/** «Открыть страницу ещё раз»: the login page of the running login. */
function reopenLoginPage() {
  const { loginUrl } = getAgentSetup();
  if (loginUrl) {
    openLoginPage(loginUrl);
  }
}

/*
 * The login flow of onboarding (`loginAgent`, `submitAgentLoginCode`,
 * `cancelAgentLogin` over `agent_login_*`): the browser opens, the code
 * from its page goes into the form. Done once the CLI says it is ready.
 */
function AgentLoginFlow({
  onCancel,
  onSignedIn,
}: {
  onCancel: () => void;
  onSignedIn: () => void;
}) {
  const agent = useAgentSetup();
  const started = useRef<boolean>(false);
  const awaitingCode = useRef<boolean>(false);

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      loginAgent();
    }
  }, []);

  useEffect(() => {
    if (agent.status === "awaiting-code") {
      awaitingCode.current = true;
    } else if (agent.status === "ready" && awaitingCode.current) {
      awaitingCode.current = false;
      onSignedIn();
    }
  }, [agent.status, onSignedIn]);

  if (agent.status === "awaiting-code") {
    return (
      <AgentLoginForm
        error={agent.loginError ?? undefined}
        onCancel={onCancel}
        onRelogin={loginAgent}
        onReopen={reopenLoginPage}
        onSubmit={submitAgentLoginCode}
        relogging={agent.loginPending}
        submitting={agent.loginSubmitting}
      />
    );
  }

  const failure =
    agent.status === "error"
      ? (agent.error?.message.split("\n\n")[0] ?? "Вход не начался")
      : agent.loginError;
  if (failure && !agent.loginPending) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-contradiction text-sm">{failure}</p>
        <DialogFooter>
          <Button onClick={onCancel} variant="secondary">
            Отмена
          </Button>
          <Button onClick={loginAgent}>Войти ещё раз</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Spinner aria-hidden="true" className="size-4" />
      Открываем страницу входа в браузере…
    </div>
  );
}

/**
 * «Войти» in Settings → Агент: the onboarding login in a dialog. Closing
 * it before the CLI is signed in cancels the login.
 */
export function AgentLoginDialog({
  onOpenChange,
  onSignedIn,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  /** The CLI is signed in. */
  onSignedIn: () => void;
  open: boolean;
}) {
  const cancel = useCallback(() => {
    cancelAgentLogin();
    onOpenChange(false);
  }, [onOpenChange]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
      } else {
        cancel();
      }
    },
    [cancel, onOpenChange]
  );
  const signedIn = useCallback(() => {
    onOpenChange(false);
    onSignedIn();
  }, [onOpenChange, onSignedIn]);

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Вход в Claude Code</DialogTitle>
          <DialogDescription>
            Войдите в Claude в браузере и вставьте сюда код со страницы входа
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <AgentLoginFlow onCancel={cancel} onSignedIn={signedIn} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
