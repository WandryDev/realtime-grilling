"use client";

import { type ReactNode, useCallback } from "react";

import { MessageGroup } from "@/components/ui/message";
import { TopicDivider } from "@/components/ui/topic-divider";

import { CallWindow, SideColumn } from "../components/call-window";
import { FilterTabs, SearchField } from "../components/history";
import { usePostCallInfo } from "../components/links";
import {
  AudioPlayer,
  CallQuestionList,
  DeleteRecordingDialog,
  MomentHighlight,
  type PlayerChannel,
  type PlayerSpeed,
  RecordingCard,
  TranscriptTurn,
} from "../components/transcript";
import {
  CALL_QUESTIONS,
  RECORDING,
  TRANSCRIPT_TOPICS,
  TRANSCRIPT_TURNS,
  type TranscriptSection,
  type TranscriptTurnData,
} from "../mock";
import { resolveMoment, type TranscriptMoment } from "../moment";

/*
 * "06 Детали звонка": the transcript with the player. `momentId` is a
 * question from the right column: the transcript highlights the moment it
 * was asked and the player stands there. `dialog="delete-recording"` is
 * "07 Мини-флоу — удаление записи" (the player pauses under the dialog).
 *
 * The app passes the whole transcript (`sections`), a resolved `moment`,
 * the live player and the handlers; /dev shows the second topic only.
 */

const PREVIEW_TOPIC = TRANSCRIPT_TOPICS.at(-1) ?? {
  id: "crm",
  time: "12:21",
  title: "Интеграция с CRM",
};

const PREVIEW_SECTIONS: TranscriptSection[] = [
  { topic: PREVIEW_TOPIC, turns: TRANSCRIPT_TURNS },
];

/** Id of the highlighted block, the app scrolls to it. */
export const MOMENT_ELEMENT_ID = "transcript-moment";

export interface PlayerState {
  channel: PlayerChannel;
  onChannelChange: (channel: PlayerChannel) => void;
  onSpeedChange: (speed: PlayerSpeed) => void;
  onTogglePlay: () => void;
  playing: boolean;
  position: string;
  speed: PlayerSpeed;
}

/** Turns of a topic, the moment's phrases wrapped in the orange block. */
function SectionTurns({
  moment,
  turns,
}: {
  moment?: TranscriptMoment;
  turns: TranscriptTurnData[];
}) {
  const highlighted = new Set(moment?.turnIds ?? []);
  const blocks: ReactNode[] = [];
  let run: TranscriptTurnData[] = [];

  const flush = () => {
    const [first] = run;
    if (moment && first) {
      blocks.push(
        <MomentHighlight
          id={MOMENT_ELEMENT_ID}
          key={`moment-${first.id}`}
          label={moment.label}
        >
          {run.map((turn) => (
            <TranscriptTurn key={turn.id} turn={turn} />
          ))}
        </MomentHighlight>
      );
    }
    run = [];
  };

  for (const turn of turns) {
    if (highlighted.has(turn.id)) {
      run.push(turn);
      continue;
    }
    flush();
    blocks.push(<TranscriptTurn key={turn.id} turn={turn} />);
  }
  flush();

  return blocks;
}

export function CallDetailsScreen({
  activeTopic,
  className,
  dialog,
  moment: momentProp,
  momentId,
  onDeleteRecording,
  onSelectQuestion,
  onTopicChange,
  pendingProposals,
  player,
  recordingDeleted = false,
  sections = PREVIEW_SECTIONS,
}: {
  /** Selected topic pill; the last topic by default. */
  activeTopic?: string;
  className?: string;
  dialog?: "delete-recording";
  /** Resolved moment (app); wins over `momentId`. `null` hides it. */
  moment?: TranscriptMoment | null;
  momentId?: string;
  onDeleteRecording?: () => void;
  onSelectQuestion?: (questionId: string) => void;
  /** Makes the topic pills controlled. */
  onTopicChange?: (topicId: string) => void;
  pendingProposals?: number;
  /** The live player of the app. */
  player?: PlayerState;
  /** The audio is gone: no player, the recording card says so. */
  recordingDeleted?: boolean;
  sections?: TranscriptSection[];
}) {
  const info = usePostCallInfo();
  const moment =
    momentProp === undefined
      ? resolveMoment(sections, momentId)
      : (momentProp ?? undefined);
  const topics = sections.map((section) => section.topic);
  const selectedTopic = activeTopic ?? topics.at(-1)?.id;
  const changeTopic = useCallback(
    (topicId: string) => onTopicChange?.(topicId),
    [onTopicChange]
  );

  return (
    <CallWindow
      active="transcript"
      aside={
        <SideColumn label="Вопросы звонка">
          <CallQuestionList
            activeId={moment?.questionId}
            onSelect={onSelectQuestion}
            questions={CALL_QUESTIONS}
          />
          <RecordingCard
            className="mt-5"
            deleted={recordingDeleted}
            onDelete={onDeleteRecording}
          />
        </SideColumn>
      }
      className={className}
      overlay={dialog ? <DeleteRecordingDialog /> : null}
      panelClassName="relative overflow-clip"
      pendingProposals={pendingProposals}
    >
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth px-16">
        <div className="border-border bg-background sticky top-0 z-[1] flex shrink-0 items-center justify-between gap-6 border-b pt-4 pb-3.5">
          <FilterTabs
            label="Темы"
            onValueChange={onTopicChange ? changeTopic : undefined}
            options={topics.map((topic) => ({
              count: topic.time,
              id: topic.id,
              label: topic.title,
            }))}
            value={selectedTopic}
          />
          <SearchField
            className="h-8 w-[220px] text-sm"
            label="Найти в расшифровке"
            placeholder="Найти в расшифровке"
          />
        </div>
        <MessageGroup
          className={
            recordingDeleted
              ? "max-w-content pt-7 pb-14"
              : "max-w-content pt-7 pb-[140px]"
          }
        >
          {sections.map((section) => (
            <div
              className="flex scroll-mt-20 flex-col gap-[18px]"
              id={`topic-${section.topic.id}`}
              key={section.topic.id}
            >
              <TopicDivider time={section.topic.time}>
                {section.topic.title}
              </TopicDivider>
              <SectionTurns moment={moment} turns={section.turns} />
            </div>
          ))}
        </MessageGroup>
      </main>
      {recordingDeleted ? null : (
        <AudioPlayer
          channel={player?.channel}
          className="absolute inset-x-6 bottom-6"
          duration={info.duration}
          onChannelChange={player?.onChannelChange}
          onSpeedChange={player?.onSpeedChange}
          onTogglePlay={player?.onTogglePlay}
          playing={player ? player.playing : !dialog}
          position={player?.position ?? moment?.position ?? RECORDING.position}
          speed={player?.speed}
        />
      )}
    </CallWindow>
  );
}
