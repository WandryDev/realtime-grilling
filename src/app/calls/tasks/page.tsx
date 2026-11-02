import type { Metadata } from "next";
import { Suspense } from "react";

import { TaskCardsPage } from "@/features/post-call/pages/task-cards-page";

export const metadata: Metadata = {
  title: "Grill, карточки задач",
};

// Task cards of a finished call: /calls/tasks?id=…
// The id is in the query string, read on the client under Suspense.
export default function Page() {
  return (
    <Suspense>
      <TaskCardsPage />
    </Suspense>
  );
}
