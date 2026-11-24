"use client";

// The details beside the timeline (spec «Вызов агента целиком»,
// «Родословная вопроса», «Outline и ClickUp в звонке»). They read their own
// data and keep it while the call goes on: new phrases never close or move
// what is open.

import type {
  AgentCallDetails,
  FindingDetails,
} from "@grill/analytics-server/api";
import { Effect } from "effect";
import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Code } from "@/components/code";
import { inline } from "@/components/markdown";
import {
  clock,
  KIND_NAMES,
  OP_NAMES,
  OUTCOME_NAMES,
  plural,
  reasonText,
  STEP_NAMES,
  seconds,
  TRIGGER_NAMES,
  usd,
} from "@/lib/format";
import { useQuery } from "@/lib/query";
import {
  type AgentCall,
  callsThat,
  findingsCited,
  phraseOf,
  type Selection,
  segmentsCited,
  startOf,
  type Timeline,
} from "./model";
import { Open } from "./open";
import { PromptParts } from "./prompt-parts";
import { Usage } from "./usage";

type Details = typeof AgentCallDetails.Type;
type FindingInfo = typeof FindingDetails.Type;

const Block = ({ children, title }: { children: ReactNode; title: string }) => (
  <div className="border-border flex flex-col gap-2 border-t pt-4 first:border-t-0 first:pt-0">
    <h3 className="text-muted-foreground text-[13px] font-medium">{title}</h3>
    {children}
  </div>
);

const segmentText = (timeline: Timeline, id: string | null) =>
  phraseOf(timeline, id)?.text;

/** What an operation was about, from its body. */
const opTitle = (body: unknown): string => {
  if (typeof body !== "object" || body === null) {
    return "";
  }
  const fields = body as Record<string, unknown>;
  for (const key of ["title", "text", "value", "quote", "decision"]) {
    if (typeof fields[key] === "string") {
      return fields[key] as string;
    }
  }
  return "";
};

export const AgentCallPanel = ({
  id,
  onSelect,
  timeline,
}: {
  id: string;
  onSelect: (selection: Selection) => void;
  timeline: Timeline;
}) => {
  const summary = timeline.agentCalls.find((call) => call.id === id);
  // The call before it of the same kind: its parts that repeat are marked.
  const previous = summary
    ? timeline.agentCalls
        .filter(
          (call) =>
            call.kind === summary.kind && call.startedAt < summary.startedAt
        )
        .at(-1)
    : undefined;
  const { query } = useQuery(
    `agent-call:${id}:${previous?.id ?? ""}`,
    (api) =>
      Effect.all([
        api.read.agentCall({ params: { id } }),
        previous
          ? api.read.agentCall({ params: { id: previous.id } })
          : Effect.succeed(null),
      ]),
    null
  );
  if (!summary) {
    return (
      <p className="text-muted-foreground text-sm">Вызов ещё не пришёл.</p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="agent-call-panel">
      {summary.error ? (
        <div className="bg-contradiction-soft text-contradiction rounded-[10px] px-3 py-2 text-[13px]">
          {summary.error}
        </div>
      ) : null}
      <Trigger call={summary} timeline={timeline} />
      <Block title="Расход">
        <Usage call={summary} timeline={timeline} />
      </Block>
      <Block title={`Операции · ${summary.ops.length}`}>
        {summary.ops.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            Ответ без операций.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {summary.ops.map((op) => (
              <OpItem
                details={query.status === "ready" ? query.data[0] : null}
                key={op.idx}
                onSelect={onSelect}
                op={op}
              />
            ))}
          </ul>
        )}
      </Block>
      {query.status === "ready" ? (
        <Prompt details={query.data[0]} previous={query.data[1]} />
      ) : (
        <Block title="Промпт">
          <p className="text-muted-foreground text-[13px]">Загружаем…</p>
        </Block>
      )}
    </div>
  );
};

type Op = AgentCall["ops"][number];

