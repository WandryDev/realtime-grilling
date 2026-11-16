import type { Metadata } from "next";
import { Suspense } from "react";

import { CallPage } from "@/features/call/pages/call-page";

export const metadata: Metadata = {
  title: "Grill, звонок",
};

export default function Page() {
  return (
    <Suspense>
      <CallPage />
    </Suspense>
  );
}
