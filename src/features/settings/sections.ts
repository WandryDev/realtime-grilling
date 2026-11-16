import { routes, type SettingsSection } from "@/lib/routes";

import type { SettingsSectionId } from "./mock";

/*
 * The screens name the "Виджет и клавиши" section `widget`, the URL calls it
 * `shortcuts` (/settings/shortcuts). Everything else matches one to one.
 */

const ROUTE_TO_SCREEN: Record<SettingsSection, SettingsSectionId> = {
  agent: "agent",
  audio: "audio",
  general: "general",
  integrations: "integrations",
  privacy: "privacy",
  shortcuts: "widget",
};

/** Every settings URL segment, for generateStaticParams. */
export const SETTINGS_ROUTE_SECTIONS = Object.keys(
  ROUTE_TO_SCREEN
) as SettingsSection[];

export function isSettingsSection(value: string): value is SettingsSection {
  return value in ROUTE_TO_SCREEN;
}

export function screenSection(section: SettingsSection): SettingsSectionId {
  return ROUTE_TO_SCREEN[section];
}

/** Link to a section of the settings screens. */
export function settingsSectionHref(id: SettingsSectionId) {
  return routes.settings(id === "widget" ? "shortcuts" : id);
}
