// The server's HTTP API (call-analytics design.md, decision 8): what Grill
// posts and what the web reads. Only schemas: the web builds its typed
// client from this file without the server's code.

import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
} from "effect/http-api";

const Millis = Schema.Finite;
const NullableMillis = Schema.NullOr(Schema.Finite);
const Count = Schema.Finite;
const NullableString = Schema.NullOr(Schema.String);

/* Ingest */

export const IngestRequest = Schema.Struct({
  /** Events as Grill queued them; each is checked on its own. */
  events: Schema.Array(Schema.Unknown),
});

export const IngestResponse = Schema.Struct({
  /** Every event the server took, stored or set aside as rejected. */
  accepted: Schema.Array(Schema.String),
});

export class IngestGroup extends HttpApiGroup.make("ingest").add(
  HttpApiEndpoint.post("ingest", "/api/ingest", {
    payload: IngestRequest,
    success: IngestResponse,
  })
) {}

/* Read */

export const ProjectListItem = Schema.Struct({
  calls: Count,
  costUsd: Count,
  /** A number, or `none` for the calls without a project. */
  id: Schema.String,
  lastCallAt: NullableMillis,
  /** A call of it goes on now. */
  live: Schema.Boolean,
  name: Schema.String,
});

export const KindCost = Schema.Struct({
  cacheRead: Count,
  cacheWrite: Count,
  calls: Count,
  costUsd: Count,
  inputTokens: Count,
  kind: Schema.String,
  outputTokens: Count,
});

export const CallListItem = Schema.Struct({
  agentCalls: Count,
  costUsd: Count,
  endedAt: NullableMillis,
  failures: Count,
  id: Schema.String,
  startedAt: NullableMillis,
  status: Schema.String,
  title: Schema.String,
});

export const QuestionCounts = Schema.Struct({
  answered: Count,
  asked: Count,
  created: Count,
  hidden: Count,
  pinned: Count,
  restored: Count,
  shown: Count,
});

export const SourceUse = Schema.Struct({
  /** Times it came up in the slow loop's search. */
  candidates: Count,
  findings: Count,
  /** Findings of it a question cited. */
  grounds: Count,
  sourceKind: Schema.String,
  sourceName: Schema.String,
  sourceUrl: NullableString,
});

export const ProjectSummary = Schema.Struct({
  brief: KindCost,
  calls: Schema.Array(CallListItem),
  /** The calls' agent cost by kind; the brief apart. */
  costByKind: Schema.Array(KindCost),
  id: Schema.String,
  name: Schema.String,
  questions: QuestionCounts,
  sources: Schema.Array(SourceUse),
});

export const AgentCallOp = Schema.Struct({
  applied: Schema.Boolean,
  idx: Count,
  op: Schema.String,
  reason: Schema.NullOr(Schema.Unknown),
  subjectId: NullableString,
  subjectKind: NullableString,
});

export const AgentCallSummary = Schema.Struct({
  cacheRead: Schema.NullOr(Count),
  cacheWrite: Schema.NullOr(Count),
  costUsd: Schema.NullOr(Count),
  durationMs: Millis,
  error: NullableString,
  findingsInPrompt: Schema.NullOr(Schema.Array(Schema.String)),
  id: Schema.String,
  inputTokens: Schema.NullOr(Count),
  kind: Schema.String,
  ops: Schema.Array(AgentCallOp),
  outcome: Schema.String,
  outputTokens: Schema.NullOr(Count),
  /** The prompt's size in bytes, what is known of it. */
  promptBytes: Count,
  recordingId: NullableString,
  startedAt: Millis,
  trigger: NullableString,
  triggerSegmentId: NullableString,
  windowSegments: Schema.NullOr(Schema.Array(Schema.String)),
});

export const TimelineSegment = Schema.Struct({
  channel: Schema.String,
  endMs: Millis,
  id: Schema.String,
  recordingId: Schema.String,
  startMs: Millis,
  text: Schema.String,
});

export const TimelineQuestion = Schema.Struct({
  answerEvidence: Schema.NullOr(Schema.Unknown),
  cardField: NullableString,
  createdAt: Millis,
  description: Schema.String,
  evidence: Schema.Unknown,
  gapType: Schema.String,
  id: Schema.String,
  pinned: Schema.Boolean,
  priority: Count,
  recordingId: Schema.String,
  shownAt: NullableMillis,
  status: Schema.String,
  text: Schema.String,
  topicId: NullableString,
});

