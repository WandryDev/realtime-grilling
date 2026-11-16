import type { Metadata } from "next";
import { Suspense } from "react";

import { HistoryPage } from "@/features/post-call/pages/history-page";

export const metadata: Metadata = {
  title: "Grill, звонки",
};

// The calls of every project, or of one: /history?project=…
// The id is in the query string, read on the client under Suspense.
export default function Page() {
  return (
    <Suspense>
      <HistoryPage />
    </Suspense>
  );
}
