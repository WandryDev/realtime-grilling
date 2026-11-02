import type { Metadata } from "next";
import { Suspense } from "react";

import { IntegrationsPage } from "@/features/onboarding/integrations/pages/integrations-page";

export const metadata: Metadata = {
  title: "Интеграции — настройка Grill",
};

export default function Page() {
  return (
    <Suspense>
      <IntegrationsPage />
    </Suspense>
  );
}
