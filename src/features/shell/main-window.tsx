import type { ComponentProps, ReactNode } from "react";

import {
  AppWindow,
  AppWindowBody,
  AppWindowPanel,
} from "@/components/ui/app-window";
import {
  WindowTitlebar,
  WindowTitlebarEnd,
  WindowTitlebarStart,
} from "@/components/ui/window-titlebar";
import { cn } from "@/lib/utils";

import { SearchIcon } from "./icons";
import { WindowChromeEnd, WindowChromeStart } from "./window-chrome";

/*
 * The main window: gray window with the title bar, an optional sidebar and
 * the white panel. The panel scrolls, the sidebar and title bar stay put.
 *
 *   <MainWindow actions={<TitlebarSearch />}
 *     sidebar={<MainSidebar active="home" />}>
 *     <PageContent>…</PageContent>
 *   </MainWindow>
 *
 * Size comes from the call site: `h-svh` in the app, the artboard size in
 * /dev/screens.
 */
export function MainWindow({
  actions,
  aside,
  children,
  className,
  overlay,
  panelClassName,
  sidebar,
}: {
  /** Right side of the title bar. */
  actions?: ReactNode;
  /** Column on the gray right of the panel (call screens). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Dialogs and toasts drawn over the window, positioned by the caller. */
  overlay?: ReactNode;
  panelClassName?: string;
  sidebar?: ReactNode;
}) {
  return (
    <AppWindow className={cn("relative", className)}>
      <WindowTitlebar>
        <WindowTitlebarStart>
          <WindowChromeStart />
        </WindowTitlebarStart>
        <WindowTitlebarEnd>
          {actions}
          <WindowChromeEnd />
        </WindowTitlebarEnd>
      </WindowTitlebar>
      <AppWindowBody>
        {sidebar}
        <AppWindowPanel
          className={cn("overflow-x-clip overflow-y-auto", panelClassName)}
        >
          {children}
        </AppWindowPanel>
        {aside}
      </AppWindowBody>
      {overlay}
    </AppWindow>
  );
}

/** Search pill in the title bar, opens the command palette. */
export function TitlebarSearch({
  className,
  label = "Поиск по проектам и звонкам",
  ...props
}: ComponentProps<"button"> & { label?: string }) {
  return (
    <button
      className={cn(
        "bg-background text-muted-foreground hover:text-foreground focus-visible:focus-ring flex h-8 items-center gap-2 rounded-full px-3 transition-colors",
        className
      )}
      type="button"
      {...props}
    >
      <SearchIcon className="size-3.5 shrink-0" />
      <span className="text-sm">{label}</span>
      <kbd className="font-mono text-xs">⌘K</kbd>
    </button>
  );
}

/** Page padding inside the panel: 40 top, 48 sides and bottom. */
export function PageContent({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      className={cn("flex flex-col gap-10 px-12 pt-10 pb-12", className)}
      {...props}
    />
  );
}

/** Page title block: optional eyebrow, a 28px title, actions on the right. */
export function PageHeader({
  actions,
  className,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  className?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}) {
  return (
    <header className={cn("flex items-end justify-between gap-6", className)}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? (
          <p className="text-muted-foreground text-base">{eyebrow}</p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground text-base">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
