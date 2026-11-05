import { Context, Effect, Layer } from "effect";

import type { TaskSyncService } from "@/data/calls";

/*
 * Backend contract of sending a task card to ClickUp or GitHub after a
 * call; `layerMock` fakes it with a timer in both sets until the
 * integrations exist. The summary is built by Rust (`SummaryData`,
 * `src/data/services/summaries.ts`).
 */

const SEND_MS = 1400;
const FIRST_CLICKUP_TASK = 612;
const FIRST_GITHUB_ISSUE = 48;

export class PostCallBackend extends Context.Service<
  PostCallBackend,
  {
    /** Creates a ClickUp task or a GitHub issue; its reference. */
    readonly sendTaskCard: (
      callId: string,
      cardId: string,
      service: TaskSyncService
    ) => Effect.Effect<string>;
  }
>()("grill/features/post-call/PostCallBackend") {
  static readonly layerMock = Layer.sync(PostCallBackend, () =>
    PostCallBackend.of({ sendTaskCard: mockTaskCards() })
  );

  static readonly layerTauri = PostCallBackend.layerMock;
}

/** Task cards "sent" after a moment, numbered on from the last one. */
function mockTaskCards() {
  let nextClickUpTask = FIRST_CLICKUP_TASK;
  let nextGitHubIssue = FIRST_GITHUB_ISSUE;
  return Effect.fn("PostCallBackend.sendTaskCard")(function* (
    _callId: string,
    _cardId: string,
    service: TaskSyncService
  ) {
    yield* Effect.sleep(SEND_MS);
    if (service === "clickup") {
      const ref = `CU-${nextClickUpTask}`;
      nextClickUpTask += 1;
      return ref;
    }
    const ref = `#${nextGitHubIssue}`;
    nextGitHubIssue += 1;
    return ref;
  });
}
