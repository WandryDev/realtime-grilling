"use client";

import { type FormEvent, useCallback, useState } from "react";

import { setIntegration, useIntegration } from "@/data/integrations";
import {
  cancelConnect,
  connectOutline,
  OUTLINE_REJECTED_SUMMARY,
} from "@/features/onboarding/integrations/api";
import {
  OUTLINE_CONNECTION,
  OUTLINE_KEYS,
} from "@/features/onboarding/integrations/mock";
import { normalizeOutlineUrl } from "@/features/onboarding/integrations/outline-url";
import { useOnboardingIntegrationsSession } from "@/features/onboarding/integrations/session";
import {
  OutlineConnectScreen,
  type OutlineConnectState,
} from "@/features/onboarding/screens/outline-connect-screen";

import { returnHref } from "./return-href";

/*
 * Step 05b, Outline address and API key. The address is trimmed to its root
 * on submit, empty fields are caught before the request, then one fake
 * auth.info check (`connectOutline`): a 401 marks the key, an unknown host
 * marks the address. "Исправить" on the list reopens with the saved address.
 */

export const OUTLINE_DEMO_STATES = ["rejected"] as const;

const MESSAGES = {
  keyEmpty: "Вставьте API-ключ из настроек Outline.",
  keyRejected: "Ключ не подошёл. Скопируйте его целиком или создайте новый.",
  urlEmpty: "Укажите адрес вашего Outline.",
  urlInvalid: "Это не похоже на адрес. Например, docs.pixel.agency",
};

// The address survives leaving the step, like the saved address in Paper
let savedUrl = OUTLINE_CONNECTION.url;

function seedRejected() {
  cancelConnect("outline");
  setIntegration("outline", {
    error: OUTLINE_REJECTED_SUMMARY,
    status: "error",
  });
}

export function OutlineConnectFlow({
  demo,
  from,
}: {
  demo?: (typeof OUTLINE_DEMO_STATES)[number];
  from?: "done";
}) {
  const rejectedDemo = demo === "rejected";
  useOnboardingIntegrationsSession(rejectedDemo ? seedRejected : undefined);
  const outline = useIntegration("outline");

  const [url, setUrl] = useState(savedUrl);
  const [apiKey, setApiKey] = useState(
    rejectedDemo ? OUTLINE_KEYS.rejected : ""
  );
  const [urlError, setUrlError] = useState<string>();
  const [keyError, setKeyError] = useState<string | undefined>(
    rejectedDemo ? MESSAGES.keyRejected : undefined
  );

  const changeUrl = useCallback((value: string) => {
    savedUrl = value;
    setUrl(value);
    setUrlError(undefined);
  }, []);

  const changeApiKey = useCallback((value: string) => {
    setApiKey(value);
    setKeyError(undefined);
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const root = normalizeOutlineUrl(url);
      const key = apiKey.trim();
      let nextUrlError: string | undefined;
      if (!root) {
        nextUrlError = url.trim() ? MESSAGES.urlInvalid : MESSAGES.urlEmpty;
      }
      const nextKeyError = key ? undefined : MESSAGES.keyEmpty;
      setUrlError(nextUrlError);
      setKeyError(nextKeyError);
      if (!root || nextKeyError) {
        return;
      }

      savedUrl = root;
      setUrl(root);
      const result = await connectOutline(root, key);
      // Left the step meanwhile? Setting state of an unmounted step is a no-op.
      if (result.ok) {
        return;
      }
      if (result.field === "url") {
        setUrlError(result.message);
      } else {
        setKeyError(result.message);
      }
    },
    [apiKey, url]
  );

  let state: OutlineConnectState = keyError ? "rejected" : "form";
  if (outline.status === "connected") {
    state = "connected";
  } else if (outline.status === "connecting") {
    state = "checking";
  }

  return (
    <OutlineConnectScreen
      backHref={returnHref(from)}
      className="h-svh"
      doneHref={returnHref(from)}
      form={{
        apiKey,
        keyError,
        onApiKeyChange: changeApiKey,
        onSubmit: submit,
        onUrlChange: changeUrl,
        url,
        urlError,
      }}
      state={state}
    />
  );
}
