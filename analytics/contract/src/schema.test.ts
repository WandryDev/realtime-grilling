import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Envelope, VERSION } from "./schema";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const fixtures = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    name,
    value: JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown,
  }));

const decode = Schema.decodeUnknownSync(Envelope);

describe("the contract's samples", () => {
  it("has one sample of every kind", () => {
    expect(fixtures.map(({ name }) => name).sort()).toEqual(
      [
        "agentCall",
        "agentCallOp",
        "call",
        "card",
        "finding",
        "findingEvent",
        "project",
        "promptPart",
        "question",
        "questionEvent",
        "recording",
        "refinedTranscript",
        "segment",
        "topic",
      ].map((kind) => `${kind}.json`)
    );
  });

  it.each(fixtures)("decodes $name", ({ name, value }) => {
    const event = decode(value);
    expect(`${event.kind}.json`).toBe(name);
    expect(event.v).toBe(VERSION);
  });

  it("refuses an event of an unknown kind", () => {
    expect(() =>
      decode({ at: 1, body: {}, id: "x", kind: "manager", v: 1 })
    ).toThrow();
  });

  it("refuses a body that does not fit its kind", () => {
    const project = fixtures.find(({ name }) => name === "project.json");
    expect(() =>
      decode({
        ...(project?.value as object),
        body: { localId: 1 },
      })
    ).toThrow();
  });
});
