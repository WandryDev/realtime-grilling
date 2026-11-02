import type { Metadata } from "next";
import { Suspense } from "react";

import { TranscriptPage } from "@/features/post-call/pages/transcript-page";

export const metadata: Metadata = {
  title: "Grill, расшифровка",
};

// Transcript and recording: /calls/transcript?id=…&moment=…
// The id is in the query string, read on the client under Suspense.
export default function Page() {
  return (
    <Suspense>
      <TranscriptPage />
    </Suspense>
  );
}
