"use client";

import { type ReactNode, useCallback } from "react";

import { MessageGroup } from "@/components/ui/message";
import { TopicDivider } from "@/components/ui/topic-divider";
import { cn } from "@/lib/utils";

import {
  CallWindow,
  PANEL_PAGE_X,
  SideColumn,
} from "../components/call-window";
import { FilterTabs, SearchField } from "../components/history";
import { usePostCallInfo } from "../components/links";
import {
  AudioPlayer,
  CallQuestionList,
  DeleteRecordingDialog,
  MomentHighlight,
  type PlayerChannel,
  type PlayerPart,
  type PlayerSpeed,
  RecordingCard,
  TranscriptTurn,
} from "../components/transcript";
import {
  CALL_QUESTIONS,
  type CallQuestion,
  RECORDING,
  TRANSCRIPT_TOPICS,
  TRANSCRIPT_TURNS,
  type TranscriptSection,
  type TranscriptTurnData,
} from "../mock";
import type { TranscriptMoment } from "../moment";

/*
 * "06 Детали звонка": the transcript with the player. `momentId` is a
 * question from the right column: the transcript highlights the moment it
 * was asked and the player stands there. `dialog="delete-recording"` is
 * "07 Мини-флоу — удаление записи" (the player pauses under the dialog).
 *
 * The app passes the whole transcript (`sections`), its questions, a
 * resolved `moment`, the search, the live player and the handlers; /dev
 * shows the second topic of the demo only.
 */

const PREVIEW_TOPIC = TRANSCRIPT_TOPICS.at(-1) ?? {
  id: "crm",
  time: "12:21",
  title: "Интеграция с CRM",
};

const PREVIEW_SECTIONS: TranscriptSection[] = [
  { topic: PREVIEW_TOPIC, turns: TRANSCRIPT_TURNS },
];

/** The moment of a demo question in /dev: its turn and the reply. */
function previewMoment(
  sections: TranscriptSection[],
  questionId: string | undefined
): TranscriptMoment | undefined {
  const question = CALL_QUESTIONS.find((item) => item.id === questionId);
  if (!question) {
    return;
  }
  const turns = sections.flatMap((section) => section.turns);
  const index = turns.findIndex((turn) => turn.id === question.momentTurnId);
  const turnIds =
    index === -1 ? [] : turns.slice(index, index + 2).map((turn) => turn.id);
  return {
    label: `Здесь спросили «${question.text}»`,
    position: turnIds.length > 0 ? question.position : undefined,
    questionId: question.id,
    turnIds,
  };
}

/** Id of the highlighted block, the app scrolls to it. */
export const MOMENT_ELEMENT_ID = "transcript-moment";

/** Id prefix of a turn, the search scrolls to the first one it found. */
export const TURN_ELEMENT_ID = "turn-";

export interface PlayerState {
  channel: PlayerChannel;
  /** «40:12» of the part that plays. */
  duration?: string;
  onChannelChange: (channel: PlayerChannel) => void;
  /** The part has one channel file: no channel menu. */
  oneChannel?: boolean;
  onPartChange?: (partId: string) => void;
  onSeek?: (progress: number) => void;
  onSpeedChange: (speed: PlayerSpeed) => void;
  onTogglePlay: () => void;
  part?: string;
  parts?: readonly PlayerPart[];
  /** The waveform of the part, 0 to 1. */
  peaks?: readonly number[];
  /**
   * Whether there is anything to play: not while the transcript loads, a
   * call without recordings or a recording still being written.
   */
  playable?: boolean;
  playing: boolean;
  position: string;
  /** Played share, 0 to 1. */
  progress?: number;
  speed: PlayerSpeed;
}

/** The search in the transcript (app): the query and what it found. */
export interface TranscriptSearch {
  /** Turns with a match. */
  found: number;
  onQueryChange: (query: string) => void;
  query: string;
}

/** Instead of the transcript: it is loading, failed or has no phrases. */
export interface TranscriptNotice {
  description: string;
  title: string;
}