/** An operation of the reply and what became of it. */
const OpItem = ({
  details,
  onSelect,
  op,
}: {
  details: Details | null;
  onSelect: (selection: Selection) => void;
  op: Op;
}) => {
  const body = details ? reply(details, op.idx) : null;
  const opens: Selection | null =
    op.applied &&
    op.subjectId &&
    (op.subjectKind === "question" || op.subjectKind === "finding")
      ? { id: op.subjectId, kind: op.subjectKind }
      : null;
  return (
    <li className="flex flex-col gap-0.5 text-[13px]" data-testid="op">
      <div className="flex gap-2">
        <span className={op.applied ? "text-confirmed" : "text-accent-ink"}>
          {op.applied ? "применена" : "отклонена"}
        </span>
        <span className="font-medium">{OP_NAMES[op.op] ?? op.op}</span>
      </div>
      {body ? <div className="text-foreground">{opTitle(body)}</div> : null}
      {op.applied ? null : (
        <div className="text-muted-foreground">{reasonText(op.reason)}</div>
      )}
      {opens ? (
        <Open onSelect={onSelect} target={opens}>
          {opens.kind === "question" ? "Открыть вопрос" : "Открыть находку"}
        </Open>
      ) : null}
    </li>
  );
};

/** The reply's operation `idx` as the agent returned it. */
const reply = (details: Details, idx: number): unknown => {
  const value = details.reply as Record<string, unknown> | null;
  const list = (value?.ops ?? value?.findings) as unknown[] | undefined;
  return Array.isArray(list) ? list[idx] : value;
};

const Trigger = ({
  call,
  timeline,
}: {
  call: AgentCall;
  timeline: Timeline;
}) => {
  if (!call.trigger) {
    return null;
  }
  const phrase = segmentText(timeline, call.triggerSegmentId);
  return (
    <Block title="Почему запущен">
      <div className="text-[13px]">
        {TRIGGER_NAMES[call.trigger] ?? call.trigger}
      </div>
      {phrase ? (
        <blockquote className="text-muted-foreground text-[13px]">
          «{phrase}»
        </blockquote>
      ) : null}
      {call.windowSegments ? (
        <div className="text-muted-foreground text-[12px]">
          В промпте {call.windowSegments.length} фраз расшифровки — они
          подсвечены в таймлайне
        </div>
      ) : null}
    </Block>
  );
};

const QueryList = ({ queries }: { queries: readonly string[] }) => (
  <ul className="flex flex-col gap-1 text-[13px]">
    {queries.map((query) => (
      <li className="flex items-center gap-2" key={query}>
        <SearchIcon
          aria-hidden
          className="text-muted-foreground size-3.5 shrink-0"
        />
        {query}
      </li>
    ))}
  </ul>
);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The search the slow loop ran: the agent's queries as a list, the
 * client's phrase it searched by as a quote; JSON for anything else.
 */
const Queries = ({ queries }: { queries: unknown }) => {
  if (isStrings(queries)) {
    return <QueryList queries={queries} />;
  }
  const fields =
    typeof queries === "object" && queries !== null
      ? (queries as Record<string, unknown>)
      : null;
  if (fields && isStrings(fields.agent)) {
    return (
      <div className="flex flex-col gap-2">
        <QueryList queries={fields.agent} />
        {typeof fields.client === "string" ? (
          <div className="text-muted-foreground text-[12px]">
            И по фразе клиента: «{fields.client}»
          </div>
        ) : null}
      </div>
    );
  }
  return <Code code={JSON.stringify(queries, null, 2)} language="json" />;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * What the CLI returned, colored: the agent's patch first when the reply
 * carries it, then the whole reply.
 */
const CliReply = ({ raw }: { raw: string }) => {
  const parsed = parseJson(raw);
  if (parsed === undefined) {
    return <Code code={raw} language="markdown" title="Текст" />;
  }
  const patch =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).structured_output
      : undefined;
  const whole = JSON.stringify(parsed, null, 2);
  return (
    <div className="flex flex-col gap-3">
      {patch === undefined ? null : (
        <Code
          code={JSON.stringify(patch, null, 2)}
          language="json"
          title="Патч агента · structured_output"
        />
      )}
      <Code
        code={whole}
        language="json"
        maxHeight={patch === undefined ? "max-h-[420px]" : "max-h-60"}
        title="Весь ответ CLI"
      />
    </div>
  );
};

const PARTS = ["часть", "части", "частей"] as const;

