import { describe, expect, it } from "vitest";

import type { CallRecord } from "@/data/calls";
import { callsSummaryOf, callWhen } from "@/features/projects/call-lines";

/* The call rows of home and the project page: when, and the line under «Звонки». */

const NOW = new Date(2026, 10, 6, 15, 0).getTime();

function record(startedAt: number, openCount = 0): CallRecord {
  const start = new Date(startedAt);
  return {
    date: `${start.getDate()} ноя`,
    dateLabel: "",
    day: "",
    duration: "10:00",
    endedAt: startedAt + 600_000,
    id: String(startedAt),
    month: "Ноябрь",
    openCount,
    participantIds: [],
    participants: "",
    projectId: "p",
    startedAt,
    time: "12:00",
    title: "",
  };
}

describe("callWhen", () => {
  it("names today and yesterday, the date otherwise, the year of another year", () => {
    expect(callWhen(record(new Date(2026, 10, 6, 0, 5).getTime()), NOW)).toBe(
      "сегодня 12:00"
    );
    expect(callWhen(record(new Date(2026, 10, 5, 23, 0).getTime()), NOW)).toBe(
      "вчера 12:00"
    );
    expect(callWhen(record(new Date(2026, 10, 4, 12, 0).getTime()), NOW)).toBe(
      "4 ноя 12:00"
    );
    expect(callWhen(record(new Date(2025, 10, 4, 12, 0).getTime()), NOW)).toBe(
      "4 ноя 2025"
    );
  });
});

describe("callsSummaryOf", () => {
  it("counts the calls and their open questions", () => {
    expect(callsSummaryOf([], 3)).toEqual({ hidden: 0, summary: "пока пусто" });
    expect(callsSummaryOf([{ call: record(NOW) }], 3)).toEqual({
      hidden: 0,
      summary: "1 звонок",
    });
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      call: record(NOW - index, 1),
    }));
    expect(callsSummaryOf(eleven, 3)).toEqual({
      hidden: 8,
      summary: "11 звонков, 11 открытых вопросов",
    });
  });
});
