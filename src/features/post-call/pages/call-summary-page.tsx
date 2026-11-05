"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { toast } from "@/components/ui/toast";
import {
  useCallCards,
  useCallQuestions,
  useCallTranscript,
} from "@/data/call-records";
import { useCallSession } from "@/data/call-session";
import {
  type CallRecord,
  countPendingProposals,
  getCall,
  useCall,
} from "@/data/calls";
import {
  buildFinishingSummary,
  buildSummary,
  cancelSummary,
  useCallSummary,
} from "@/data/summaries";
import { inTauri } from "@/effect/runtime";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { KNOWLEDGE_TARGETS, PROPOSAL_GROUPS } from "../mock";
import { CallSummaryScreen } from "../screens/call-summary-screen";
import {
  cardsOverview,
  clockOf,
  failureReason,
  processingSteps,
  summaryChips,
  summaryTopics,
  topicTitles,
  unaskedQuestions,
} from "./call-data";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";

/*
 * /calls/summary?id=…: "02 Итоги звонка" of the call's summary
 * (`summary_get`). While its build runs — Rust starts it when the call is
 * finished and closes the call when it ends — the page shows "01 Сборка
 * итогов" at the stage of `SummaryProgress`, also after a reload, with
 * «Остановить»; then the summary and the "Итоги сохранены" toast. A
 * summary that was not built says why and offers «Собрать итоги» over
 * what the records still give: the questions, counters and cards.
 *
 * In the browser the mock plays the build on a timer and the page closes
 * the call when it ends, as Rust would. `?demo=processing` replays the
 * build there.
 */

const DEMO_STATES = ["processing"] as const;

const MB = 1_000_000;

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

/** «Звонок завершён в 12:41, длился 40:12». */
function finishedNote(call: CallRecord) {
  return call.endedAt === null
    ? `Звонок длился ${call.duration}`
    : `Звонок завершён в ${clockOf(call.endedAt)}, длился ${call.duration}`;
}

function SummaryOfCall({ call }: { call: CallRecord }) {
  const router = useRouter();
  const demo = useDemoState(DEMO_STATES);
  const session = useCallSession();
  const { building, summary } = useCallSummary(call.id);
  const recordings = useCallTranscript(call.id).data;
  const questions = useCallQuestions(call.id).data;
  const cards = useCallCards(call.id).data;

  const justFinished =
    session.status === "finishing" && session.callId === call.id;

  // The browser plays what Rust does: the build of a finishing call, then
  // the call closes. `?demo=processing` replays it once.
  const replayed = useRef(false);
  useEffect(() => {
    if (justFinished) {
      buildFinishingSummary(call.id);
    } else if (demo === "processing" && !inTauri && !replayed.current) {
      replayed.current = true;
      buildSummary(call.id);
    }
  }, [call.id, demo, justFinished]);

  const processing =
    building !== null || summary?.state === "building" || justFinished;

  // The build ended with a summary: "Итоги сохранены".
  const wasProcessing = useRef(processing);
  useEffect(() => {
    if (wasProcessing.current && !processing && summary?.state === "ready") {
      showSavedToast(call.id, router.push);
    }
    wasProcessing.current = processing;
  }, [call.id, processing, router.push, summary?.state]);

  const stop = useCallback(() => {
    cancelSummary(call.id);
  }, [call.id]);
  const rebuild = useCallback(() => {
    buildSummary(call.id);
  }, [call.id]);

  const steps = useMemo(
    () => processingSteps(building, call.projectId !== null),
    [building, call.projectId]
  );
  const facts = useMemo(() => {
    const bytes = recordings.reduce(
      (total, item) => total + (item.meBytes ?? 0) + (item.othersBytes ?? 0),
      0
    );
    const ended = call.endedAt === null ? "" : `–${clockOf(call.endedAt)}`;
    return [
      { label: "Когда", value: `${call.dateLabel}${ended}` },
      {
        label: "Участники",
        value: call.participants ? `${call.participants} и вы` : "вы",
      },
      {
        label: "Запись",
        value:
          bytes > 0
            ? `Opus, 2 канала, ${Math.max(1, Math.round(bytes / MB))} МБ`
            : "на этом компьютере",
      },
    ];
  }, [call, recordings]);

  const content = summary?.content ?? null;
  const titles = useMemo(() => topicTitles(summary, cards), [summary, cards]);
  const topics = useMemo(
    () => (content ? summaryTopics(content, recordings) : []),
    [content, recordings]
  );
  const tldr = useMemo(
    () =>
      content && summary
        ? {
            chips: summaryChips({
              live: summary.transcriptPass !== "refined",
              questions,
              topics: content.topics.length,
            }),
            text: summary.tldr,
          }
        : null,
    [content, questions, summary]
  );
  const unasked = useMemo(
    () => unaskedQuestions(questions, titles),
    [questions, titles]
  );
  const overview = useMemo(() => cardsOverview(cards.cards), [cards]);
  const failure = useMemo(
    () =>
      summary?.state === "failed"
        ? { onRebuild: rebuild, reason: failureReason(summary.error) }
        : null,
    [rebuild, summary]
  );
  const targets = useMemo(() => knowledgeTargets(call), [call]);

  return (
    <CallSummaryScreen
      callTitle={summary?.title || call.title || undefined}
      className={APP_WINDOW}
      clickUpAnswers={null}
      facts={facts}
      failure={failure}
      finishedNote={finishedNote(call)}
      knowledgeTargets={targets}
      onStop={building ? stop : undefined}
      pendingProposals={countPendingProposals(call)}
      state={processing ? "processing" : "ready"}
      steps={steps}
      taskCardOverview={overview}
      taskCards={cards.cards.length}
      tldr={tldr}
      topics={topics}
      unasked={unasked}
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
