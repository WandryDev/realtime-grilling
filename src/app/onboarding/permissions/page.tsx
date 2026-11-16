import type { Metadata } from "next";
import { Suspense } from "react";

import { PermissionsPage } from "@/features/onboarding/pages/permissions-page";

export const metadata: Metadata = {
  title: "Grill, настройка: разрешения",
};

export default function Page() {
  return (
    <Suspense>
      <PermissionsPage />
    </Suspense>
  );
}
