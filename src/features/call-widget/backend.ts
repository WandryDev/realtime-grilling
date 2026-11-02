import { Context, Effect, Layer, Stream } from "effect";

import {
  type BriefStepItem,
  INCOMING_QUESTIONS,
  type Participant,
} from "./mock";
import { joinNames } from "./names";

/*
 * Backend contract of the floating widgets: the agent refreshing the brief
 * before the call and its live feed during it. `layerMock` fakes both with
 * timers; the Tauri layer will read them from the agent's events.
 */

export interface BriefProgress {
  done: boolean;
  /** Percent of the brief prepared. */
  progress: number;
  steps: BriefStepItem[];
}

export type AgentEvent =
  | { type: "thinking" }
  | { question: string; type: "question" };

const BRIEF_STEP_MS = [700, 900, 1600, 1200];

/** First question a few seconds after the overlay opens, then every 20 s. */
export const FIRST_QUESTION_MS = 4000;
export const NEXT_QUESTION_MS = 20_000;
export const THINKING_MS = 1500;

export class CallWidgetBackend extends Context.Service<
  CallWidgetBackend,
  {
    /**
     * Refreshes the brief for the people on the call. Emits right away with
     * the first step running, then after every step; the last is `done`.
     */
    readonly buildBrief: (
      participants: readonly Participant[]
    ) => Stream.Stream<BriefProgress>;
    /** The agent's live feed: it thinks for a moment, then asks. Endless. */
    readonly agentFeed: Stream.Stream<AgentEvent>;
  }
>()("grill/features/call-widget/CallWidgetBackend") {
  static readonly layerMock = Layer.succeed(CallWidgetBackend, {
    agentFeed: Stream.iterate(0, (index) => index + 1).pipe(
      Stream.flatMap((index) =>
        Stream.concat(
          Stream.fromEffect(
            Effect.as(
              Effect.sleep(
                (index === 0 ? FIRST_QUESTION_MS : NEXT_QUESTION_MS) -
                  THINKING_MS
              ),
              { type: "thinking" } as const
            )
          ),
          Stream.fromEffect(
            Effect.as(Effect.sleep(THINKING_MS), {
              question: INCOMING_QUESTIONS[index % INCOMING_QUESTIONS.length],
              type: "question",
            } as const)
          )
        )
      )
    ),
    buildBrief: (participants: readonly Participant[]) => {
      const plan = briefPlan(participants);
      return Stream.range(0, plan.length).pipe(
        Stream.mapEffect((active) =>
          active === 0
            ? Effect.succeed(briefProgress(plan, active))
            : Effect.as(
                Effect.sleep(BRIEF_STEP_MS[active - 1] ?? 0),
                briefProgress(plan, active)
              )
        )
      );
    },
  });
}

/* Mock ------------------------------------------------------------------ */

function briefPlan(participants: readonly Participant[]) {
  const names = participants.map((person) => person.genitive ?? person.name);
  return [
    { id: "agent", label: "Claude Code на связи" },
    {
      id: "profiles",
      label: names.length > 0 ? `Профили ${joinNames(names)}` : "Профили",
    },
    { id: "outline", label: "Освежаю бриф по Outline", meta: "12 док." },
    { id: "clickup", label: "Ищу вопросы в ClickUp" },
  ];
}

type BriefPlan = ReturnType<typeof briefPlan>;

/** The brief with steps before `active` done and `active` running. */
function briefProgress(plan: BriefPlan, active: number): BriefProgress {
  const done = active >= plan.length;
  return {
    done,
    progress: done ? 100 : Math.round(((active + 0.5) / plan.length) * 100),
    steps: plan.map((step, index) => {
      let status: BriefStepItem["status"] = "pending";
      if (index < active) {
        status = "done";
      } else if (index === active) {
        status = "active";
      }
      return { ...step, status };
    }),
  };
}
