"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { CallScreenActions } from "./types";

/*
 * Handlers of the live call window, handed down to the rows and buttons that
 * need them. Without a provider (the /dev/screens previews) every handler is
 * missing and the buttons stay inert.
 */
const CallActionsContext = createContext<CallScreenActions>({});

export function CallActionsProvider({
  actions,
  children,
}: {
  actions: CallScreenActions;
  children: ReactNode;
}) {
  return (
    <CallActionsContext.Provider value={actions}>
      {children}
    </CallActionsContext.Provider>
  );
}

export function useCallActions() {
  return useContext(CallActionsContext);
}
