import type { Metadata } from "next";
import { Suspense } from "react";

import { AgentPage } from "@/features/onboarding/pages/agent-page";

export const metadata: Metadata = {
  title: "Grill, настройка: агент",
};

export default function Page() {
  return (
    <Suspense>
      <AgentPage />
    </Suspense>
  );
}
