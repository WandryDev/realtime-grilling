import type { Metadata } from "next";
import { Suspense } from "react";

import { CallSummaryPage } from "@/features/post-call/pages/call-summary-page";

export const metadata: Metadata = {
  title: "Grill, итоги звонка",
};

// Summary of a finished call: /calls/summary?id=…
// The id is in the query string, read on the client under Suspense.
export default function Page() {
  return (
    <Suspense>
      <CallSummaryPage />
    </Suspense>
  );
}
