import type { Metadata } from "next";
import { Suspense } from "react";

import { StartWidgetPage } from "@/features/call-widget/pages/start-widget-page";

export const metadata: Metadata = {
  title: "Grill, виджет старта",
};

export default function Page() {
  return (
    <Suspense>
      <StartWidgetPage />
    </Suspense>
  );
}
