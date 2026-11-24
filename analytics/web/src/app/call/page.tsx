import type { Metadata } from "next";
import { Suspense } from "react";

import { CallView } from "@/views/call";

export const metadata: Metadata = {
  title: "Grill, звонок",
};

export default function Page() {
  return (
    <Suspense>
      <CallView />
    </Suspense>
  );
}