const Prompt = ({
  details,
  previous,
}: {
  details: Details;
  previous: Details | null;
}) => (
  <>
    {details.queries ? (
      <Block title="Поисковые запросы">
        <Queries queries={details.queries} />
      </Block>
    ) : null}
    {details.candidates.length > 0 ? (
      <Block title={`Кандидаты · ${details.candidates.length}`}>
        <ul className="flex flex-col gap-2">
          {details.candidates.map((candidate) => (
            <li className="text-[13px]" key={candidate.label}>
              <span className="font-medium">{candidate.label}</span>{" "}
              {candidate.sourceUrl ? (
                <a
                  className="hover:underline"
                  href={candidate.sourceUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {candidate.sourceName}
                </a>
              ) : (
                candidate.sourceName
              )}
              {candidate.headingPath ? (
                <span className="text-muted-foreground">
                  {" "}
                  › {candidate.headingPath}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Block>
    ) : null}
    <Block title={`Промпт · ${plural(details.parts.length, PARTS)}`}>
      <PromptParts details={details} previous={previous} />
    </Block>
    <Block title="Ответ CLI">
      {details.rawReply ? (
        <CliReply raw={details.rawReply} />
      ) : (
        <p className="text-muted-foreground text-[13px]" data-testid="no-reply">
          Ответа нет.
        </p>
      )}
    </Block>
  </>
);

export const QuestionPanel = ({
  id,
  onSelect,
  timeline,
}: {
  id: string;
  onSelect: (selection: Selection) => void;
  timeline: Timeline;
}) => {
  const question = timeline.questions.find((item) => item.id === id);
  if (!question) {
    return (
      <p className="text-muted-foreground text-sm">Вопрос ещё не пришёл.</p>
    );
  }
  const start = startOf(timeline);
  const created = callsThat(timeline, "question", id);
  const answered = callsThat(timeline, "answered", id);
  const steps = timeline.questionSteps.filter((step) => step.subjectId === id);
  const grounds = segmentsCited(question.evidence);
  const findings = findingsCited(question.evidence);
  return (
    <div className="flex flex-col gap-4" data-testid="question-panel">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{question.text}</h2>
        {question.description ? (
          <p className="text-muted-foreground text-[13px]">
            {question.description}
          </p>
        ) : null}
      </div>
      <Block title="Создан вызовом">
        {created.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            Вызов не известен.
          </p>
        ) : (
          created.map((call) => (
            <Open
              className="text-[13px]"
              key={call.id}
              onSelect={onSelect}
              target={{ id: call.id, kind: "agentCall" }}
            >
              {KIND_NAMES[call.kind]} · {clock(call.startedAt - start)}
            </Open>
          ))
        )}
      </Block>
      <Block title="Основания">
        {grounds.map((segmentId) => (
          <blockquote className="text-[13px]" key={segmentId}>
            «{segmentText(timeline, segmentId) ?? "фраза не в этой расшифровке"}
            »
          </blockquote>
        ))}
        {findings.map((findingId) => {
          const finding = timeline.findings.find(
            (item) => item.id === findingId
          );
          return (
            <Open
              className="text-[13px]"
              key={findingId}
              onSelect={onSelect}
              target={{ id: findingId, kind: "finding" }}
            >
              Находка · {finding?.sourceName ?? findingId}
            </Open>
          );
        })}
      </Block>
      <Block title="История">
        <ol className="flex flex-col gap-1" data-testid="history">
          {steps.map((step) => (
            <li className="flex gap-3 text-[13px] tabular-nums" key={step.id}>
              <span className="text-muted-foreground w-14">
                {clock(step.at - start)}
              </span>
              <span>{STEP_NAMES[step.step] ?? step.step}</span>
            </li>
          ))}
        </ol>
      </Block>
      {answered.length > 0 ? (
        <Block title="Ответ">
          {answered.map((call) => (
            <Open
              className="text-[13px]"
              key={call.id}
              onSelect={onSelect}
              target={{ id: call.id, kind: "agentCall" }}
            >
              {KIND_NAMES[call.kind]} · {clock(call.startedAt - start)}
            </Open>
          ))}
          {segmentsCited(question.answerEvidence).map((segmentId) => (
            <blockquote className="text-[13px]" key={segmentId}>
              «
              {segmentText(timeline, segmentId) ??
                "фраза не в этой расшифровке"}
              »
            </blockquote>
          ))}
        </Block>
      ) : null}
    </div>
  );
};

export const FindingPanel = ({
  id,
  onSelect,
  timeline,
}: {
  id: string;
  onSelect: (selection: Selection) => void;
  timeline: Timeline;
}) => {
  const { query } = useQuery(
    `finding:${id}`,
    (api) => api.read.finding({ params: { id } }),
    null
  );
  if (query.status !== "ready") {
    return <p className="text-muted-foreground text-sm">Загружаем…</p>;
  }
  return <Finding info={query.data} onSelect={onSelect} timeline={timeline} />;
};

const Finding = ({
  info,
  onSelect,
  timeline,
}: {
  info: FindingInfo;
  onSelect: (selection: Selection) => void;
  timeline: Timeline;
}) => {
  const start = startOf(timeline);
  const { finding } = info;
  return (
    <div className="flex flex-col gap-4" data-testid="finding-panel">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {finding.sourceUrl ? (
            <a
              className="hover:underline"
              href={finding.sourceUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {finding.sourceName}
            </a>
          ) : (
            finding.sourceName
          )}
        </h2>
        <blockquote className="text-[14px]">
          «{inline(finding.quote)}»
        </blockquote>
        <p className="text-muted-foreground text-[13px]">{finding.note}</p>
      </div>
      <Block title="Нашёл вызов">
        {finding.agentCallId ? (
          <Open
            className="text-[13px]"
            onSelect={onSelect}
            target={{ id: finding.agentCallId, kind: "agentCall" }}
          >
            Медленный контур
          </Open>
        ) : (
          <p className="text-muted-foreground text-[13px]">—</p>
        )}
      </Block>
      <Block title={`В промпте вызовов · ${info.givenTo.length}`}>
        <ul className="flex flex-col gap-1" data-testid="given-to">
          {info.givenTo.map((callId) => {
            const call = timeline.agentCalls.find((item) => item.id === callId);
            const label = call
              ? `${KIND_NAMES[call.kind]} · ${clock(call.startedAt - start)}`
              : callId;
            return (
              <li key={callId}>
                <Open
                  className="text-[13px]"
                  onSelect={onSelect}
                  target={{ id: callId, kind: "agentCall" }}
                >
                  {label}
                </Open>
              </li>
            );
          })}
        </ul>
      </Block>
      <Block title={`Вопросы с этим основанием · ${info.citedBy.length}`}>
        <ul className="flex flex-col gap-1" data-testid="cited-by">
          {info.citedBy.map((questionId) => (
            <li key={questionId}>
              <Open
                className="text-[13px]"
                onSelect={onSelect}
                target={{ id: questionId, kind: "question" }}
              >
                {timeline.questions.find((item) => item.id === questionId)
                  ?.text ?? questionId}
              </Open>
            </li>
          ))}
        </ul>
      </Block>
      <Block title="Судьба">
        <ol className="flex flex-col gap-1">
          {info.steps.map((step) => (
            <li className="flex gap-3 text-[13px] tabular-nums" key={step.id}>
              <span className="text-muted-foreground w-14">
                {clock(step.at - start)}
              </span>
              <span>
                {step.step === "hidden"
                  ? "убрана менеджером"
                  : (STEP_NAMES[step.step] ?? step.step)}
              </span>
            </li>
          ))}
        </ol>
      </Block>
    </div>
  );
};

const Head = ({ sub, title }: { sub: ReactNode; title: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <h2 className="truncate text-lg font-semibold tracking-tight">{title}</h2>
    <div className="text-muted-foreground truncate text-[13px] tabular-nums">
      {sub}
    </div>
  </div>
);

/** What is open beside the timeline, kept in view while its details scroll. */
export const DetailsHead = ({
  selection,
  timeline,
}: {
  selection: Selection;
  timeline: Timeline;
}) => {
  const start = startOf(timeline);
  if (selection.kind === "agentCall") {
    const call = timeline.agentCalls.find((item) => item.id === selection.id);
    if (!call) {
      return <Head sub="ещё не пришёл" title="Вызов агента" />;
    }
    const failed = !["ok", "empty"].includes(call.outcome);
    return (
      <Head
        sub={
          <>
            {clock(call.startedAt - start)} · {seconds(call.durationMs)} ·{" "}
            <span className={failed ? "text-contradiction" : ""}>
              {OUTCOME_NAMES[call.outcome] ?? call.outcome}
            </span>{" "}
            · {usd(call.costUsd)}
          </>
        }
        title={KIND_NAMES[call.kind] ?? call.kind}
      />
    );
  }
  if (selection.kind === "question") {
    const question = timeline.questions.find(
      (item) => item.id === selection.id
    );
    return (
      <Head
        sub={
          question
            ? `создан ${clock(question.createdAt - start)} · ${STEP_NAMES[question.status] ?? (question.status === "open" ? "открыт" : question.status)}`
            : "ещё не пришёл"
        }
        title="Вопрос"
      />
    );
  }
  const finding = timeline.findings.find((item) => item.id === selection.id);
  return (
    <Head
      sub={
        finding
          ? `${finding.sourceName} · ${clock(finding.createdAt - start)}`
          : "ещё не пришла"
      }
      title="Находка"
    />
  );
};
