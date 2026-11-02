import Link from "next/link";
import type { ReactNode } from "react";

import { NavItem, NavItemLabel, NavMenu } from "@/components/ui/nav-item";
import { MainSidebar } from "@/features/shell/app-sidebar";
import { MainWindow, TitlebarSearch } from "@/features/shell/main-window";
import { cn } from "@/lib/utils";

import { PANEL_NAV, SETTINGS_SECTIONS, type SettingsSectionId } from "../mock";
import { settingsSectionHref } from "../sections";
import { SectionAlertDot, SettingsSidebar } from "./settings-sidebar";

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

/** Section menu inside the white panel, left of the page (integrations). */
export function SettingsPanelNav({
  active,
  alerts = [],
  className,
}: {
  active: SettingsSectionId;
  alerts?: SettingsSectionId[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-66 shrink-0 flex-col gap-0.5 pt-10 pr-4 pb-6 pl-6",
        className
      )}
    >
      <p className="text-muted-foreground px-3 pb-2 text-xs font-medium">
        Настройки
      </p>
      <NavMenu aria-label="Разделы настроек">
        {PANEL_NAV.map((item) => (
          <NavItem
            active={item.id === active}
            className="data-active:bg-surface px-3 data-active:shadow-none"
            key={item.id}
            render={<Link href={settingsSectionHref(item.id)} />}
          >
            <NavItemLabel>{item.label}</NavItemLabel>
            {alerts.includes(item.id) ? <SectionAlertDot /> : null}
          </NavItem>
        ))}
      </NavMenu>
    </div>
  );
}

/*
 * A settings section in the main window, titled "Настройки".
 * - navigation="sidebar": the sidebar turns into the settings menu
 *   (SettingsSidebar) and the page is a 720 column centered in the panel.
 * - navigation="panel": the main sidebar stays with "Настройки" active, the
 *   section menu sits inside the panel and the page is 760 wide next to it
 *   (the integrations screens).
 * Page title and description come from the section.
 */
export function SettingsScreen({
  alerts,
  children,
  className,
  navigation = "sidebar",
  overlay,
  section,
  status,
}: {
  /** Sections with a red dot in the menu. */
  alerts?: SettingsSectionId[];
  children: ReactNode;
  className?: string;
  navigation?: "sidebar" | "panel";
  /** Dialogs and toasts over the window, positioned by the caller. */
  overlay?: ReactNode;
  section: SettingsSectionId;
  /** Agent and recording status at the bottom of the sidebar. */
  status?: ReactNode;
}) {
  const info =
    SETTINGS_SECTIONS.find((item) => item.id === section) ??
    SETTINGS_SECTIONS[0];
  if (navigation === "panel") {
    return (
      <MainWindow
        actions={<TitlebarSearch />}
        className={className}
        overlay={overlay}
        panelClassName="flex-row"
        sidebar={<MainSidebar active="settings" status={status} />}
        title="Настройки"
      >
        <SettingsPanelNav active={section} alerts={alerts} />
        <main className="flex w-190 shrink-0 flex-col gap-9 pt-10 pb-12 pl-10">
          <SettingsPageHeader
            className="*:last:max-w-155"
            description={info.description}
            title={info.title}
          />
          {children}
        </main>
      </MainWindow>
    );
  }

  return (
    <MainWindow
      actions={<TitlebarSearch />}
      className={className}
      overlay={overlay}
      sidebar={
        <SettingsSidebar active={section} alerts={alerts} status={status} />
      }
      title="Настройки"
    >
      <main className="flex flex-col items-center px-12 pt-12 pb-16">
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
