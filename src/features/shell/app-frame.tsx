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
import {
  followCallSession,
  useCallSession,
  useCallSessionLoaded,
} from "@/data/call-session";
import { retryDataLoad, useDataLoad } from "@/data/status";
import { UpdateToast } from "@/features/updates/update-toast";
import { routes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { currentWindowLabel, MAIN_WINDOW } from "@/lib/window-label";

import { reopenStorage, subscribeToNavigate } from "./api";
import { MainWindow } from "./main-window";
import { ThemeSync } from "./theme-sync";

/*
 * Around every page of every window:
 * - the window follows the «Тема» setting (ThemeSync);
 * - in Tauri, the window follows the backend's call in progress;
 * - the main window opens the routes Rust and the other windows ask for
 *   (the tray's "Настройки", the call window when a call is finishing). It
 *   is told by its window label, whatever route it shows. While a call is
 *   finishing (after a reload, or a route away), it goes back to the call
 *   window itself, which shows the summary build Rust runs;
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
      <ThemeSync />
      {mainWindow ? <NavigateListener /> : null}
      {mainWindow ? <UpdateToast /> : null}
      {isMainWindowRoute(pathname) ? (
        <MainWindowFrame>{children}</MainWindowFrame>
      ) : (
        children
      )}
    </>
  );
}

/** Where the summary of a finishing call is built, or shown. */
const SUMMARY_ROUTES = [routes.call(), "/calls/summary"];

/**
 * Opens the routes Rust (or another window) sends to this window. While a
 * call is finishing the main window stays where its summary is built: a
 * reload, or the tray's «Настройки» meanwhile, brings it back to the call
 * window, which follows the build and opens the summary when it ends.
 */
function NavigateListener() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => subscribeToNavigate((route) => router.push(route)), [router]);

  const { status } = useCallSession();
  const loaded = useCallSessionLoaded();
  useEffect(() => {
    if (
      loaded &&
      status === "finishing" &&
      !SUMMARY_ROUTES.includes(pathname)
    ) {
      router.push(routes.call());
    }
  }, [loaded, pathname, router, status]);
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
    <MainWindow className={className} panelClassName="justify-center">
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
