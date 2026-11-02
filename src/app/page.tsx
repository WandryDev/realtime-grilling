import type { Metadata } from "next";
import { Suspense } from "react";

import { HomePage } from "@/features/projects/pages/home-page";

export const metadata: Metadata = {
  title: "Grill",
};

/** Home: the projects, or onboarding until it is done. */
export default function Page() {
  return (
    <Suspense>
      <HomePage />
    </Suspense>
  );
}