export const TimelineStep = Schema.Struct({
  agentCallId: NullableString,
  at: Millis,
  id: Schema.String,
  step: Schema.String,
  subjectId: Schema.String,
});

export const TimelineFinding = Schema.Struct({
  agentCallId: NullableString,
  createdAt: Millis,
  evictedAt: NullableMillis,
  hiddenAt: NullableMillis,
  id: Schema.String,
  note: Schema.String,
  questionId: NullableString,
  quote: Schema.String,
  recordingId: Schema.String,
  sourceKind: Schema.String,
  sourceName: Schema.String,
  sourceUrl: NullableString,
});

export const CallTimeline = Schema.Struct({
  agentCalls: Schema.Array(AgentCallSummary),
  call: Schema.Struct({
    endedAt: NullableMillis,
    id: Schema.String,
    projectId: Schema.String,
    projectName: Schema.String,
    startedAt: NullableMillis,
    status: Schema.String,
    title: Schema.String,
  }),
  cards: Schema.Array(
    Schema.Struct({
      fields: Schema.Unknown,
      id: Schema.String,
      topicId: Schema.String,
    })
  ),
  costUsd: Count,
  findingSteps: Schema.Array(TimelineStep),
  findings: Schema.Array(TimelineFinding),
  questionSteps: Schema.Array(TimelineStep),
  questions: Schema.Array(TimelineQuestion),
  recordings: Schema.Array(
    Schema.Struct({
      endedAt: NullableMillis,
      id: Schema.String,
      refined: Schema.Boolean,
      startedAt: Millis,
      status: Schema.String,
    })
  ),
  /** The refined transcript of a recording when there is one, else the live. */
  segments: Schema.Array(TimelineSegment),
  topics: Schema.Array(
    Schema.Struct({
      createdAt: Millis,
      id: Schema.String,
      recordingId: Schema.String,
      title: Schema.String,
    })
  ),
});

export const AgentCallDetails = Schema.Struct({
  call: AgentCallSummary,
  candidates: Schema.Array(
    Schema.Struct({
      headingPath: NullableString,
      label: Schema.String,
      rank: Count,
      sourceKind: Schema.String,
      sourceName: Schema.String,
      sourceUrl: NullableString,
      text: Schema.String,
    })
  ),
  effort: NullableString,
  model: NullableString,
  parts: Schema.Array(
    Schema.Struct({
      hash: Schema.String,
      label: Schema.String,
      /** `null` until the part's text arrived. */
      text: NullableString,
    })
  ),
  queries: Schema.NullOr(Schema.Unknown),
  rawReply: NullableString,
  reply: Schema.NullOr(Schema.Unknown),
});

export const FindingDetails = Schema.Struct({
  /** The questions that cite it. */
  citedBy: Schema.Array(Schema.String),
  finding: TimelineFinding,
  /** The fast loop's calls that were given it. */
  givenTo: Schema.Array(Schema.String),
  steps: Schema.Array(TimelineStep),
});

export class ReadGroup extends HttpApiGroup.make("read").add(
  HttpApiEndpoint.get("projects", "/api/projects", {
    success: Schema.Array(ProjectListItem),
  }),
  HttpApiEndpoint.get("project", "/api/projects/:id", {
    error: HttpApiError.NotFound,
    params: { id: Schema.String },
    success: ProjectSummary,
  }),
  HttpApiEndpoint.get("call", "/api/calls/:id", {
    error: HttpApiError.NotFound,
    params: { id: Schema.String },
    success: CallTimeline,
  }),
  HttpApiEndpoint.get("agentCall", "/api/agent-calls/:id", {
    error: HttpApiError.NotFound,
    params: { id: Schema.String },
    success: AgentCallDetails,
  }),
  HttpApiEndpoint.get("finding", "/api/findings/:id", {
    error: HttpApiError.NotFound,
    params: { id: Schema.String },
    success: FindingDetails,
  })
) {}

export class AnalyticsApi extends HttpApi.make("grill-analytics")
  .add(IngestGroup)
  .add(ReadGroup) {}
