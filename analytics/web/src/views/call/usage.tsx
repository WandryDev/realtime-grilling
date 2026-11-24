// What an agent call spent, drawn rather than listed: the tokens as one
// segmented bar (where they went, by share) and the Claude subscription's
// limit as a meter, with how much this call moved it. Both are dithered: a
// part is told by its pattern as well as its tone, so it reads in grayscale
// and to every eye, and the legend names each part.

import type { CSSProperties } from "react";
import { seconds, tokens, usd } from "@/lib/format";
import type { AgentCall, Timeline } from "./model";

/** A fill of `color` at a density: dots, a 1px checker, or solid. */
const dither = (
  color: string,
  density: "sparse" | "half" | "dense" | "solid"
): CSSProperties => {
  if (density === "solid") {
    return { backgroundColor: color };
  }
  if (density === "half") {
    return {
      backgroundImage: `repeating-conic-gradient(${color} 0 25%, transparent 0 50%)`,
      backgroundSize: "2px 2px",
    };
  }
  if (density === "dense") {
    return {
      backgroundImage: `radial-gradient(circle, transparent 0.5px, ${color} 0.75px)`,
      backgroundSize: "2px 2px",
    };
  }
  return {
    backgroundImage: `radial-gradient(circle, ${color} 0.6px, transparent 0.8px)`,
    backgroundSize: "3px 3px",
  };
};

const INK = "var(--foreground)";

/** The parts of a call's tokens, in a fixed order; each its own pattern. */
const PARTS = [
  {
    fill: dither(INK, "solid"),
    key: "inputTokens",
    name: "Вход без кеша",
  },
  {
    fill: dither(INK, "sparse"),
    key: "cacheRead",
    name: "Чтение кеша",
  },
  {
    fill: dither(INK, "half"),
    key: "cacheWrite",
    name: "Запись кеша",
  },
  {
    fill: dither("var(--accent)", "solid"),
    key: "outputTokens",
    name: "Выход",
  },
] as const;

/** A part narrower than this still shows: a sliver, not nothing. */
const MIN_PART = 3;

const share = (part: number, whole: number) =>
  whole === 0 ? "0 %" : `${Math.round((part / whole) * 100)} %`;

const TokenMix = ({ call }: { call: AgentCall }) => {
  const parts = PARTS.map((part) => ({
    ...part,
    value: call[part.key] ?? 0,
  }));
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const label = parts
    .map(
      (part) =>
        `${part.name}: ${tokens(part.value)}, ${share(part.value, total)}`
    )
    .join("; ");
  return (
    <div className="flex flex-col gap-3">
      <div
        aria-label={`Токены вызова, всего ${tokens(total)}. ${label}`}
        className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full"
        role="img"
      >
        {parts
          .filter((part) => part.value > 0)
          .map((part) => (
            <div
              className="h-full"
              key={part.key}
              style={{
                ...part.fill,
                flexBasis: 0,
                flexGrow: part.value,
                minWidth: MIN_PART,
              }}
              title={`${part.name}: ${tokens(part.value)} · ${share(part.value, total)}`}
            />
          ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] tabular-nums">
        {parts.map((part) => (
          <div className="flex min-w-0 items-center gap-2" key={part.key}>
            <span
              aria-hidden
              className="border-border size-2.5 shrink-0 rounded-[3px] border"
              style={part.fill}
            />
            <dt className="text-muted-foreground truncate">{part.name}</dt>
            <dd className="ml-auto font-medium">{tokens(part.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

/** The meter's tone by how full the limit is: ink, then accent, then red. */
const severity = (fill: number): string => {
  if (fill >= 0.9) {
    return "var(--contradiction)";
  }
  if (fill >= 0.7) {
    return "var(--accent)";
  }
  return INK;
};

const points = (value: number) => Math.round(value * 100);

/** The limit after the call of the same timeline before it, if known. */
const limitBefore = (timeline: Timeline, call: AgentCall): number | null =>
  timeline.agentCalls
    .filter(
      (other) => other.startedAt < call.startedAt && other.utilization !== null
    )
    .at(-1)?.utilization ?? null;

const deltaText = (now: number, before: number | null): string => {
  if (before === null) {
    return "первый вызов звонка с этой цифрой";
  }
  const change = points(now) - points(before);
  if (change < 0) {
    return "окно лимита сбросилось после прошлого вызова";
  }
  return change === 0
    ? "не сдвинулся с прошлого вызова"
    : `+${change} п. п. с прошлого вызова`;
};

const LimitMeter = ({
  before,
  fill,
}: {
  before: number | null;
  fill: number;
}) => {
  const tone = severity(fill);
  const clamped = Math.min(Math.max(fill, 0), 1);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">Лимит Claude после вызова</span>
        <span className="text-[15px] font-semibold tabular-nums">
          {points(fill)} %
        </span>
      </div>
      {/* The native meter speaks; the drawn one is for the eye. */}
      <meter
        aria-label="Лимит подписки Claude после вызова"
        className="sr-only"
        max={100}
        min={0}
        value={points(fill)}
      />
      <div
        aria-hidden
        className="relative h-2.5 w-full overflow-hidden rounded-full"
        style={dither(tone, "sparse")}
      >
        <div
          className="h-full rounded-full"
          style={{ ...dither(tone, "dense"), width: `${clamped * 100}%` }}
        />
        {before !== null && before <= fill ? (
          <div
            className="bg-background absolute top-0 h-full w-[2px]"
            style={{ left: `calc(${Math.min(before, 1) * 100}% - 1px)` }}
            title={`До вызова: ${points(before)} %`}
          />
        ) : null}
      </div>
      <div className="text-muted-foreground text-[12px]">
        {deltaText(fill, before)} · из пятичасового и недельного окон берётся
        более заполненное
      </div>
    </div>
  );
};

/** The block «Расход» of an agent call. */
export const Usage = ({
  call,
  timeline,
}: {
  call: AgentCall;
  timeline: Timeline;
}) => (
  <div className="flex flex-col gap-5">
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[26px] leading-8 font-semibold tracking-tight tabular-nums">
        {usd(call.costUsd)}
      </span>
      <span className="text-muted-foreground text-[13px] tabular-nums">
        эквивалент по ценам API · {seconds(call.durationMs)}
      </span>
    </div>
    <TokenMix call={call} />
    {call.utilization === null ? null : (
      <LimitMeter
        before={limitBefore(timeline, call)}
        fill={call.utilization}
      />
    )}
  </div>
);
