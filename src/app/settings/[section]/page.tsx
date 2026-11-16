import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SETTINGS_SECTIONS } from "@/features/settings/mock";
import { SettingsPage } from "@/features/settings/pages/settings-page";
import {
  isSettingsSection,
  SETTINGS_ROUTE_SECTIONS,
  screenSection,
} from "@/features/settings/sections";

// The sections are a fixed set: each is prerendered, anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return SETTINGS_ROUTE_SECTIONS.map((section) => ({ section }));
}

interface SettingsRouteProps {
  params: Promise<{ section: string }>;
}

export async function generateMetadata({
  params,
}: SettingsRouteProps): Promise<Metadata> {
  const { section } = await params;
  const info = isSettingsSection(section)
    ? SETTINGS_SECTIONS.find((item) => item.id === screenSection(section))
    : undefined;
  return { title: info ? `Grill, ${info.title.toLowerCase()}` : "Grill" };
}

export default async function SettingsSectionPage({
  params,
}: SettingsRouteProps) {
  const { section } = await params;
  if (!isSettingsSection(section)) {
    notFound();
  }
  return (
    <Suspense>
      <SettingsPage section={section} />
    </Suspense>
  );
}
