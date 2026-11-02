import type { Metadata } from "next";
import { Suspense } from "react";

import { ProposalsPage } from "@/features/post-call/pages/proposals-page";

export const metadata: Metadata = {
  title: "Grill, предложения",
};

// Review of the agent's proposals: /calls/proposals?id=…
// The id is in the query string, read on the client under Suspense.
export default function Page() {
  return (
    <Suspense>
      <ProposalsPage />
    </Suspense>
  );
}
