// What the server returns, built with only what a test is about.

import type {
  AgentCallDetails,
  CallTimeline,
  FindingDetails,
  KindCost,
  ProjectListItem,
  ProjectSummary,
} from "@grill/analytics-server/api";

type Timeline = typeof CallTimeline.Type;
type AgentCall = Timeline["agentCalls"][number];

/** When the call began; the timeline counts from it. */
export const START = 1_795_000_000_000;
export const MINUTE = 60_000;

export const projectItem = (
  extra: Partial<typeof ProjectListItem.Type> = {}
): typeof ProjectListItem.Type => ({
  calls: 1,
  costUsd: 0.5,
  id: "1",
  lastCallAt: START,
  live: false,
  name: "Обменник",
  ...extra,
});

export const kindCost = (
  kind: string,
  costUsd: number,
  calls = 1
): typeof KindCost.Type => ({
  cacheRead: 30_000 * calls,
  cacheWrite: 0,
  calls,
  costUsd,
  inputTokens: 2 * calls,
  kind,
  outputTokens: 600 * calls,
});

export const projectSummary = (
  extra: Partial<typeof ProjectSummary.Type> = {}
): typeof ProjectSummary.Type => ({
  brief: kindCost("brief", 0, 0),
  calls: [],
  costByKind: [],
  id: "1",
  name: "Обменник",
  questions: {
    answered: 0,
    asked: 0,
    created: 0,
    hidden: 0,
    pinned: 0,
    requeued: 0,
    restored: 0,
    shown: 0,
  },
  sources: [],
  ...extra,
});

export const segment = (
  id: string,
  atMs: number,
  text: string,
  channel = "others"
): Timeline["segments"][number] => ({
  channel,
  endMs: atMs + 3000,
  id,
  recordingId: "rec-1",
  startMs: atMs,
  text,
});

export const agentCall = (
  id: string,
  atMs: number,
  extra: Partial<AgentCall> = {}
): AgentCall => ({
  cacheRead: 30_000,
  cacheWrite: 0,
  costUsd: 0.01,
  durationMs: 9000,
  error: null,
  findingsInPrompt: [],
  id,
  inputTokens: 2,
  kind: "fastLoop",
  ops: [],
  outcome: "ok",
  outputTokens: 600,
  promptBytes: 1000,
  recordingId: "rec-1",
  startedAt: START + atMs,
  trigger: "turnEnd",
  triggerSegmentId: null,
  utilization: 0.3,
  windowSegments: [],
  ...extra,
});

export const timeline = (extra: Partial<Timeline> = {}): Timeline => ({
  agentCalls: [],
  call: {
    endedAt: null,
    id: "call-1",
    projectId: "1",
    projectName: "Обменник",
    startedAt: START,
    status: "active",
    title: "Созвон по очереди",
  },
  cards: [],
  costUsd: 0,
  findingSteps: [],
  findings: [],
  liveSegments: [],
  questionSteps: [],
  questions: [],
  recordings: [
    {
      endedAt: null,
      id: "rec-1",
      refined: false,
      startedAt: START,
      status: "recording",
    },
  ],
  segments: [],
  topics: [],
  ...extra,
});

export const details = (
  call: AgentCall,
  extra: Partial<typeof AgentCallDetails.Type> = {}
): typeof AgentCallDetails.Type => ({
  call,
  candidates: [],
  effort: null,
  model: null,
  parts: [{ hash: "h-system", label: "system", text: "Ты помощник." }],
  queries: null,
  rawReply: '{"ops":[]}',
  reply: { ops: [] },
  ...extra,
});

export const question = (
  id: string,
  atMs: number,
  extra: Partial<Timeline["questions"][number]> = {}
): Timeline["questions"][number] => ({
  answerEvidence: null,
  cardField: null,
  createdAt: START + atMs,
  description: "",
  evidence: [],
  gapType: "empty",
  id,
  pinned: false,
  priority: 2,
  recordingId: "rec-1",
  shownAt: null,
  status: "open",
  text: "Сколько ждёт звонок в очереди?",
  topicId: null,
  ...extra,
});

export const finding = (
  id: string,
  atMs: number
): Timeline["findings"][number] => ({
  agentCallId: "slow-1",
  createdAt: START + atMs,
  evictedAt: null,
  hiddenAt: null,
  id,
  note: "Регламент велит отвечать за 30 секунд",
  questionId: null,
  quote: "Оператор отвечает не позже 30 секунд",
  recordingId: "rec-1",
  sourceKind: "outline",
  sourceName: "Регламент смен",
  sourceUrl: "https://outline.example/doc/shifts",
});

export const findingDetails = (
  value: Timeline["findings"][number],
  extra: Partial<typeof FindingDetails.Type> = {}
): typeof FindingDetails.Type => ({
  citedBy: [],
  finding: value,
  givenTo: [],
  steps: [],
  ...extra,
});
