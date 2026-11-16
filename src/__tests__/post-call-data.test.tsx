import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCallSearch, useCallTranscript } from "@/data/call-records";
import { resetCalls, useCall } from "@/data/calls";
import { usePerson } from "@/data/people";
import { decideProposal, usePersonProposals } from "@/data/proposals";
import { DEMO_CALL_ID } from "@/data/services/mock-seed";
import { MOCK_STAGE_MS } from "@/data/services/summaries";
import { buildSummary, useCallSummary } from "@/data/summaries";

/*
 * The post-call hooks in the browser: they read the demo records at once,
 * a decision shows before the action returns, and the mock build walks the
 * stages of `SummaryProgress` on a timer, then re-reads the summary.
 */

function SummaryProbe() {
  const { building, status, summary } = useCallSummary(DEMO_CALL_ID);
  return (
    <p>
      {status}: {summary?.state},{" "}
      {building ? `${building.stage} ${building.state.status}` : "без сборки"}
    </p>
  );
}

function PersonProbe() {
  const person = usePerson("telemedia", "igor");
  const { data } = usePersonProposals("igor");
  const [first] = data;
  const accept = useCallback(() => {
    if (first) {
      decideProposal(first, { decision: "accepted", edited: "Сразу про API" });
    }
  }, [first]);
  return (
    <>
      <p>
        {person?.howToAsk}: {data.length} ожидает
      </p>
      {first ? (
        <button onClick={accept} type="button">
          Принять
        </button>
      ) : null}
    </>
  );
}

function RecordsProbe() {
  const recordings = useCallTranscript(DEMO_CALL_ID);
  const found = useCallSearch("amoCRM", "telemedia");
  const call = useCall(DEMO_CALL_ID);
  return (
    <p>
      {recordings.data[0]?.segments.length} реплик, {found.data.total}{" "}
      совпадений, {call?.title}
    </p>
  );
}

afterEach(() => {
  vi.useRealTimers();
  resetCalls();
});

describe("post-call hooks in the browser", () => {
  it("reads the demo records at once", () => {
    render(<RecordsProbe />);
    expect(
      screen.getByText(
        "15 реплик, 11 совпадений, Приём звонков, Интеграция с CRM"
      )
    ).toBeTruthy();
  });

  it("shows an accepted proposal in the profile before the action returns", () => {
    render(<PersonProbe />);
    expect(screen.getByText("ожидает", { exact: false }).textContent).toContain(
      "1 ожидает"
    );
    fireEvent.click(screen.getByRole("button", { name: "Принять" }));
    expect(screen.getByText("Сразу про API: 0 ожидает")).toBeTruthy();
  });

  it("walks the stages of a mock build, then reads the summary", async () => {
    vi.useFakeTimers();
    render(<SummaryProbe />);
    expect(screen.getByText("ready: ready, без сборки")).toBeTruthy();

    await act(() => buildSummary(DEMO_CALL_ID));
    expect(
      screen.getByText("ready: building, transcript running")
    ).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(MOCK_STAGE_MS));
    expect(screen.getByText("ready: building, summary running")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(MOCK_STAGE_MS * 4));
    expect(screen.getByText("ready: ready, без сборки")).toBeTruthy();
  });
});
