import type { Metadata } from "next";

import { WelcomePage } from "@/features/onboarding/pages/welcome-page";

export const metadata: Metadata = {
  title: "Grill, настройка",
};

export default function Page() {
  return <WelcomePage />;
}
