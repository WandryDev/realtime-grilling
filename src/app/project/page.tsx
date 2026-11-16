import type { Metadata } from "next";
import { Suspense } from "react";

import { ProjectPage } from "@/features/projects/pages/project-page";

export const metadata: Metadata = {
  title: "Grill, проект",
};

/** `/project?id=`: the brief, people, calls and sources of a project. */
export default function Page() {
  return (
    <Suspense>
      <ProjectPage />
    </Suspense>
  );
}
