import type { Metadata } from "next";
import { Suspense } from "react";

import { PersonPage } from "@/features/projects/pages/person-page";

export const metadata: Metadata = {
  title: "Grill, человек",
};

/** `/project/person?project=&id=`: a person of the client. */
export default function Page() {
  return (
    <Suspense>
      <PersonPage />
    </Suspense>
  );
}
