"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { followCallSession } from "@/data/call-session";
import { retryDataLoad, useDataLoad } from "@/data/status";
import { useHydrated } from "@/lib/use-hydrated";
import { currentWindowLabel, MAIN_WINDOW } from "@/lib/window-label";

import { reopenStorage, subscribeToNavigate } from "./api";
import { MainWindow } from "./main-window";

/*
 * Around every page of every window:
 * - in Tauri, the call in progress follows the other windows;
 * - the main window opens the routes Rust and the other windows ask for
 *   (the tray's "Настройки", the overlay's summary). It is told by its
 *   window label, whatever route it shows;
 * - a main-window page waits for the stores' first read and, if the local
 *   database can't be read, the window shows why instead of empty lists.
 *
 * Onboarding, the start widget, the overlay and /dev are other windows (or
 * the catalog) and render their pages as they are.
 */

const OTHER_WINDOWS = ["/onboarding", "/widget", "/overlay", "/dev"];

const HTML_SUFFIX = /\.html$/u;

export function isMainWindowRoute(pathname: string) {
  // A window may load the exported file itself (`widget.html`).
  const route = pathname.replace(HTML_SUFFIX, "");
  return !OTHER_WINDOWS.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`)
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const mainWindow = currentWindowLabel() === MAIN_WINDOW;
  useEffect(() => followCallSession(), []);
  return (
    <>
      {mainWindow ? <NavigateListener /> : null}
      {isMainWindowRoute(pathname) ? (
        <MainWindowFrame>{children}</MainWindowFrame>
      ) : (
        children
      )}
    </>
  );
}

/** Opens the routes Rust (or another window) sends to this window. */
function NavigateListener() {
  const router = useRouter();
  useEffect(() => subscribeToNavigate((route) => router.push(route)), [router]);
  return null;
}

function MainWindowFrame({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  const data = useDataLoad();

  // The prerendered HTML has demo data; nothing shows before the client knows.
  if (!hydrated || data.status === "loading") {
    return <div aria-busy="true" className="bg-surface h-svh" />;
  }
  if (data.status === "error") {
    return <StorageErrorScreen message={data.error?.message} />;
  }
  return children;
}

/**
 * The local database could not be opened or read: what happened and a
 * retry, which opens it again in Rust and then re-reads the stores.
 */
export function StorageErrorScreen({
  className = "h-svh",
  message,
}: {
  className?: string;
  message?: string;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(async () => {
    setRetrying(true);
    await reopenStorage();
    await retryDataLoad();
    setRetrying(false);
  }, []);

  return (
    <MainWindow
      className={className}
      panelClassName="justify-center"
      title="Grill"
    >
      <Empty role="alert">
        <EmptyHeader>
          <EmptyTitle>
            <h1>Не удалось открыть данные</h1>
          </EmptyTitle>
          <EmptyDescription>
            {message ?? "Хранилище на этом компьютере не отвечает."}
          </EmptyDescription>
          <EmptyDescription>
            Если вы вернулись к старой версии Grill, обновите приложение. Копия
            данных до обновления лежит рядом с базой, в файле grill.db.bak-vN,
            где N — версия схемы до обновления.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button disabled={retrying} onClick={retry}>
            Повторить
          </Button>
        </EmptyContent>
      </Empty>
    </MainWindow>
  );
}
