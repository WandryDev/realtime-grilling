"use client";

import { Appear, AppearScope } from "@/components/ui/appear";

import { CallActionsProvider } from "../call-actions";
import { FinishingCard, MicReleasedPanel } from "../components/call-overlays";
import { CallQuestions } from "../components/call-questions";
import { CallTitlebar, CallWindow } from "../components/call-window";
import { ContextColumn, ContextItemView } from "../components/context-column";
import {
  TranscriptColumn,
  TranscriptItems,
  TranscriptNotice,
  TranscriptUnavailable,
} from "../components/transcript";
import { TranscriptRail } from "../components/transcript-rail";
import { CALL_SCREENS } from "../mock";
import type {
  CallScreenActions,
  CallScreenData,
  CallScreenState,
} from "../types";

const NO_ACTIONS: CallScreenActions = {};

/*
 * The call window (Paper "Звонок", 1440 wide). One layout for every state:
 * `state` picks the demo data, `data` replaces it. `actions` makes the
 * buttons do something (the live window); keep it memoized.
 *
 *   <CallScreen className="size-full" state="final-check" />
 *
 * What is on the screen when it opens stays still; questions, findings and
 * panels that arrive later play their entrance (AppearScope).
 */
export function CallScreen({
  actions = NO_ACTIONS,
  className,
  data,
  state = "reference",
}: {
  actions?: CallScreenActions;
  className?: string;
  data?: CallScreenData;
  state?: CallScreenState;
}) {
  const { call, context, finishing, micReleased, questions, transcript } =
    data ?? CALL_SCREENS[state];

  return (
    <CallActionsProvider actions={actions}>
      <AppearScope>
        <CallWindow
          className={className}
          context={
            <ContextColumn description={context.description}>
              {context.items.map((item) => (
                // Inserted at the top: drops in, the cards below slide down
                <Appear key={item.id} motion="drop">
                  <ContextItemView item={item} />
                </Appear>
              ))}
            </ContextColumn>
          }
          dimmed={Boolean(finishing)}
          overlay={
            <>
              {micReleased ? (
                <MicReleasedPanel
                  className="absolute bottom-8 left-1/2 -translate-x-1/2"
                  panel={micReleased}
                />
              ) : null}
              {finishing ? (
                <FinishingCard
                  className="absolute top-[250px] left-1/2 -translate-x-1/2"
                  finishing={finishing}
                />
              ) : null}
            </>
          }
          questions={<CallQuestions questions={questions} />}
          titlebar={<CallTitlebar call={call} />}
          transcript={
            transcript.collapsed ? (
              <TranscriptRail speaker={railSpeaker(transcript.items)} />
            ) : (
              <TranscriptColumn scrollKey={transcript.items.length}>
                {transcript.unavailable ? (
                  <TranscriptUnavailable unavailable={transcript.unavailable} />
                ) : null}
                {transcript.notice ? (
                  <TranscriptNotice notice={transcript.notice} />
                ) : null}
                <TranscriptItems items={transcript.items} />
              </TranscriptColumn>
            )
          }
        />
      </AppearScope>
    </CallActionsProvider>
  );
}

/** Who the collapsed rail shows as speaking: the last phrase, if still live. */
function railSpeaker(items: CallScreenData["transcript"]["items"]) {
  const last = items.at(-1);
  if (last?.kind === "client" && last.live) {
    return "client";
  }
  return last?.kind === "missing" ? "client" : null;
}
