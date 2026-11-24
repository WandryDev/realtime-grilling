import { Context, Effect, Layer, Queue, Stream } from "effect";

import {
  commands,
  events,
  type LimitHit,
  type LimitOutlook,
  type LimitThresholds,
  type LimitWindow,
  type SubscriptionLimitView,
  type WindowMeasure,
} from "@/bindings";
import { type BackendError, call, listenFromCurrent } from "@/effect/tauri";

/*
 * The share of the subscription limit, one for the whole app
 * (agent-limit-guard, `src-tauri/src/agent/limit`): both windows, the
 * thresholds of Grill and the outlook the backend derives from them. Every
 * window follows `SubscriptionLimitChanged`; «Проверить» polls `/usage`;
 * «Продолжить сверх лимита» lets one recording go past the thresholds.
 */
export class AgentLimitData extends Context.Service<
  AgentLimitData,
  {
    /** The share now, then every change, while the stream runs. */
    readonly limit: Stream.Stream<SubscriptionLimitView, BackendError>;
    /** «Проверить»: polls `/usage` and answers the share after it. */
    readonly refresh: Effect.Effect<SubscriptionLimitView, BackendError>;
    /** «Продолжить сверх лимита» for the recording, until it ends. */
    readonly allowOver: (
      recordingId: string
    ) => Effect.Effect<void, BackendError>;
  }
>()("grill/data/AgentLimitData") {
  static readonly layerTauri = Layer.succeed(AgentLimitData, {
    allowOver: (recordingId) =>
      Effect.asVoid(call(() => commands.agentLimitOverride(recordingId))),
    limit: listenFromCurrent(
      events.subscriptionLimitChanged,
      call(() => commands.agentLimitGet()),
      (changed) => changed.limit
    ),
    refresh: call(() => commands.agentLimitRefresh()),
  });

  /* The browser demo: the plain state of `mockAgentLimit`. */
  static readonly layerMock = Layer.succeed(AgentLimitData, {
    allowOver: (recordingId) =>
      Effect.sync(() => mockAgentLimit.allowOver(recordingId)),
    limit: Stream.callback<SubscriptionLimitView, BackendError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          mockAgentLimit.subscribe((view) => {
            Queue.offerUnsafe(queue, view);
          })
        ),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
    ),
    refresh: Effect.sync(() => mockAgentLimit.refresh()),
  });
}

/* ---------------------------------------------------------------- Mock */

/** Points to a threshold under which the warning shows (decision 9). */
const NEAR_MARGIN = 10;

const DEFAULT_THRESHOLDS: LimitThresholds = { session: 90, week: 80 };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SESSION_RESET_IN_MS = 3 * HOUR_MS + 20 * MINUTE_MS;
const WEEK_RESET_IN_MS = 4 * DAY_MS;
const MEASURED_AGO_MS = 4 * MINUTE_MS;

/** The demo's shares: well below the default thresholds. */
const DEMO_SESSION = 38;
const DEMO_WEEK = 21;

function measure(used: number, resetsInMs: number, now: number): WindowMeasure {
  return {
    measuredAt: now - MEASURED_AGO_MS,
    resetsAt: now + resetsInMs,
    source: "usage",
    used,
  };
}

/** Like `State::outlook` in Rust: the backend's rule, for the mock only. */
function outlookOf(
  session: WindowMeasure | null,
  week: WindowMeasure | null,
  thresholds: LimitThresholds
): LimitOutlook {
  let reached: LimitHit | null = null;
  let near: { gap: number; hit: LimitHit } | null = null;
  const windows: [LimitWindow, WindowMeasure | null][] = [
    ["session", session],
    ["week", week],
  ];
  for (const [window, shown] of windows) {
    const threshold = thresholds[window];
    if (shown === null || threshold === null) {
      continue;
    }
    const hit: LimitHit = {
      resetsAt: shown.resetsAt,
      threshold,
      used: shown.used,
      window,
    };
    const gap = threshold - shown.used;
    const later = (other: LimitHit) =>
      other.resetsAt ?? Number.POSITIVE_INFINITY;
    if (gap <= 0) {
      if (reached === null || later(hit) > later(reached)) {
        reached = hit;
      }
    } else if (gap < NEAR_MARGIN && (near === null || gap < near.gap)) {
      near = { gap, hit };
    }
  }
  if (reached) {
    return { hit: reached, kind: "reached" };
  }
  return near ? { hit: near.hit, kind: "near" } : { kind: "ok" };
}

interface MockLimitState {
  over: Set<string>;
  session: WindowMeasure | null;
  thresholds: LimitThresholds;
  week: WindowMeasure | null;
}

function initialState(): MockLimitState {
  const now = Date.now();
  return {
    over: new Set(),
    session: measure(DEMO_SESSION, SESSION_RESET_IN_MS, now),
    thresholds: DEFAULT_THRESHOLDS,
    week: measure(DEMO_WEEK, WEEK_RESET_IN_MS, now),
  };
}

let mockState = initialState();
const mockListeners = new Set<(view: SubscriptionLimitView) => void>();

function mockView(): SubscriptionLimitView {
  const { session, thresholds, week } = mockState;
  return {
    checking: false,
    outlook: outlookOf(session, week, thresholds),
    session,
    thresholds,
    week,
  };
}

function publish() {
  const view = mockView();
  for (const listener of mockListeners) {
    listener(view);
  }
}

/*
 * The share `layerMock` reports. Plain synchronous state, so the demo, the
 * `/dev` pages and the tests can put the limit anywhere.
 */
export const mockAgentLimit = {
  allowOver(recordingId: string) {
    mockState.over.add(recordingId);
    publish();
  },
  /** Whether «сверх лимита» was chosen for the recording. */
  isOver(recordingId: string) {
    return mockState.over.has(recordingId);
  },
  /** «Проверить»: the demo's poll finds the shares as they are. */
  refresh(): SubscriptionLimitView {
    const now = Date.now();
    for (const window of ["session", "week"] as const) {
      const shown = mockState[window];
      if (shown) {
        mockState[window] = { ...shown, measuredAt: now, source: "usage" };
      }
    }
    publish();
    return mockView();
  },
  reset() {
    mockState = initialState();
    publish();
  },
  /** Both windows in whole percents; `null`: «нет данных». */
  setShares(session: number | null, week: number | null) {
    const now = Date.now();
    mockState.session =
      session === null ? null : measure(session, SESSION_RESET_IN_MS, now);
    mockState.week =
      week === null ? null : measure(week, WEEK_RESET_IN_MS, now);
    publish();
  },
  setThresholds(thresholds: LimitThresholds) {
    mockState.thresholds = thresholds;
    publish();
  },
  subscribe(listener: (view: SubscriptionLimitView) => void) {
    mockListeners.add(listener);
    listener(mockView());
    return () => {
      mockListeners.delete(listener);
    };
  },
  view: mockView,
};

/** A threshold setting (`"off"`, `"90"`…) in percents; `null`: none. */
export function thresholdOf(value: unknown): number | null {
  if (value === "off") {
    return null;
  }
  const percent = Number(value);
  return Number.isInteger(percent) && percent > 0 ? percent : null;
}
