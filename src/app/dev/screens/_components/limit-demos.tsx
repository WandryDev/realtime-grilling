"use client";

import type { LimitOutlook } from "@/bindings";
import { grillLimitDetail } from "@/features/post-call/pages/call-data";
import { CallSummaryScreen } from "@/features/post-call/screens/call-summary-screen";
import { BriefLimitNotice } from "@/features/projects/components/brief-limit-notice";
import { ProjectScreen } from "@/features/projects/screens/project-screen";

/*
 * The screens of the thresholds of Grill (agent-limit-guard) for the /dev
 * catalog. Client components: their buttons need a handler, which a
 * server page can't pass.
 */

/** The catalog builds nothing. */
function buildNothing() {
  // A preview only.
}

/** The session past its threshold: it resets at 14:09. */
const SESSION_REACHED: LimitOutlook = {
  hit: {
    resetsAt: new Date(2026, 10, 24, 14, 9).getTime(),
    threshold: 90,
    used: 93,
    window: "session",
  },
  kind: "reached",
};

/** The week past its threshold: it resets on 1 December. */
const WEEK_REACHED: LimitOutlook = {
  hit: {
    resetsAt: new Date(2026, 11, 1, 0, 59).getTime(),
    threshold: 80,
    used: 85,
    window: "week",
  },
  kind: "reached",
};

/** «Итоги не собраны: достигнут лимит Grill». */
export function SummaryGrillLimitDemo({ className }: { className?: string }) {
  return (
    <CallSummaryScreen
      className={className}
      failure={{
        detail: grillLimitDetail(SESSION_REACHED),
        onRebuild: buildNothing,
        reason: "достигнут лимит Grill",
        rebuildLabel: "Собрать сверх лимита",
      }}
    />
  );
}

/** «Бриф не собран: достигнут лимит Grill» on the project page. */
export function ProjectGrillLimitDemo({ className }: { className?: string }) {
  return (
    <ProjectScreen
      briefNotice={
        <BriefLimitNotice onOverLimit={buildNothing} outlook={WEEK_REACHED} />
      }
      briefState="outdated"
      className={className}
      proposals={null}
    />
  );
}
