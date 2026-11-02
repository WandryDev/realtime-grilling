import type { ContextSource } from "@/components/ui/context-card";
import type { QuestionHistoryStatus } from "@/components/ui/question-history";

/*
 * Data shapes of the call window. Screens get them through props, the demo
 * values live in ./mock.ts.
 */

/* Title bar */

export interface CallInfo {
  /** "Завершить": black while the call runs, white while the mic is free. */
  endAction: "primary" | "secondary" | "hidden";
  participants: string;
  project: string;
  /** `stopped` grays the dot once the call is being wrapped up. */
  recording: "live" | "stopped";
  time: string;
}

/* Transcript */

export interface TranscriptFooter {
  status: "answered" | "contradiction" | "assumption";
  text: string;
  /** Earlier moment the phrase refers to, a link after the text. */
  time?: string;
}

export type TranscriptItem =
  | { id: string; kind: "topic"; time: string; title: string }
  | {
      footer?: TranscriptFooter;
      id: string;
      kind: "client";
      /** The phrase is still being spoken or transcribed. */
      live?: "speaking" | "transcribing";
      text: string;
    }
  | { id: string; kind: "me"; text: string }
  /** Client speech without audio: a dashed placeholder with its length. */
  | { duration: string; id: string; kind: "missing"; label: string };

export interface TranscriptNoticeData {
  description: string;
  title: string;
}

export interface TranscriptData {
  /** Collapsed to the 52px rail. */
  collapsed?: boolean;
  items: TranscriptItem[];
  notice?: TranscriptNoticeData;
}

/* Questions */

export type QuestionTag =
  | "contradiction"
  | "assumption"
  | "code"
  | "clickup"
  | "empty";

export interface OpenQuestionData {
  description: string;
  id: string;
  tag?: QuestionTag;
  title: string;
  /** Topic the question came from, shown above it in the final check. */
  topic?: string;
}

export interface MainQuestionData {
  description: string;
  /** Stable id, when the main question can later move into the list. */
  id?: string;
  /** "Новый, только что", or why it is first. */
  status: string;
  title: string;
}

export interface PinnedQuestionData {
  description: string;
  id: string;
  /** "Закреплён вами в 12:24". */
  label: string;
  title: string;
}

export interface HistoryEntry {
  answer?: string;
  id: string;
  note?: string;
  question: string;
  status: QuestionHistoryStatus;
  /** Time on the right; without it the row offers "Вернуть". */
  time?: string;
}

export interface TopicHistoryData {
  count?: number;
  items: HistoryEntry[];
}

export interface TopicData {
  history?: TopicHistoryData;
  id: string;
  main?: MainQuestionData;
  meta: string;
  pinned?: PinnedQuestionData;
  questions: OpenQuestionData[];
  title: string;
}

export interface TopicAnchorData {
  active?: boolean;
  count: number;
  countTone: "open" | "neutral";
  id: string;
  label: string;
}

export interface AgentStatusData {
  label?: string;
  state: "listening" | "thinking";
  tone?: "accent" | "muted" | "destructive";
}

export interface AgentBannerAction {
  /** What the button does, for the call window's handler. */
  id?: string;
  label: string;
  variant: "secondary" | "ghost";
}

export interface AgentBannerData {
  actions: AgentBannerAction[];
  description: string;
  /** Full-width line under the actions. */
  footnote?: string;
  /** Muted line next to the actions, with an optional mono countdown. */
  hint?: { text: string; time?: string };
  icon: "claude" | "speaker-off";
  title: string;
}

export interface FinalCheckData {
  banner: { action: string; description: string; title: string };
  main: MainQuestionData;
  meta: string;
  questions: OpenQuestionData[];
  title: string;
}

export interface ListeningEmptyData {
  description: string;
  title: string;
}

