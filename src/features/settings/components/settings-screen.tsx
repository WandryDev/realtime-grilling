import type { ReactNode } from "react";

import { MainWindow, TitlebarSearch } from "@/features/shell/main-window";
import { cn } from "@/lib/utils";

import { SETTINGS_SECTIONS, type SettingsSectionId } from "../mock";
import { SettingsSidebar } from "./settings-sidebar";

/** Page title block: 28px title and a muted line under it. */
export function SettingsPageHeader({
  className,
  description,
  title,
}: {
  className?: string;
  description: ReactNode;
  title: ReactNode;
}) {
  return (
    <header className={cn("flex flex-col gap-1.5", className)}>
      <h1 className="text-2xl font-semibold tracking-tight text-balance">
        {title}
      </h1>
      <p className="text-muted-foreground text-base">{description}</p>
    </header>
  );
}

/*
 * A settings section in the main window, titled "Настройки": the sidebar
 * turns into the settings menu (SettingsSidebar) and the page is a 720
 * column centered in the panel, with smaller margins on a narrow panel. Page
 * title and description come from the section.
 */
export function SettingsScreen({
  alerts,
  children,
  className,
  overlay,
  section,
  status,
}: {
  /** Sections with a red dot in the menu. */
  alerts?: SettingsSectionId[];
  children: ReactNode;
  className?: string;
  /** Dialogs and toasts over the window, positioned by the caller. */
  overlay?: ReactNode;
  section: SettingsSectionId;
  /** The status at the bottom of the sidebar (the agent's by default). */
  status?: ReactNode;
}) {
  const info =
    SETTINGS_SECTIONS.find((item) => item.id === section) ??
    SETTINGS_SECTIONS[0];
  return (
    <MainWindow
      actions={<TitlebarSearch />}
      className={className}
      overlay={overlay}
      sidebar={
        <SettingsSidebar active={section} alerts={alerts} status={status} />
      }
    >
      <main className="flex flex-col items-center px-6 pt-8 pb-10 @3xl/panel:px-12 @3xl/panel:pt-12 @3xl/panel:pb-16">
        <div className="max-w-content flex w-full flex-col">
          <SettingsPageHeader
            className="pb-6"
            description={info.description}
            title={info.title}
          />
          {children}
        </div>
      </main>
    </MainWindow>
  );
}
