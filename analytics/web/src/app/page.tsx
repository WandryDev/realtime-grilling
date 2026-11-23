import type { Metadata } from "next";
import { Suspense } from "react";

import { ProjectsView } from "@/views/projects";

export const metadata: Metadata = {
  title: "Grill, аналитика",
};

export default function Page() {
  return (
    <Suspense>
      <ProjectsView />
    </Suspense>
  );
}
