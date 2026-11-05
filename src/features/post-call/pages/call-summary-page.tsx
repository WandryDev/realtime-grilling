"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { toast } from "@/components/ui/toast";
import { useCallSession } from "@/data/call-session";
import {
  type CallRecord,
  countPendingProposals,
  getCall,
  useCall,
} from "@/data/calls";
import { getProjects } from "@/data/projects";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { collectSummary, isCollectingSummary, processingSteps } from "../api";
import { KNOWLEDGE_TARGETS, PROPOSAL_GROUPS } from "../mock";
import { CallSummaryScreen } from "../screens/call-summary-screen";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";

/*
 * /calls/summary?id=…: "02 Итоги звонка". A call that has just ended
 * (the call session is "finishing") first shows "01 Сборка итогов" while
 * the agent builds the summary, then the summary and the "Итоги сохранены"
 * toast. `?demo=processing` replays the build for any call.
 */

const DEMO_STATES = ["processing"] as const;

/** Pending proposals per brief or person, for the right column. */
function knowledgeTargets(call: CallRecord) {
  return KNOWLEDGE_TARGETS.map((target) => {
    const group = PROPOSAL_GROUPS.find((item) => item.id === target.id);
    const count =
      group?.proposals.filter(
        (proposal) => call.proposals[proposal.id]?.decision === "pending"
      ).length ?? 0;
    return { ...target, count };
  });
}

function showSavedToast(callId: string, openHistory: (href: string) => void) {
  const projectId = getCall(callId)?.projectId;
  toast.add({
    actionProps: {
      children: "Открыть историю",
      onClick: () => openHistory(routes.history(projectId ?? undefined)),
    },
    description: "на этом компьютере, вместе с записью",
    timeout: 5000,
    title: "Итоги сохранены",
    type: "success",
  });
}

function SummaryOfCall({ call }: { call: CallRecord }) {
  const router = useRouter();
  const demo = useDemoState(DEMO_STATES);
  const session = useCallSession();
  const [replayed, setReplayed] = useState(false);

  const justFinished =
    session.status === "finishing" && session.callId === call.id;
  const wantsBuild = justFinished || (demo === "processing" && !replayed);

  const {
    participants: sessionPeople,
    projectId: sessionProject,
    recordingId: sessionRecording,
  } = session;
  useEffect(() => {
    if (!wantsBuild || call.summary !== "ready") {
      return;
    }
    if (isCollectingSummary(call.id)) {
      return;
    }
    // The call widget picked the project and the people of this call
    const knownProject = getProjects().some(
      (project) => project.id === sessionProject
    );
    collectSummary(call.id, {
      onDone: () => {
        setReplayed(true);
        showSavedToast(call.id, router.push);
      },
      patch: justFinished
        ? {
            participants:
              sessionPeople.length > 0
                ? sessionPeople.join(", ")
                : call.participants,
            projectId:
              knownProject && sessionProject ? sessionProject : call.projectId,
          }
        : undefined,
      recordingId: justFinished ? sessionRecording : undefined,
    });
  }, [
    call.id,
    call.participants,
    call.projectId,
    call.summary,
    justFinished,
    router.push,
    sessionPeople,
    sessionProject,
    sessionRecording,
    wantsBuild,
  ]);

  const processing = call.summary === "processing" || wantsBuild;
  const progress = call.summaryProgress ?? { progress: 0, step: 0 };
  const steps = useMemo(
    () =>
      processingSteps(progress.step, progress.progress, progress.transcript),
    [progress.step, progress.progress, progress.transcript]
  );
  const targets = useMemo(() => knowledgeTargets(call), [call]);

  return (
    <CallSummaryScreen
      className={APP_WINDOW}
      knowledgeTargets={targets}
      pendingProposals={countPendingProposals(call)}
      state={processing ? "processing" : "ready"}
      steps={steps}
    />
  );
}

export function CallSummaryPage() {
  const params = useSearchParams();
  const call = useCall(params.get("id"));

  return (
    <CallPageFrame call={call}>
      {call ? <SummaryOfCall call={call} /> : null}
    </CallPageFrame>
  );
}
