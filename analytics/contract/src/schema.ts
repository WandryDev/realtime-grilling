// The events Grill sends to the team's analytics, as Effect schemas
// (call-analytics design.md, decision 5). Written by hand from
// `src-tauri/src/analytics/contract.rs`; `generated.ts` is exported from the
// same Rust types, and the check at the end of this file fails the
// typecheck when the two drift apart.

import { Schema } from "effect";
import type * as Generated from "./generated";

/** The version of the contract this package reads. */
export const VERSION = 1;

/** Milliseconds since the Unix epoch, UTC, or from a recording's start. */
const Millis = Schema.Finite;
const Id = Schema.String;
const NullableId = Schema.NullOr(Schema.String);
const NullableMillis = Schema.NullOr(Millis);
/** A JSON value Grill stores as it is (evidence, a card's fields, a reply). */
const Json = Schema.Unknown;

export const ProjectEvent = Schema.Struct({
  localId: Id,
  name: Schema.String,
});

export const CallStatus = Schema.Literals(["live", "finishing", "finished"]);

export const CallEvent = Schema.Struct({
  endedAt: NullableMillis,
  id: Id,
  projectLocalId: NullableId,
  startedAt: NullableMillis,
  status: CallStatus,
  title: Schema.String,
});

export const RecordingStatus = Schema.Literals([
  "recording",
  "finished",
  "interrupted",
]);

export const RecordingEvent = Schema.Struct({
  callId: NullableId,
  endedAt: NullableMillis,
  id: Id,
  startedAt: Millis,
  status: RecordingStatus,
});

export const Channel = Schema.Literals(["me", "others"]);

export const SegmentEvent = Schema.Struct({
  channel: Channel,
  endMs: Millis,
  id: Id,
  recordingId: Id,
  startMs: Millis,
  text: Schema.String,
});

export const RefinedSegment = Schema.Struct({
  channel: Channel,
  endMs: Millis,
  id: Id,
  startMs: Millis,
  text: Schema.String,
});

export const RefinedTranscriptEvent = Schema.Struct({
  recordingId: Id,
  segments: Schema.Array(RefinedSegment),
});

export const TopicEvent = Schema.Struct({
  createdAt: Millis,
  id: Id,
  recordingId: Id,
  title: Schema.String,
});

export const CardEvent = Schema.Struct({
  fields: Json,
  id: Id,
  recordingId: Id,
  topicId: Id,
});

export const QuestionStatus = Schema.Literals([
  "open",
  "answered",
  "hidden",
  "asked",
]);

export const QuestionEvent = Schema.Struct({
  answerEvidence: Schema.NullOr(Json),
  cardField: Schema.NullOr(Schema.String),
  createdAt: Millis,
  description: Schema.String,
  evidence: Json,
  gapType: Schema.String,
  id: Id,
  pinned: Schema.Boolean,
  priority: Schema.Int,
  recordingId: Id,
  shownAt: NullableMillis,
  status: QuestionStatus,
  text: Schema.String,
  topicId: NullableId,
});

export const QuestionStepKind = Schema.Literals([
  "created",
  "shown",
  "requeued",
  "unshown",
  "pinned",
  "unpinned",
  "hidden",
  "restored",
  "asked",
  "answered",
]);

export const QuestionStepEvent = Schema.Struct({
  agentCallId: NullableId,
  at: Millis,
  id: Id,
  questionId: Id,
  recordingId: Id,
  step: QuestionStepKind,
});

export const SourceKind = Schema.Literals(["file", "outline", "clickup"]);

export const FindingEvent = Schema.Struct({
  agentCallId: NullableId,
  chunkKey: Schema.String,
  createdAt: Millis,
  evictedAt: NullableMillis,
  hiddenAt: NullableMillis,
  id: Id,
  note: Schema.String,
  questionId: NullableId,
  quote: Schema.String,
  recordingId: Id,
  sourceKind: SourceKind,
  sourceName: Schema.String,
  sourceUrl: Schema.NullOr(Schema.String),
});

export const FindingStepKind = Schema.Literals(["shown", "hidden", "evicted"]);

export const FindingStepEvent = Schema.Struct({
  at: Millis,
  findingId: Id,
  id: Id,
  recordingId: Id,
  step: FindingStepKind,
});

