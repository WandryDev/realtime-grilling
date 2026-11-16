import { describe, expect, it } from "vitest";

import type { Value } from "@/bindings";
import { diffPatch, mergePatch } from "@/lib/merge-patch";

/* JSON merge patch as Rust applies it to a call's summary (RFC 7386). */

describe("mergePatch", () => {
  it("follows the RFC 7386 examples", () => {
    const cases: [Value, Value, Value][] = [
      [{ a: "b" }, { a: "c" }, { a: "c" }],
      [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
      [{ a: "b" }, { a: null }, {}],
      [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
      [{ a: ["b"] }, { a: "c" }, { a: "c" }],
      [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
      [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
      [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
      [
        ["a", "b"],
        ["c", "d"],
        ["c", "d"],
      ],
      [{ a: "b" }, ["c"], ["c"]],
      [{ a: "foo" }, null, null],
      [{ a: "foo" }, "bar", "bar"],
      [{ e: null }, { a: 1 }, { a: 1, e: null }],
      [[1, 2], { a: "b", c: null }, { a: "b" }],
      [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
    ];
    for (const [target, patch, expected] of cases) {
      expect(mergePatch(target, patch)).toEqual(expected);
    }
  });
});

describe("diffPatch", () => {
  it("sends only what changed, so a newer copy keeps other keys", () => {
    const stale: Value = { proposals: { p1: { decision: "pending" } } };
    const decided: Value = {
      proposals: { p1: { decision: "pending" }, p2: { decision: "accepted" } },
    };
    const patch = diffPatch(stale, decided);
    expect(patch).toEqual({ proposals: { p2: { decision: "accepted" } } });

    // Meanwhile another window accepted p1 and set the participants.
    const stored: Value = {
      participants: "Ольга",
      proposals: { p1: { decision: "accepted" } },
    };
    expect(mergePatch(stored, patch ?? null)).toEqual({
      participants: "Ольга",
      proposals: {
        p1: { decision: "accepted" },
        p2: { decision: "accepted" },
      },
    });
  });

  it("removes keys with null and is empty when nothing changed", () => {
    const before: Value = { a: { decision: "rejected", text: "x" }, b: 1 };
    const after: Value = { a: { decision: "rejected" }, b: 1 };
    expect(diffPatch(before, after)).toEqual({ a: { text: null } });
    expect(mergePatch(before, diffPatch(before, after) ?? null)).toEqual(after);
    expect(diffPatch(after, structuredClone(after))).toBeUndefined();
    expect(diffPatch({ a: [1] }, { a: [1, 2] })).toEqual({ a: [1, 2] });
  });
});
