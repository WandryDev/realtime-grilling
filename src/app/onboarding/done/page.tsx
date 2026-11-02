import type { Metadata } from "next";
import { Suspense } from "react";

import { DonePage } from "@/features/onboarding/integrations/pages/done-page";

export const metadata: Metadata = {
  title: "Готово — настройка Grill",
};

export default function Page() {
  return (
    <Suspense>
      <DonePage />
    </Suspense>
  );
}
