"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { CallRecording } from "@/bindings";
import { toast } from "@/components/ui/toast";
import {
  useCallCards,
  useCallQuestions,
  useCallTranscript,
} from "@/data/call-records";
import { useCallSession } from "@/data/call-session";
import {
  type CallRecord,
  getCall,
  NO_PROJECT_CALL,
  useCall,
} from "@/data/calls";
import { usePeople } from "@/data/people";
import { useProject } from "@/data/projects";
import { countPending, useCallProposals } from "@/data/proposals";
import {
  buildFinishingSummary,
  buildSummary,
  cancelSummary,
  useCallSummary,
} from "@/data/summaries";
import { inTauri } from "@/effect/runtime";
import { clockTime } from "@/lib/clock";
import { plural } from "@/lib/plural";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { CallSummaryScreen } from "../screens/call-summary-screen";
import {
  cardsOverview,
  failureReason,
  processingSteps,
  summaryChips,
  summaryTopics,
  topicTitles,
  unaskedQuestions,
} from "./call-data";
import { APP_WINDOW, CallPageFrame } from "./call-page-frame";
import { knowledgeTargets } from "./proposal-data";

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

/** «Opus, 2 канала, 13 МБ», «аудио удалено». */
function recordingFact(recordings: readonly CallRecording[], bytes: number) {
  if (recordings.length > 0 && recordings.every((item) => item.audioDeleted)) {
    return "аудио удалено";
  }
  if (bytes === 0) {
    return "на этом компьютере";
  }
  const channels = Math.max(
    ...recordings.map(
      (item) =>
        Number(item.meBytes !== null) + Number(item.othersBytes !== null)
    )
  );
  return `Opus, ${channels} ${plural(channels, "канал", "канала", "каналов")}, ${Math.max(1, Math.round(bytes / MB))} МБ`;
}

/** «Звонок завершён в 12:41, длился 40:12». */
function finishedNote(call: CallRecord) {
  return call.endedAt === null
    ? `Звонок длился ${call.duration}`
    : `Звонок завершён в ${clockTime(call.endedAt, false)}, длился ${call.duration}`;
}

function SummaryOfCall({ call }: { call: CallRecord }) {
  const router = useRouter();
  const demo = useDemoState(DEMO_STATES);
  const session = useCallSession();
  const { building, summary } = useCallSummary(call.id);
  const recordings = useCallTranscript(call.id).data;
  const questions = useCallQuestions(call.id).data;
  const cards = useCallCards(call.id).data;
  const proposals = useCallProposals(call.id).data;
  const people = usePeople(call.projectId);
  const project = useProject(call.projectId);

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
    const ended =
      call.endedAt === null ? "" : `–${clockTime(call.endedAt, false)}`;
    return [
      { label: "Когда", value: `${call.dateLabel}${ended}` },
      {
        label: "Участники",
        value: call.participants ? `${call.participants} и вы` : "вы",
      },
      { label: "Запись", value: recordingFact(recordings, bytes) },
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
  const targets = useMemo(
    () => knowledgeTargets(proposals, people),
    [people, proposals]
  );

  return (
    <CallSummaryScreen
      callTitle={
        summary?.title.trim() ||
        call.title.trim() ||
        content?.topics[0]?.title.trim() ||
        (call.projectId === null ? NO_PROJECT_CALL : project?.name) ||
        undefined
      }
      className={APP_WINDOW}
      clickUpAnswers={null}
      facts={facts}
      failure={failure}
      finishedNote={finishedNote(call)}
      knowledgeTargets={targets}
      onStop={building ? stop : undefined}
      pendingProposals={countPending(proposals)}
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