export interface QuestionsData {
  agent: AgentStatusData;
  anchors: TopicAnchorData[];
  banner?: AgentBannerData;
  current?: TopicData;
  empty?: ListeningEmptyData;
  finalCheck?: FinalCheckData;
  /** The agent stopped: questions stay readable but gray out. */
  frozen?: boolean;
  /** Question shown in its hover state with the quick actions. */
  hoveredId?: string;
  noTopic?: TopicData;
  previous?: TopicData;
}

/* Context */

export type ContextItem =
  | { id: string; kind: "searching"; text: string }
  | {
      body?: string;
      /** Body as a title (ClickUp task name). */
      bodyStrong?: boolean;
      code?: string;
      id: string;
      kind: "finding";
      meta: string;
      metaMono?: boolean;
      questionLink?: string;
      quote?: string;
      quoteMeta?: string;
      source: ContextSource;
      /** Soft orange status pill: "ждёт клиента". */
      status?: string;
      time?: string;
      title: string;
    }
  | {
      action: string;
      body: string;
      id: string;
      kind: "unavailable";
      meta: string;
      note: string;
      /** Reconnecting: the button spins and stops taking clicks. */
      pending?: boolean;
      source: ContextSource;
      status: string;
      title: string;
    }
  | { id: string; kind: "brief"; meta: string; title: string }
  | {
      id: string;
      items: {
        done?: boolean;
        id: string;
        name: string;
        source: ContextSource;
        status: string;
      }[];
      kind: "sources";
    };

export interface ContextData {
  description: string;
  items: ContextItem[];
}

/* Overlays */

export interface MicReleasedData {
  countdown: string;
  countdownLabel: string;
  description: string;
  /** Time left, in percent of the timeout. */
  progress: number;
  title: string;
}

export interface FinishingStep {
  id: string;
  label: string;
  meta?: string;
  state: "done" | "active" | "pending";
}

export interface FinishingData {
  /** "Отменить завершение" is no longer offered. */
  cancelDisabled?: boolean;
  description: string;
  progress: number;
  steps: FinishingStep[];
  title: string;
}

export interface CallScreenData {
  call: CallInfo;
  context: ContextData;
  /** The call is wrapping up: the window quiets down under the summary card. */
  finishing?: FinishingData;
  micReleased?: MicReleasedData;
  questions: QuestionsData;
  transcript: TranscriptData;
}

/** States of the call window drawn in Paper. */
export type CallScreenState =
  | "reference"
  | "starting"
  | "question-hover"
  | "question-pinned"
  | "transcript-collapsed"
  | "final-check"
  | "mic-released"
  | "agent-timeout"
  | "limit-reached"
  | "transcript-lag"
  | "no-system-audio"
  | "github-unavailable"
  | "finishing";

/* Handlers */

/** Quick actions of an open question. */
export type QuestionQuickAction = "asked" | "pin" | "hide";

/**
 * What the live call window does on clicks. Every handler is optional: the
 * static previews in /dev/screens render without them.
 */
export interface CallScreenActions {
  /** A button of the agent banner, by its `id`. */
  onBannerAction?: (actionId: string) => void;
  /** "Отменить завершение". */
  onCancelFinish?: () => void;
  /** "Закрыть окно" on the finishing card. */
  onCloseWindow?: () => void;
  /** "Завершить" in the title bar or on the mic panel. */
  onEnd?: () => void;
  /** "Вернуться к темам" on the final check banner. */
  onLeaveFinalCheck?: () => void;
  /** "Продолжить" on the mic panel. */
  onMicContinue?: () => void;
  onQuestionAction?: (
    topicId: string,
    questionId: string,
    action: QuestionQuickAction
  ) => void;
  /** "Подключить снова" on an unavailable source card. */
  onReconnect?: (itemId: string) => void;
  /** "Вернуть" on a history row. */
  onRestore?: (topicId: string, entryId: string) => void;
  /** "свернуть" and "Развернуть расшифровку". */
  onToggleTranscript?: () => void;
  /** "Открепить". */
  onUnpin?: (topicId: string) => void;
}
