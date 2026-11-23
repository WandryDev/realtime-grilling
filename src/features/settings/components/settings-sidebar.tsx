import { NavItemLabel, NavMenu } from "@grill/ui/nav-item";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import {
  AppSidebar,
  DefaultSidebarStatus,
  SidebarGroup,
  SidebarItem,
} from "@/features/shell/app-sidebar";
import { SettingsIcon } from "@/features/shell/icons";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import {
  BackIcon,
  IntegrationsIcon,
  KeyboardIcon,
  LockIcon,
  SoundIcon,
  TerminalIcon,
} from "../icons";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../mock";
import { settingsSectionHref } from "../sections";

const SECTION_ICONS: Record<
  SettingsSectionId,
  ComponentType<ComponentProps<"svg">>
> = {
  agent: TerminalIcon,
  audio: SoundIcon,
  general: SettingsIcon,
  integrations: IntegrationsIcon,
  privacy: LockIcon,
  widget: KeyboardIcon,
};

/** Red 6px dot after a section that needs attention. */
export function SectionAlertDot({ className }: { className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center", className)}>
      <span
        aria-hidden="true"
        className="bg-contradiction size-1.5 rounded-full"
      />
      <span className="sr-only">, требует внимания</span>
    </span>
  );
}

/*
 * Sidebar of the settings: "К проектам" back to the main sidebar, the
 * section list, the agent status at the bottom. Sections in
 * `alerts` get a red dot.
 */
export function SettingsSidebar({
  active,
  alerts = [],
  className,
  status = <DefaultSidebarStatus />,
}: {
  active: SettingsSectionId;
  alerts?: SettingsSectionId[];
  className?: string;
  status?: ReactNode;
}) {
  return (
    <AppSidebar className={className}>
      <div className="flex flex-col gap-0.5">
        <SidebarItem href={routes.home()}>
          <BackIcon />
          <NavItemLabel>К проектам</NavItemLabel>
        </SidebarItem>
        <SidebarGroup className="pt-5" title="Настройки">
          <NavMenu aria-label="Разделы настроек">
            {SETTINGS_SECTIONS.map((section) => {
              const SectionIcon = SECTION_ICONS[section.id];
              return (
                <SidebarItem
                  active={section.id === active}
                  href={settingsSectionHref(section.id)}
                  key={section.id}
                >
                  <SectionIcon />
                  <NavItemLabel>{section.label}</NavItemLabel>
                  {alerts.includes(section.id) ? <SectionAlertDot /> : null}
                </SidebarItem>
              );
            })}
          </NavMenu>
        </SidebarGroup>
      </div>
      {status}
    </AppSidebar>
  );
}
