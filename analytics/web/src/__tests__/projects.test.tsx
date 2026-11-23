// «Проекты» and «Сводка проекта» (spec analytics-web, task 7.2).

import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectView } from "@/views/project";
import { ProjectsView } from "@/views/projects";
import { kindCost, projectItem, projectSummary } from "./helpers/data";
import { change, serve } from "./helpers/fake-server";

const search = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => search.value }));

beforeEach(() => {
  search.value = new URLSearchParams();
});

describe("«Проекты»", () => {
  it("«Идущий звонок»: the mark comes and goes by the live stream", async () => {
    serve({
      "/api/projects": [
        projectItem({
          id: "none",
          lastCallAt: Date.now(),
          name: "Без проекта",
        }),
        projectItem({ live: true }),
      ],
    });
    render(<ProjectsView />);
    const row = (await screen.findByText("Обменник")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("идёт звонок")).toBeDefined();
    // «Без проекта» last, though its call is the latest.
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((tr) => tr.textContent ?? "");
    expect(names.at(-1)).toContain("Без проекта");
    await waitFor(() =>
      expect(screen.getByTestId("connection").textContent).toContain("Вживую")
    );

    serve({ "/api/projects": [projectItem({ live: false })] });
    change();
    await waitFor(() => expect(screen.queryByText("идёт звонок")).toBeNull());
    expect(screen.getByText("Обменник")).toBeDefined();
  });

  it("says there are no calls yet", async () => {
    serve({ "/api/projects": [] });
    render(<ProjectsView />);
    expect(await screen.findByText("Звонков пока нет")).toBeDefined();
  });
});

describe("«Сводка проекта»", () => {
  it("«Стоимость по видам»: the live part, the review after, the brief apart", async () => {
    search.value = new URLSearchParams("id=1");
    serve({
      "/api/projects/1": projectSummary({
        brief: kindCost("brief", 0.4, 2),
        costByKind: [
          kindCost("fastLoop", 1.2, 40),
          kindCost("slowLoop", 0.3, 3),
          kindCost("summary", 0.25),
          kindCost("proposals", 0.15),
        ],
      }),
    });
    render(<ProjectView />);
    const live = (await screen.findByText("Во время звонков")).parentElement;
    expect(live?.textContent).toContain("$1.50");
    const after = screen.getByText("Разбор после звонков").parentElement;
    expect(after?.textContent).toContain("$0.400");
    const kinds = screen.getByTestId("kinds");
    const rows = within(kinds)
      .getAllByRole("row")
      .map((tr) => tr.textContent ?? "");
    const projectAt = rows.findIndex((text) => text.startsWith("Проект"));
    expect(projectAt).toBeGreaterThan(0);
    // The brief is the project's own row, after the calls' kinds.
    expect(rows[projectAt + 1]).toContain("Бриф проекта");
    expect(rows[projectAt + 1]).toContain("$0.400");
    expect(rows.slice(0, projectAt).join()).toContain("Итоги звонка");
    expect(rows.slice(0, projectAt).join()).not.toContain("Бриф");
  });

  it("«Самый используемый документ»: the source with its findings and link", async () => {
    search.value = new URLSearchParams("id=1");
    serve({
      "/api/projects/1": projectSummary({
        sources: [
          {
            candidates: 5,
            findings: 3,
            grounds: 1,
            sourceKind: "outline",
            sourceName: "Регламент смен",
            sourceUrl: "https://outline.example/doc/shifts",
          },
        ],
      }),
    });
    render(<ProjectView />);
    const link = await screen.findByRole("link", { name: "Регламент смен" });
    expect(link.getAttribute("href")).toBe(
      "https://outline.example/doc/shifts"
    );
    const cells = within(link.closest("tr") as HTMLElement)
      .getAllByRole("cell")
      .map((td) => td.textContent);
    expect(cells.slice(1)).toEqual(["5", "3", "1"]);
  });

  it("an unknown project is «не найден»", async () => {
    search.value = new URLSearchParams("id=404");
    serve({});
    render(<ProjectView />);
    expect(await screen.findByText("Проект не найден")).toBeDefined();
  });
});
