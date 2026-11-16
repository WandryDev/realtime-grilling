import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "@/components/ui/badge";
import { Progress, ProgressValue } from "@/components/ui/progress";
import {
  AgentStatus,
  RecordingIndicator,
} from "@/components/ui/recording-indicator";
import { TopicAnchor } from "@/components/ui/topic-anchor";

describe("TopicAnchor", () => {
  it("marks only the current topic with aria-current", () => {
    render(
      <>
        <TopicAnchor count={2}>Приём звонков</TopicAnchor>
        <TopicAnchor active count={5}>
          Интеграция с CRM
        </TopicAnchor>
      </>
    );

    const current = screen.getByRole("button", {
      name: "Интеграция с CRM, вопросов: 5",
    });
    const other = screen.getByRole("button", {
      name: "Приём звонков, вопросов: 2",
    });

    expect(current.getAttribute("aria-current")).toBe("true");
    expect(other.hasAttribute("aria-current")).toBe(false);
  });

  it("includes the open-question count in its name", () => {
    render(<TopicAnchor count={2}>Приём звонков</TopicAnchor>);

    expect(
      screen.getByRole("button", { name: "Приём звонков, вопросов: 2" })
    ).toBeDefined();
  });
});

describe("Badge", () => {
  it("hides the status dot from assistive tech", () => {
    const { container } = render(
      <Badge variant="contradiction">противоречие</Badge>
    );

    const dot = container.querySelector("[data-slot=badge-dot]");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("противоречие")).toBeDefined();
  });

  it("renders no marker for the waiting status", () => {
    const { container } = render(<Badge variant="waiting">ждёт клиента</Badge>);

    expect(container.querySelector("[data-slot=badge-dot]")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("RecordingIndicator", () => {
  it("renders the call time inside a timer", () => {
    render(<RecordingIndicator time="24:18" />);

    const timer = screen.getByRole("timer", { name: "Идёт запись, 24:18" });
    expect(timer.textContent).toContain("24:18");
  });

  it("says when the recording is paused", () => {
    render(<RecordingIndicator paused time="24:18" />);

    expect(
      screen.getByRole("timer", { name: "Запись на паузе, 24:18" })
    ).toBeDefined();
    expect(screen.getByText("пауза")).toBeDefined();
  });

  it("draws the levels of both channels, hidden from screen readers", () => {
    const { container } = render(
      <RecordingIndicator level={{ me: 0.5, others: 0 }} time="24:18" />
    );

    const meter = container.querySelector(
      '[data-slot="recording-indicator-level"]'
    );
    expect(meter?.getAttribute("aria-hidden")).toBe("true");
    const fills = [
      ...container.querySelectorAll(
        '[data-slot="recording-indicator-level-bar"] > span'
      ),
    ].map((fill) => (fill as HTMLElement).style.height);
    // Half of 12px for "Я", the 2px stub for silent "Остальные".
    expect(fills).toEqual(["6px", "2px"]);
    expect(
      screen.getByRole("timer", { name: "Идёт запись, 24:18" })
    ).toBeDefined();
  });

  it("draws no levels without them or while paused", () => {
    const { container } = render(
      <>
        <RecordingIndicator time="24:18" />
        <RecordingIndicator level={{ me: 1, others: 1 }} paused time="1:00" />
      </>
    );

    expect(
      container.querySelector('[data-slot="recording-indicator-level"]')
    ).toBeNull();
  });

  it("names a channel's trouble for screen readers", () => {
    const { container } = render(
      <RecordingIndicator
        time="24:18"
        warning="Нет доступа к звуку собеседников"
      />
    );

    expect(
      screen.getByRole("timer", {
        name: "Идёт запись, 24:18. Нет доступа к звуку собеседников",
      })
    ).toBeDefined();
    expect(
      container.querySelector('[data-slot="recording-indicator-warning"]')
    ).not.toBeNull();
  });
});

describe("AgentStatus", () => {
  it("announces what the agent is doing", () => {
    render(<AgentStatus state="thinking" />);

    expect(screen.getByRole("status").textContent).toBe("думаю над вопросами");
  });
});

describe("Progress", () => {
  it("exposes its value and shows the percent without a space", () => {
    render(
      <Progress aria-label="Скачиваю модель речи" value={62}>
        <ProgressValue />
      </Progress>
    );

    const bar = screen.getByRole("progressbar", {
      name: "Скачиваю модель речи",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText("62%")).toBeDefined();
  });

  it("switches to the done tone when full", () => {
    render(<Progress aria-label="Модель речи готова" value={100} />);

    expect(screen.getByRole("progressbar").getAttribute("data-tone")).toBe(
      "done"
    );
  });
});
