import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SERVICE_NAMES } from "@/features/onboarding/integrations/mock";
import { ServiceConnectPage } from "@/features/onboarding/integrations/pages/service-connect-page";
import type { IntegrationService } from "@/lib/routes";

/*
 * One static page per service: the export can't serve other values, so
 * anything else is a 404.
 */

const SERVICES = [
  "github",
  "outline",
  "clickup",
] as const satisfies readonly IntegrationService[];

function isService(value: string): value is IntegrationService {
  return (SERVICES as readonly string[]).includes(value);
}

interface Props {
  params: Promise<{ service: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return SERVICES.map((service) => ({ service }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { service } = await params;
  return {
    title: isService(service)
      ? `Подключение ${SERVICE_NAMES[service]} — настройка Grill`
      : "Настройка Grill",
  };
}

export default async function Page({ params }: Props) {
  const { service } = await params;
  if (!isService(service)) {
    notFound();
  }
  return (
    <Suspense>
      <ServiceConnectPage service={service} />
    </Suspense>
  );
}