export const PromptPartEvent = Schema.Struct({
  hash: Schema.String,
  text: Schema.String,
});

export const AgentCallKind = Schema.Literals([
  "fastLoop",
  "topicCheck",
  "slowLoop",
  "summary",
  "proposals",
  "brief",
]);

export const AgentCallOutcome = Schema.Literals([
  "ok",
  "empty",
  "invalid",
  "error",
  "timeout",
  "rate_limited",
  "not_logged_in",
  "cancelled",
]);

export const CallTrigger = Schema.Literals([
  "firstPhrase",
  "turnEnd",
  "interval",
  "retry",
  "manualRetry",
  "haltReset",
  "topicChanged",
]);

export const PromptPartRef = Schema.Struct({
  hash: Schema.String,
  label: Schema.String,
});

export const Candidate = Schema.Struct({
  chunkKey: Schema.String,
  headingPath: Schema.NullOr(Schema.String),
  label: Schema.String,
  rank: Schema.Int,
  sourceKind: SourceKind,
  sourceName: Schema.String,
  sourceUrl: Schema.NullOr(Schema.String),
  text: Schema.String,
});

const NullableCount = Schema.NullOr(Millis);

export const AgentCallEvent = Schema.Struct({
  cacheRead: NullableCount,
  cacheWrite: NullableCount,
  callId: NullableId,
  candidates: Schema.Array(Candidate),
  costUsd: Schema.NullOr(Schema.Finite),
  durationMs: Millis,
  effort: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  findingsInPrompt: Schema.NullOr(Schema.Array(Id)),
  id: Id,
  inputTokens: NullableCount,
  kind: AgentCallKind,
  model: Schema.NullOr(Schema.String),
  outcome: AgentCallOutcome,
  outputTokens: NullableCount,
  parts: Schema.Array(PromptPartRef),
  projectLocalId: NullableId,
  queries: Schema.NullOr(Json),
  rawReply: Schema.NullOr(Schema.String),
  recordingId: NullableId,
  reply: Schema.NullOr(Json),
  startedAt: Millis,
  trigger: Schema.NullOr(CallTrigger),
  triggerSegmentId: NullableId,
  utilization: Schema.NullOr(Schema.Finite),
  windowSegments: Schema.NullOr(Schema.Array(Id)),
});

export const SubjectKind = Schema.Literals([
  "question",
  "topic",
  "card",
  "finding",
]);

export const AgentCallOpEvent = Schema.Struct({
  agentCallId: Id,
  applied: Schema.Boolean,
  body: Json,
  idx: Schema.Int,
  op: Schema.String,
  reason: Schema.NullOr(Json),
  subjectId: NullableId,
  subjectKind: Schema.NullOr(SubjectKind),
});

/** An event of `kind` with its `body`, in the envelope. */
const envelope = <const Kind extends string, Body extends Schema.Top>(
  kind: Kind,
  body: Body
) =>
  Schema.Struct({
    at: Millis,
    body,
    id: Id,
    kind: Schema.Literal(kind),
    v: Schema.Int,
  });

/** One event: `{ id, v, at, kind, body }`. */
export const Envelope = Schema.Union([
  envelope("project", ProjectEvent),
  envelope("call", CallEvent),
  envelope("recording", RecordingEvent),
  envelope("segment", SegmentEvent),
  envelope("refinedTranscript", RefinedTranscriptEvent),
  envelope("topic", TopicEvent),
  envelope("card", CardEvent),
  envelope("question", QuestionEvent),
  envelope("questionEvent", QuestionStepEvent),
  envelope("finding", FindingEvent),
  envelope("findingEvent", FindingStepEvent),
  envelope("promptPart", PromptPartEvent),
  envelope("agentCall", AgentCallEvent),
  envelope("agentCallOp", AgentCallOpEvent),
]);

export type Envelope = typeof Envelope.Type;
export type EventKind = Envelope["kind"];

/* The schemas and the types exported from Rust describe the same data. */

type DeepReadonly<T> = T extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const sameAsRust: Same<Envelope, DeepReadonly<Generated.Envelope>> = true;
export const contractChecked = sameAsRust;
