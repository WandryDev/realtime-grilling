import type { ContextSource } from "@grill/ui/context-card";
import type { QuestionHistoryStatus } from "@grill/ui/question-history";
import type { RecordingLevel } from "@grill/ui/recording-indicator";

/*
 * Data shapes of the call window. Screens get them through props, the demo
 * values live in ./mock.ts.
 */

/* Title bar */

export interface CallInfo {
  /** "Завершить": black while the call runs, white while the mic is free. */
  endAction: "primary" | "secondary" | "hidden";
  /** Live levels of "Я" and "Остальные" on the recording indicator. */
  level?: RecordingLevel | null;
  participants: string;
  project: string;
  /** `stopped` grays the dot once the call is being wrapped up. */
  recording: "live" | "stopped";
  time: string;
  /** A channel that doesn't capture, on the recording indicator. */
  warning?: string | null;
}

/* Transcript */

export interface TranscriptFooter {
  status: "answered" | "contradiction" | "assumption";
  text: string;
  /** Earlier moment the phrase refers to, a link after the text. */
  time?: string;
}

/** The stored transcript segment a phrase is (the recognizer's feed). */
export interface TranscriptSegmentRef {
  id: string;
  /** Offset from the start of the recording. */
  startMs: number;
}

export type TranscriptItem =
  | { id: string; kind: "topic"; time: string; title: string }
  | {
      footer?: TranscriptFooter;
      id: string;
      kind: "client";
      /** The phrase is still being spoken or transcribed. */
      live?: "speaking" | "transcribing";
      /** The segment the agent's evidence names; none in the demo. */
      segment?: TranscriptSegmentRef;
      text: string;
    }
  | {
      id: string;
      kind: "me";
      /** Your phrase is still being transcribed. */
      live?: "transcribing";
      segment?: TranscriptSegmentRef;
      text: string;
    }
  /** Client speech without audio: a dashed placeholder with its length. */
  | { duration: string; id: string; kind: "missing"; label: string };

export interface TranscriptNoticeData {
  description: string;
  title: string;
}

/**
 * Recognition doesn't work this call (no model, it failed to load, no
 * phrases come out of the recording): said instead of the feed.
 */
export interface TranscriptUnavailableData {
  description: string;
  /** "Скачать в настройках": the model is missing or broken. */
  settingsHref?: string;
  title: string;
}

export interface TranscriptData {
  /** Collapsed to the 52px rail. */
  collapsed?: boolean;
  items: TranscriptItem[];
  notice?: TranscriptNoticeData;
  unavailable?: TranscriptUnavailableData;
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
  /** A link instead of a handler: "Настройки → Агент". */
  href?: string;
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
  /** Topics before `previous`, the newest first (the agent's topics). */
  earlier?: TopicData[];
  empty?: ListeningEmptyData;
  finalCheck?: FinalCheckData;
  /** The agent stopped: questions stay readable but gray out. */
  frozen?: boolean;
  /** Question a context card pointed at («к вопросу …»), highlighted. */
  highlightedId?: string;
  /** Question shown in its hover state with the quick actions. */
  hoveredId?: string;
  /** "Без темы": questions waiting for a convenient moment. */
  noTopic?: TopicData;
  /**
   * The final check after "Вернуться к темам": "К финальной проверке"
   * brings it back.
   */
  parkedFinalCheck?: FinalCheckData;
  previous?: TopicData;
  /** Share of the Claude subscription limit used, "лимит 42%". */
  usage?: string;
}

/* Context */

export type ContextItem =
  | { id: string; kind: "searching"; text: string }
  | {
      body?: string;
      /** Body as a title (ClickUp task name). */
      bodyStrong?: boolean;
      code?: string;
      /** «Убрать»: the backend's finding (Tauri), hidden by its `id`. */
      hideable?: boolean;
      id: string;
      kind: "finding";
      meta: string;
      metaMono?: boolean;
      /** The question `questionLink` scrolls to; without it the link is inert. */
      questionId?: string;
      questionLink?: string;
      quote?: string;
      quoteMeta?: string;
      source: ContextSource;
      /** Soft orange status pill: "ждёт клиента". */
      status?: string;
      time?: string;
      title: string;
      /** The document or task in its service: «Открыть в источнике». */
      url?: string;
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
  /** Nothing to search in: no findings will come. */
  | { description: string; id: string; kind: "empty"; title: string }
  | {
      id: string;
      /** Spoken name of the list; «Источники брифа» by default. */
      label?: string;
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
  /** Time left, "6:48"; none when the call never ends by itself. */
  countdown?: string;
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
  /** «Убрать» on a finding of the backend. */
  onHideFinding?: (findingId: string) => void;
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
  /** "К финальной проверке" after leaving it. */
  onReturnToFinalCheck?: () => void;
  /** «к вопросу …» on a context card: show that question in the list. */
  onShowQuestion?: (questionId: string) => void;
  /** "свернуть" and "Развернуть расшифровку". */
  onToggleTranscript?: () => void;
  /** "Открепить". */
  onUnpin?: (topicId: string) => void;
}

/* ------------------------------------------------------------ Call feed */

/** What the recorder and the agent push during a call (`CallBackend.feed`). */
export type CallFeedEvent =
  /** Adds a phrase or replaces the one with the same id (speech finished). */
  | { item: TranscriptItem; type: "transcript" }
  /** Adds a phrase being transcribed, unless its text is already there. */
  | { item: TranscriptItem; type: "transcript-pending" }
  /** The phrase had no text after all: it goes away. */
  | { id: string; type: "transcript-remove" }
  /** The recognizer lags `seconds` behind; 0: it caught up. */
  | { seconds: number; type: "transcript-lag" }
  /** Whether recognition works this call. */
  | { state: TranscriptionState; type: "transcription" }
  /**
   * A new topic under discussion. The current one moves down as the
   * previous topic, `previousRange` becomes its time range.
   */
  | { previousRange?: string; topic: TopicData; type: "topic" }
  /** A new open question; moves it if another topic already has it. */
  | { question: OpenQuestionData; topicId: string; type: "question" }
  /** A new main question; the old main joins the open questions. */
  | { main: MainQuestionData; topicId: string; type: "main-question" }
  /** The agent heard an answer: a row in "Обсудили в этой теме". */
  | {
      entry: HistoryEntry;
      /** Open question the answer closes. */
      questionId?: string;
      topicId: string;
      type: "answered";
    }
  /** Adds or replaces a context card, removes the listed ones. */
  | {
      description?: string;
      item?: ContextItem;
      remove?: string[];
      type: "context";
    }
  /** The agent hears the call wind down. */
  | { finalCheck: FinalCheckData; type: "final-check" }
  /** Nobody but us holds the microphone any more. */
  | { type: "mic-released" };

export type FeedCheckpoint = "reference" | "final-check";

/** Recognition of the recording: `ok`, or why there is no text. */
export type TranscriptionState =
  | "ok"
  | "noModel"
  | "modelFailed"
  | "segmentationUnavailable";
