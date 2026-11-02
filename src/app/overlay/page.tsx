import type { Metadata } from "next";
import { Suspense } from "react";

import { OverlayPage } from "@/features/call-widget/pages/overlay-page";

export const metadata: Metadata = {
  title: "Grill, оверлей звонка",
};

export default function Page() {
  return (
    <Suspense>
      <OverlayPage />
    </Suspense>
  );
}
