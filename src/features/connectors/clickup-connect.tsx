"use client";

import { ExternalLinkIcon } from "lucide-react";
import {
  type FormEvent,
  type Ref,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";

import type { Workspace } from "@/bindings";
import { ChoiceField, ChoiceFieldLabel } from "@/components/ui/choice-field";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { connectWithKey } from "@/data/integrations";

import { handleServiceLink } from "./api";
import { MaskedKeyInput } from "./masked-key-input";

/*
 * Connecting ClickUp by a personal token (clickup-connector spec, «Вход по
 * личному токену» and «Выбор рабочего пространства»; connectors-clickup
 * design.md, decisions 1 and 6), shared by the Settings dialog and the
 * onboarding step: the token field with «Открыть страницу токена», a
 * refusal at the field with the focus kept there, and the workspaces as
 * radios when the token opens several. Nothing is saved before a
 * workspace is picked: «Подключить» then sends the same token with it.
 */

/** Where ClickUp issues a personal token. */
export const CLICKUP_TOKEN_PAGE = "https://app.clickup.com/settings/apps";

const MESSAGES = {
  empty: "Вставьте токен из настроек ClickUp.",
  noWorkspace: "Выберите пространство.",
  refused: "Токен не подошёл. Скопируйте его целиком или создайте новый.",
};

export interface ClickUpConnectState {
  checking: boolean;
  /** Why the token was not taken, shown at its field. */
  error?: string;
  keyRef: Ref<HTMLInputElement>;
  onTokenChange: (value: string) => void;
  onWorkspaceChange: (id: string) => void;
  submit: (event?: FormEvent<HTMLFormElement>) => Promise<void>;
  token: string;
  workspace: string | null;
  /** The workspaces to pick from; `null` until the token opens several. */
  workspaces: Workspace[] | null;
}

/**
 * The token, the workspace and the check with ClickUp. `onConnected` runs
 * once ClickUp is connected (the same connection Settings shows).
 */
export function useClickUpConnect({
  initialError,
  initialToken = "",
  initialWorkspaces = null,
  onConnected,
  onRefused,
}: {
  initialError?: string;
  initialToken?: string;
  /** The `?demo=choose` state: the workspaces already asked for. */
  initialWorkspaces?: Workspace[] | null;
  onConnected?: () => void;
  /**
   * A refusal at the token field with ClickUp's reason (the onboarding
   * list remembers it): a refused token, but also no answer, the limit or
   * a workspace the token doesn't open.
   */
  onRefused?: (reason: string) => void;
} = {}): ClickUpConnectState {
  const keyRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState(initialToken);
  const [error, setError] = useState<string | undefined>(initialError);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(
    initialWorkspaces
  );
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const onTokenChange = useCallback((value: string) => {
    setToken(value);
    setError(undefined);
    // Another token may open other workspaces.
    setWorkspaces(null);
    setWorkspace(null);
  }, []);

  const onWorkspaceChange = useCallback((id: string) => {
    setWorkspace(id);
    setError(undefined);
  }, []);

  const submit = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const key = token.trim();
      if (!key) {
        setError(MESSAGES.empty);
        keyRef.current?.focus();
        return;
      }
      if (workspaces && !workspace) {
        setError(MESSAGES.noWorkspace);
        return;
      }
      setChecking(true);
      const result = await connectWithKey(
        "clickup",
        "",
        key,
        workspaces ? workspace : null
      );
      setChecking(false);
      if (result.ok) {
        onConnected?.();
        return;
      }
      if (result.field === "workspace") {
        setWorkspaces(result.workspaces);
        setWorkspace(null);
        return;
      }
      setWorkspaces(null);
      setWorkspace(null);
      setError(
        result.message === "Токен не подошёл"
          ? MESSAGES.refused
          : result.message
      );
      if (result.field) {
        onRefused?.(result.message);
      }
      keyRef.current?.focus();
    },
    [onConnected, onRefused, token, workspace, workspaces]
  );

  return {
    checking,
    error,
    keyRef,
    onTokenChange,
    onWorkspaceChange,
    submit,
    token,
    workspace,
    workspaces,
  };
}

/** The token field and, once asked, the workspaces. */
export function ClickUpTokenFields({
  checking,
  error,
  fieldClassName,
  keyRef,
  onTokenChange,
  onWorkspaceChange,
  readOnly = false,
  token,
  workspace,
  workspaces,
}: Omit<ClickUpConnectState, "submit"> & {
  /** Onboarding fields are taller. */
  fieldClassName?: string;
  /** Previews: the field shows its value and can't be edited. */
  readOnly?: boolean;
}) {
  const keyId = useId();
  const workspacesId = useId();
  const handleWorkspace = useCallback(
    (value: unknown) => {
      if (typeof value === "string") {
        onWorkspaceChange(value);
      }
    },
    [onWorkspaceChange]
  );
  return (
    <>
      <Field invalid={Boolean(error)}>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor={keyId}>Токен ClickUp</FieldLabel>
          <a
            className="text-muted-foreground hover:text-foreground focus-visible:focus-ring -mx-2 -my-1 flex h-7 items-center gap-1 rounded-full px-2 text-sm font-medium transition-colors"
            href={CLICKUP_TOKEN_PAGE}
            onClick={handleServiceLink}
            rel="noopener noreferrer"
            target="_blank"
          >
            Открыть страницу токена
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        </div>
        <MaskedKeyInput
          autoFocus={!readOnly}
          className={fieldClassName}
          id={keyId}
          noun="токен"
          onValueChange={onTokenChange}
          placeholder="pk_…"
          readOnly={checking || readOnly}
          ref={keyRef}
          value={token}
        />
        {error ? <FieldError className="pt-0.5">{error}</FieldError> : null}
      </Field>
      {workspaces ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium" id={workspacesId}>
            Токен открывает несколько пространств. Какое подключить?
          </p>
          <RadioGroup
            aria-labelledby={workspacesId}
            className="flex flex-col gap-1.5"
            onValueChange={handleWorkspace}
            readOnly={checking || readOnly}
            value={workspace}
          >
            {workspaces.map((item) => (
              <ChoiceField
                className="bg-surface has-data-checked:bg-background h-11 rounded-sm px-4 has-data-checked:shadow-[0_0_0_1.5px_var(--color-foreground)]"
                key={item.id}
              >
                <RadioGroupItem value={item.id} />
                <ChoiceFieldLabel className="font-medium">
                  {item.name}
                </ChoiceFieldLabel>
              </ChoiceField>
            ))}
          </RadioGroup>
        </div>
      ) : null}
    </>
  );
}
