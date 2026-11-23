import { CallRow } from "@grill/ui/call-row";
import { IntegrationRow } from "@grill/ui/integration-row";
import { PersonChip, PersonChipRemove } from "@grill/ui/person-chip";
import { ProjectRow } from "@grill/ui/project-row";
import { formatOpenQuestions } from "@grill/ui/row-status";
import { SetupStep } from "@grill/ui/setup-step";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const SELECTED_CALL = /Школа Ритм/u;
const OTHER_CALL = /Ветклиника Лапа/u;

describe("PersonChip", () => {
  it("removes the person through a labelled button", async () => {
    const onRemove = vi.fn();
    render(
      <PersonChip initials="ИС" name="Игорь Савчук">
        <PersonChipRemove onClick={onRemove} />
      </PersonChip>
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Убрать Игорь Савчук" })
    );

    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("has no remove button unless one is given", () => {
    render(<PersonChip initials="ОД" name="Ольга Демченко" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Ольга Демченко")).toBeDefined();
  });
});

describe("CallRow", () => {
  it("marks only the selected call with aria-current", () => {
    render(
      <>
        <CallRow
          date="Вчера"
          duration="38:12"
          openCount={3}
          time="12:30"
          title="Ветклиника Лапа"
        />
        <CallRow
          date="12 окт"
          duration="41:05"
          openCount={1}
          selected
          time="12:40"
          title="Школа Ритм"
        />
      </>
    );

    const selected = screen.getByRole("button", { name: SELECTED_CALL });
    const other = screen.getByRole("button", { name: OTHER_CALL });

    expect(selected.getAttribute("aria-current")).toBe("true");
    expect(selected.getAttribute("data-selected")).toBe("true");
    expect(selected.getAttribute("data-variant")).toBe("default");
    expect(other.hasAttribute("aria-current")).toBe(false);
    expect(other.hasAttribute("data-selected")).toBe(false);
  });

  it("shows the live timer instead of the open count", () => {
    render(
      <CallRow
        date="Сегодня"
        duration="24:18"
        live
        openCount={2}
        time="12:00"
        title="Телемедиа"
      />
    );

    expect(
      screen.getByRole("timer", { name: "Идёт запись, 24:18" })
    ).toBeDefined();
    expect(screen.getByText("идёт сейчас")).toBeDefined();
    expect(screen.queryByText("2 открытых")).toBeNull();
  });

  it("says when every question is closed", () => {
    render(
      <CallRow
        date="15 окт"
        duration="22:40"
        openCount={0}
        time="12:10"
        title="Логистик Про"
      />
    );

    expect(screen.getByText("всё закрыто")).toBeDefined();
  });
});

describe("formatOpenQuestions", () => {
  it("agrees the word with the number", () => {
    expect(formatOpenQuestions(1)).toBe("1 открытый");
    expect(formatOpenQuestions(3)).toBe("3 открытых");
    expect(formatOpenQuestions(11)).toBe("11 открытых");
    expect(formatOpenQuestions(21)).toBe("21 открытый");
  });
});

describe("ProjectRow", () => {
  it("is a single control that names the participants", () => {
    render(
      <ProjectRow
        name="Телемедиа"
        openCount={5}
        participants={[
          { initials: "ОД", name: "Ольга Демченко" },
          { initials: "ИС", name: "Игорь Савчук" },
        ]}
      />
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain(
      "участники: Ольга Демченко, Игорь Савчук"
    );
    expect(buttons[0]?.textContent).toContain("5 открытых");
  });
});

describe("IntegrationRow", () => {
  it("keeps the status text next to the action", () => {
    render(
      <IntegrationRow
        action={<button type="button">Подключить</button>}
        description="Задачи и комментарии, только чтение"
        icon={null}
        name="ClickUp"
        status="disconnected"
      />
    );

    expect(screen.getByText("не подключено")).toBeDefined();
    expect(screen.getByRole("button", { name: "Подключить" })).toBeDefined();
  });
});

describe("SetupStep", () => {
  it("exposes the download progress named by the step title", () => {
    render(
      <SetupStep
        description="Скачиваю Whisper large-v3-turbo, 1 из 1,6 ГБ"
        progress={62}
        status="fixing"
        title="Модель распознавания речи"
      />
    );

    const bar = screen.getByRole("progressbar", {
      name: "Модель распознавания речи",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText("62%")).toBeDefined();
  });

  it("shows the action only while something is missing", () => {
    const { rerender } = render(
      <SetupStep
        action={<button type="button">Войти</button>}
        status="missing"
        title="Вход в аккаунт Claude"
      />
    );
    expect(screen.getByRole("button", { name: "Войти" })).toBeDefined();

    rerender(
      <SetupStep
        action={<button type="button">Войти</button>}
        status="done"
        title="Вход в аккаунт Claude"
      />
    );
    expect(screen.queryByRole("button", { name: "Войти" })).toBeNull();
    expect(screen.getByText("готово")).toBeDefined();
  });
});
