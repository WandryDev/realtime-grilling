import {
  AgentStatus,
  type RecordingLevel,
} from "@/components/ui/recording-indicator";
import { cn } from "@/lib/utils";

import { FloatingSurface } from "../components/floating-surface";
import { NewQuestionCard } from "../components/new-question-card";
import {
  OverlayFooter,
  OverlayHeader,
  OverlayHeading,
  OverlayMainQuestion,
  OverlayQuestion,
  PastTopicsButton,
} from "../components/overlay-parts";
import { OverlayPill } from "../components/overlay-pill";
import { FlagIcon } from "../icons";
import {
  CALL_PROJECT,
  FINAL_CHECK_QUESTIONS,
  OVERLAY,
  OVERLAY_MAIN_QUESTION,
  OVERLAY_QUESTIONS,
  OVERLAY_TOPIC,
  type OverlayQuestionItem,
} from "../mock";

/*
 * Paper "06 Компактный оверлей": a 380px window over all others, hidden from
 * screen sharing. Only the current topic and its top three questions.
 * - default: the topic, "прошлые" for questions left in other topics
 * - final-check: a flag title instead of the topic, each question signed
 *   with its topic
 * - collapsed: the pill with time, topic and open count; a new important
 *   question shows a card under it for 8 seconds
 */
export type CompactOverlayState = "default" | "final-check" | "collapsed";

type AgentState = "listening" | "thinking";

/** What the recording indicator draws besides the time. */
export interface OverlayRecording {
  level: RecordingLevel | null;
  warning: string | null;
}

export function CompactOverlay({
  agentState = "listening",
  callHref,
  className,
  mainLabel = "Новый, только что",
  mainQuestion = OVERLAY_MAIN_QUESTION,
  newQuestion,
  onCollapse,
  onDismissNewQuestion,
  onExpand,
  onOpenNewQuestion,
  openQuestions = OVERLAY.openQuestions,
  pastTopics = OVERLAY.pastTopics,
  project = CALL_PROJECT,
  questions,
  recording,
  state = "default",
  time,
  topic = OVERLAY_TOPIC,
}: {
  /** The footer status: "слушаю" or "думаю над вопросами". */
  agentState?: AgentState;
  /** The header arrows and "прошлые" lead to the call window. */
  callHref?: string;
  className?: string;
  /** Over the main question, outside the final check. */
  mainLabel?: string;
  mainQuestion?: string;
  /**
   * The card under the collapsed pill. Defaults to the main question
   * (previews); null hides it.
   */
  newQuestion?: string | null;
  /** "−": collapse into the pill. */
  onCollapse?: () => void;
  onDismissNewQuestion?: () => void;
  /** The pill's expand button. */
  onExpand?: () => void;
  onOpenNewQuestion?: () => void;
  openQuestions?: number;
  pastTopics?: number;
  project?: string;
  /** Rows under the main question. Defaults depend on the state. */
  questions?: OverlayQuestionItem[];
  /** Live levels and a channel's warning; previews draw none. */
  recording?: OverlayRecording;
  state?: CompactOverlayState;
  time?: string;
  topic?: string;
}) {
  const finalCheck = state === "final-check";
  const callTime = time ?? (finalCheck ? OVERLAY.timeFinalCheck : OVERLAY.time);

  if (state === "collapsed") {
    const card = newQuestion === undefined ? mainQuestion : newQuestion;
    return (
      <div className={cn("flex w-fit flex-col items-end gap-2", className)}>
        <OverlayPill
          level={recording?.level}
          onExpand={onExpand}
          openQuestions={openQuestions}
          time={callTime}
          topic={topic}
          warning={recording?.warning}
        />
        {card === null ? null : (
          <NewQuestionCard
            onClose={onDismissNewQuestion}
            onOpen={onOpenNewQuestion}
            question={card}
          />
        )}
      </div>
    );
  }

  const rows =
    questions ?? (finalCheck ? FINAL_CHECK_QUESTIONS : OVERLAY_QUESTIONS);

  return (
    <FloatingSurface className={cn("w-overlay gap-1 p-2", className)}>
      <OverlayHeader
        callHref={callHref}
        level={recording?.level}
        onCollapse={onCollapse}
        project={project}
        time={callTime}
        warning={recording?.warning}
      />
      {finalCheck ? (
        <OverlayHeading
          description={OVERLAY.finalCheckDescription}
          icon={<FlagIcon className="size-4 shrink-0" />}
          title="Финальная проверка"
        />
      ) : (
        <OverlayHeading
          action={<PastTopicsButton count={pastTopics} href={callHref} />}
          title={topic}
        />
      )}
      <OverlayMainQuestion
        label={finalCheck ? topic : mainLabel}
        title={mainQuestion}
      />
      {rows.map((question) => (
        <OverlayQuestion key={question.id} question={question} />
      ))}
      <OverlayFooter>
        {finalCheck ? (
          <span className="text-muted-foreground text-sm">
            ещё {OVERLAY.finalCheckMore} в окне
          </span>
        ) : (
          <AgentStatus state={agentState} />
        )}
      </OverlayFooter>
    </FloatingSurface>
  );
}