/** Turns of a topic, the moment's phrases wrapped in the orange block. */
function SectionTurns({
  moment,
  query,
  turns,
}: {
  moment?: TranscriptMoment;
  query?: string;
  turns: TranscriptTurnData[];
}) {
  const highlighted = new Set(moment?.turnIds ?? []);
  const blocks: ReactNode[] = [];
  let run: TranscriptTurnData[] = [];

  const turnOf = (turn: TranscriptTurnData) => (
    <TranscriptTurn
      id={`${TURN_ELEMENT_ID}${turn.id}`}
      key={turn.id}
      query={query}
      turn={turn}
    />
  );

  const flush = () => {
    const [first] = run;
    if (moment && first) {
      blocks.push(
        <MomentHighlight
          id={MOMENT_ELEMENT_ID}
          key={`moment-${first.id}`}
          label={moment.label}
        >
          {run.map(turnOf)}
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
    blocks.push(turnOf(turn));
  }
  flush();

  return blocks;
}

/** The questions of the call (when it had any) and its recording. */
function DetailsAside({
  activeQuestionId,
  onDeleteRecording,
  onSelectQuestion,
  questions,
  recordingDeleted,
  recordingDescription,
}: {
  activeQuestionId?: string;
  onDeleteRecording?: () => void;
  onSelectQuestion?: (questionId: string) => void;
  questions: CallQuestion[];
  recordingDeleted: boolean;
  recordingDescription?: string;
}) {
  const asked = questions.length > 0;
  return (
    <SideColumn label="Вопросы звонка">
      {asked ? (
        <CallQuestionList
          activeId={activeQuestionId}
          onSelect={onSelectQuestion}
          questions={questions}
        />
      ) : null}
      <RecordingCard
        className={asked ? "mt-5" : undefined}
        deleted={recordingDeleted}
        description={recordingDescription}
        onDelete={onDeleteRecording}
      />
    </SideColumn>
  );
}

export function CallDetailsScreen({
  activeTopic,
  className,
  dialog,
  moment: momentProp,
  momentId,
  notice,
  onDeleteRecording,
  onSelectQuestion,
  onTopicChange,
  pendingProposals,
  player,
  questions = CALL_QUESTIONS,
  recordingDeleted = false,
  recordingDescription,
  search,
  sections = PREVIEW_SECTIONS,
  taskCards,
}: {
  /** Selected topic pill; the last topic by default. */
  activeTopic?: string;
  className?: string;
  dialog?: "delete-recording";
  /** Resolved moment (app); wins over `momentId`. `null` hides it. */
  moment?: TranscriptMoment | null;
  momentId?: string;
  /** Shown instead of the transcript (app). */
  notice?: TranscriptNotice;
  onDeleteRecording?: () => void;
  onSelectQuestion?: (questionId: string) => void;
  /** Makes the topic pills controlled. */
  onTopicChange?: (topicId: string) => void;
  pendingProposals?: number;
  /** The live player of the app. */
  player?: PlayerState;
  /** The questions of the call on the right. */
  questions?: CallQuestion[];
  /** The audio is gone: no player, the recording card says so. */
  recordingDeleted?: boolean;
  /** «Opus, 2 канала, 13 МБ. В облако не выгружается.» */
  recordingDescription?: string;
  /** Makes the search field live (app). */
  search?: TranscriptSearch;
  sections?: TranscriptSection[];
  /** The call's task cards, counted in the sidebar. */
  taskCards?: number;
}) {
  const info = usePostCallInfo();
  const moment =
    momentProp === undefined
      ? previewMoment(sections, momentId)
      : (momentProp ?? undefined);
  const topics = sections.map((section) => section.topic);
  const selectedTopic = activeTopic ?? topics.at(-1)?.id;
  const changeTopic = useCallback(
    (topicId: string) => onTopicChange?.(topicId),
    [onTopicChange]
  );
  const query = search?.query.trim() ? search.query : undefined;

  return (
    <CallWindow
      active="transcript"
      aside={
        <DetailsAside
          activeQuestionId={moment?.questionId}
          onDeleteRecording={onDeleteRecording}
          onSelectQuestion={onSelectQuestion}
          questions={questions}
          recordingDeleted={recordingDeleted}
          recordingDescription={recordingDescription}
        />
      }
      className={className}
      overlay={dialog ? <DeleteRecordingDialog /> : null}
      panelClassName="relative overflow-clip"
      pendingProposals={pendingProposals}
      taskCards={taskCards}
    >
      <main
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto scroll-smooth",
          PANEL_PAGE_X
        )}
      >
        {/*
         * The search narrows to 160 before it wraps under the topics; there,
         * on a narrow panel, it spans the row.
         */}
        <div className="border-border bg-background sticky top-0 z-[1] flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2.5 border-b pt-4 pb-3.5">
          {/* One topic (the whole call) has nothing to switch between. */}
          {topics.length > 1 ? (
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
          ) : null}
          <SearchField
            className="ml-auto h-8 w-auto min-w-0 grow basis-40 text-sm @2xl/panel:max-w-[220px]"
            label="Найти в расшифровке"
            onQueryChange={search?.onQueryChange}
            placeholder="Найти в расшифровке"
            query={search?.query}
          />
          {query ? (
            <p aria-live="polite" className="sr-only">
              {search?.found
                ? `Найдено реплик: ${search.found}`
                : "В расшифровке не нашлось"}
            </p>
          ) : null}
        </div>
        {notice ? (
          <div className="max-w-content flex flex-col gap-1 pt-7" role="status">
            <p className="text-base font-medium">{notice.title}</p>
            <p className="text-muted-foreground text-base">
              {notice.description}
            </p>
          </div>
        ) : (
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
                <SectionTurns
                  moment={moment}
                  query={query}
                  turns={section.turns}
                />
              </div>
            ))}
          </MessageGroup>
        )}
      </main>
      {recordingDeleted ? null : (
        <AudioPlayer
          channel={player?.channel}
          className="absolute inset-x-6 bottom-6"
          disabled={player?.playable === false}
          duration={player?.duration ?? info.duration}
          onChannelChange={player?.onChannelChange}
          oneChannel={player?.oneChannel}
          onPartChange={player?.onPartChange}
          onSeek={player?.onSeek}
          onSpeedChange={player?.onSpeedChange}
          onTogglePlay={player?.onTogglePlay}
          part={player?.part}
          parts={player?.parts}
          peaks={player?.peaks}
          playing={player ? player.playing : !dialog}
          position={player?.position ?? moment?.position ?? RECORDING.position}
          progress={player?.progress}
          speed={player?.speed}
        />
      )}
    </CallWindow>
  );
}
