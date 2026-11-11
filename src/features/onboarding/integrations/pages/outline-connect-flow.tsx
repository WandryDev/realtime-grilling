"use client";

import { type FormEvent, useCallback, useRef, useState } from "react";

import {
  clearIntegration,
  connectWithKey,
  getIntegrations,
  type IntegrationState,
  setIntegration,
  useIntegration,
} from "@/data/integrations";
import { useConnectorContainers } from "@/features/connectors/api";
import { documentsCount } from "@/features/connectors/labels";
import {
  OUTLINE_REJECTED_SUMMARY,
  OUTLINE_UNREACHABLE_SUMMARY,
} from "@/features/onboarding/integrations/api";
import {
  OUTLINE_CONNECTION,
  OUTLINE_KEYS,
} from "@/features/onboarding/integrations/mock";
import { checkOutlineUrl } from "@/features/onboarding/integrations/outline-url";
import { useOnboardingIntegrationsSession } from "@/features/onboarding/integrations/session";
import {
  OutlineConnectScreen,
  type OutlineConnectState,
} from "@/features/onboarding/screens/outline-connect-screen";
import { plural } from "@/lib/plural";

import { returnHref } from "./return-href";

/*
 * Step 05b, Outline address and API key, on the `Connectors` service
 * (connectors spec, «Коннекторы в онбординге»). The address is checked
 * and trimmed to its root before the request, empty fields are caught,
 * then one check with Outline: a refused key marks the key field and
 * keeps the focus in it, an address that doesn't answer marks the address
 * and keeps the key. Success shows the team and its collections; it is
 * the same connection Settings shows.
 */

export const OUTLINE_DEMO_STATES = ["rejected"] as const;

const MESSAGES = {
  keyEmpty: "Вставьте API-ключ из настроек Outline.",
  keyRejected: "Ключ не подошёл. Скопируйте его целиком или создайте новый.",
};

/** How many collection chips the card shows before «и ещё N». */
const CHIPS = 3;

// The address survives leaving the step, like the saved address in Paper
let savedUrl = OUTLINE_CONNECTION.url;

function seedRejected() {
  setIntegration("outline", {
    error: OUTLINE_REJECTED_SUMMARY,
    status: "error",
  });
}

/** The onboarding list keeps a refusal as «Исправить» until it is fixed. */
function rememberRefusal(field: "host" | "key", previous: IntegrationState) {
  if (previous.status === "connected") {
    return;
  }
  setIntegration("outline", {
    error:
      field === "host" ? OUTLINE_UNREACHABLE_SUMMARY : OUTLINE_REJECTED_SUMMARY,
    status: "error",
  });
}

/** The card of a connected Outline: team, address, collections. */
function useConnection(outline: IntegrationState) {
  const connected = outline.status === "connected";
  const { state } = useConnectorContainers("outline", connected);
  const collections = state.status === "ready" ? state.nodes : [];
  return {
    collections: collections.slice(0, CHIPS).map((node) => node.title),
    collectionsCount:
      state.status === "ready"
        ? `${collections.length} ${plural(collections.length, "коллекция", "коллекции", "коллекций")}, ${documentsCount(collections.reduce((sum, node) => sum + node.documentCount, 0))}`
        : "",
    host: outline.account ?? OUTLINE_CONNECTION.host,
    moreCount: Math.max(0, collections.length - CHIPS),
    team: outline.team ?? OUTLINE_CONNECTION.team,
    url: outline.host ?? OUTLINE_CONNECTION.url,
  };
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
  const connection = useConnection(outline);
  const keyRef = useRef<HTMLInputElement>(null);

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
      const address = checkOutlineUrl(url);
      const key = apiKey.trim();
      const nextKeyError = key ? undefined : MESSAGES.keyEmpty;
      setUrlError(address.ok ? undefined : address.message);
      setKeyError(nextKeyError);
      if (!address.ok || nextKeyError) {
        return;
      }

      savedUrl = address.origin;
      setUrl(address.origin);
      const previous = getIntegrations().outline;
      const result = await connectWithKey("outline", address.origin, key);
      // Left the step meanwhile? Setting state of an unmounted step is a no-op.
      if (result.ok) {
        clearIntegration("outline");
        return;
      }
      if (result.field === "host") {
        setUrlError(result.message);
      } else {
        setKeyError(
          result.message === "Ключ не подошёл"
            ? MESSAGES.keyRejected
            : result.message
        );
        keyRef.current?.focus();
      }
      if (result.field) {
        rememberRefusal(result.field, previous);
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
      connection={connection}
      doneHref={returnHref(from)}
      form={{
        apiKey,
        keyError,
        keyRef,
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
