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
import type { ReactNode } from "react";
import {
  clock,
  KIND_NAMES,
  OUTCOME_NAMES,
  percent,
  reasonText,
  STEP_NAMES,
  seconds,
  TRIGGER_NAMES,
  tokens,
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

type Details = typeof AgentCallDetails.Type;
type FindingInfo = typeof FindingDetails.Type;

const Block = ({ children, title }: { children: ReactNode; title: string }) => (
  <div className="border-border flex flex-col gap-2 border-t pt-4">
    <h3 className="text-muted-foreground text-[13px] font-medium">{title}</h3>
    {children}
  </div>
);

const Fact = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex justify-between gap-3 text-[13px] tabular-nums">
    <span className="text-muted-foreground">{label}</span>
    <span>{value}</span>
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

const OP_NAMES: Record<string, string> = {
  answered: "Ответ на вопрос",
  card: "Факт карточки",
  finalCheck: "Финальная проверка",
  finding: "Находка",
  new: "Новая тема",
  question: "Вопрос",
  same: "Тема та же",
  switch: "Смена темы",
  topic: "Тема",
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
  const start = startOf(timeline);
  return (
    <div className="flex flex-col gap-4" data-testid="agent-call-panel">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {KIND_NAMES[summary.kind] ?? summary.kind}
        </h2>
        <div className="text-muted-foreground text-[13px] tabular-nums">
          {clock(summary.startedAt - start)} · {seconds(summary.durationMs)} ·{" "}
          <span
            className={
              summary.outcome === "ok" || summary.outcome === "empty"
                ? ""
                : "text-contradiction"
            }
          >
            {OUTCOME_NAMES[summary.outcome] ?? summary.outcome}
          </span>
        </div>
        {summary.error ? (
          <div className="text-contradiction text-[13px]">{summary.error}</div>
        ) : null}
      </div>
      <Trigger call={summary} timeline={timeline} />
      <Block title="Расход">
        <Fact label="Вход" value={tokens(summary.inputTokens)} />
        <Fact label="Чтение кеша" value={tokens(summary.cacheRead)} />
        <Fact label="Запись кеша" value={tokens(summary.cacheWrite)} />
        <Fact label="Выход" value={tokens(summary.outputTokens)} />
        <Fact label="Эквивалент" value={usd(summary.costUsd)} />
        <Fact
          label="Доля лимита подписки"
          value={
            summary.utilization === null ? "—" : percent(summary.utilization, 1)
          }
        />
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

const Prompt = ({
  details,
  previous,
}: {
  details: Details;
  previous: Details | null;
}) => {
  const before = new Set(previous?.parts.map((part) => part.hash) ?? []);
  return (
    <>
      {details.queries ? (
        <Block title="Поисковые запросы">
          <pre className="font-mono text-[12px] whitespace-pre-wrap">
            {JSON.stringify(details.queries, null, 2)}
          </pre>
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
      <Block title={`Промпт · ${details.parts.length} частей`}>
        {details.parts.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            Промпт не уходил в CLI.
          </p>
        ) : null}
        {details.parts.map((part) => (
          <details
            className="bg-surface rounded-lg px-3 py-2"
            key={`${part.label}:${part.hash}`}
          >
            <summary className="cursor-pointer text-[13px]">
              <span className="font-medium">{part.label}</span>
              <span className="text-muted-foreground">
                {" "}
                ·{" "}
                {part.text === null
                  ? "текст ещё не пришёл"
                  : `${part.text.length} символов`}
                {before.has(part.hash) ? " · как в прошлом вызове" : ""}
              </span>
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto font-mono text-[12px] whitespace-pre-wrap">
              {part.text}
            </pre>
          </details>
        ))}
      </Block>
      <Block title="Ответ CLI">
        {details.rawReply ? (
          <pre className="bg-surface max-h-80 overflow-auto rounded-lg p-3 font-mono text-[12px] whitespace-pre-wrap">
            {details.rawReply}
          </pre>
        ) : (
          <p
            className="text-muted-foreground text-[13px]"
            data-testid="no-reply"
          >
            Ответа нет.
          </p>
        )}
      </Block>
    </>
  );
};

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
        <blockquote className="text-[14px]">«{finding.quote}»</blockquote>
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
