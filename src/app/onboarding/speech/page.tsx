import type { Metadata } from "next";
import { Suspense } from "react";

import { SpeechPage } from "@/features/onboarding/pages/speech-page";

export const metadata: Metadata = {
  title: "Grill, настройка: распознавание речи",
};

export default function Page() {
  return (
    <Suspense>
      <SpeechPage />
    </Suspense>
  );
}
