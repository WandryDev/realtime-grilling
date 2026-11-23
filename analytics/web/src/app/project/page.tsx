import type { Metadata } from "next";
import { Suspense } from "react";

import { ProjectView } from "@/views/project";

export const metadata: Metadata = {
  title: "Grill, проект",
};

export default function Page() {
  return (
    <Suspense>
      <ProjectView />
    </Suspense>
  );
}
