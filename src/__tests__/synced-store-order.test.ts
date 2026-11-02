import { Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { DataChanged } from "@/bindings";
import { DataEvents } from "@/data/services/data-events";
import { createReadOrder, createSyncedStore } from "@/data/synced-store";

/*
 * A live store's reads run concurrently and Rust may answer them in any
 * order. A result older than what the store shows must not replace it.
 */

const CHANGE: DataChanged = {
  change: "updated",
  entity: "project",
  id: "p1",
  projectId: "p1",
};

/** A backend whose reads snapshot `value` when they start and wait to answer. */
function controlledBackend() {
  const state = { value: 0 };
  const pending: (() => void)[] = [];
  const read = Effect.promise(
    () =>
      new Promise<number>((resolve) => {
        const snapshot = state.value;
        pending.push(() => resolve(snapshot));
      })
  );
  return { pending, read, state };
}

describe("live store read order", () => {
  it("drops a re-read that answers after a newer one", async () => {
    const changes = Effect.runSync(PubSub.unbounded<DataChanged>());
    const runtime = ManagedRuntime.make(
      Layer.succeed(DataEvents, { changes: Stream.fromPubSub(changes) })
    );
    const backend = controlledBackend();
    const store = createSyncedStore<number, never>({
      empty: -1,
      live: true,
      onChange: () => ({
        update: Effect.map(backend.read, (value) => () => value),
      }),
      read: backend.read,
      runtime,
      seed: () => -1,
    });

    backend.state.value = 1;
    const unsubscribe = store.subscribe(() => undefined);
    await vi.waitFor(() => expect(backend.pending).toHaveLength(1));
    backend.pending[0]?.();
    await vi.waitFor(() => expect(store.get()).toBe(1));

    // Another window writes 2: its event starts a re-read (snapshot 2).
    backend.state.value = 2;
    Effect.runSync(PubSub.publish(changes, CHANGE));
    await vi.waitFor(() => expect(backend.pending).toHaveLength(2));
    // Then 3 is written and this window re-reads everything (snapshot 3).
    backend.state.value = 3;
    const refreshed = store.refresh();
    await vi.waitFor(() => expect(backend.pending).toHaveLength(3));

    // The newer read answers first, the older one after it.
    backend.pending[2]?.();
    await refreshed;
    expect(store.get()).toBe(3);
    backend.pending[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.get()).toBe(3);

    unsubscribe();
    await runtime.dispose();
  });

  it("orders reads per scope, and a full read covers every scope", () => {
    const order = createReadOrder();
    const telemedia1 = order.start();
    const lapa = order.start();
    const telemedia2 = order.start();

    // Different projects don't hide each other, whatever the order.
    expect(order.accept(telemedia2, "telemedia")).toBe(true);
    expect(order.accept(lapa, "lapa")).toBe(true);
    // The same project: the older answer is dropped.
    expect(order.accept(telemedia1, "telemedia")).toBe(false);

    // A full read started before an applied one is older than what is shown.
    const full = order.start();
    const lapa2 = order.start();
    expect(order.accept(lapa2, "lapa")).toBe(true);
    expect(order.accept(full)).toBe(false);

    // A newer full read wins over older reads of any scope.
    const telemedia3 = order.start();
    const full2 = order.start();
    expect(order.accept(full2)).toBe(true);
    expect(order.accept(telemedia3, "telemedia")).toBe(false);
    expect(order.isStale(order.start(), "lapa")).toBe(false);
  });
});
