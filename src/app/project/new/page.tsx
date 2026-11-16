import type { Metadata } from "next";
import { Suspense } from "react";

import { NewProjectPage } from "@/features/projects/pages/new-project-page";

export const metadata: Metadata = {
  title: "Grill, новый проект",
};

/** `/project/new`: the new project wizard. */
export default function Page() {
  return (
    <Suspense>
      <NewProjectPage />
    </Suspense>
  );
}
