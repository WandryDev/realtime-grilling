import { describe, expect, it } from "vitest";

import type { CardLens } from "@/bindings";
import { TASK_CARD } from "@/features/post-call/mock";
import { CARD_LENS_LABELS } from "@/lib/card-lens";

/*
 * The seven lenses of a task card: the backend sends their ids
 * (`cardField`, a card field's `field`), the screens show them in Russian.
 */

describe("card lenses", () => {
  it("label each of the seven ids, as the task card shows them", () => {
    const ids: CardLens[] = [
      "goal",
      "users",
      "scenarios",
      "edgeCases",
      "integrations",
      "constraints",
      "acceptance",
    ];
    expect(Object.keys(CARD_LENS_LABELS).sort()).toEqual([...ids].sort());
    expect(TASK_CARD.fields.map((field) => field.label)).toEqual(
      ids.map((id) => CARD_LENS_LABELS[id])
    );
  });
});
