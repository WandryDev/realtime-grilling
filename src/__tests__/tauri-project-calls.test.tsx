import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallOverview } from "@/bindings";

/*
 * «Звонки» of the project page and «Недавние звонки» of home in Tauri, over
 * the fake IPC (./helpers/fake-tauri.ts): the stored calls, newest first,
 * with the title and counts of `calls_overview`; a row with proposals
 * waiting opens their review, any other its summary.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: fake.listen }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => undefined),
  }),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => nav.search,
}));

const { fakeCall, fakePerson, fakeProject } = await import(
  "./helpers/fake-tauri"
);
const { ProjectPage } = await import("@/features/projects/pages/project-page");
const { HomePage } = await import("@/features/projects/pages/home-page");
const { routes } = await import("@/lib/routes");

const PROJECT = "019a0000-0000-7000-8000-000000000001";
const EMPTY_PROJECT = "019a0000-0000-7000-8000-000000000002";
const ANNA = "019a0000-0000-7000-8000-0000000000e1";
const CALLS = [1, 2, 3, 4].map(
  (index) => `019a0000-0000-7000-8000-0000000000c${index}`
);
const LOOSE = "019a0000-0000-7000-8000-0000000000c9";

const today = new Date();
/** 12:37 `days` calendar days ago (DST-safe). */
const daysAgo = (days: number) =>
  new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - days,
    12,
    37
  ).getTime();
const NEWEST = /Телеграм-бот/u;
const LIMITS = /Лимиты на брони/u;
const RATES = /Курсы валют/u;
const FIRST = /Знакомство/u;
const HOME_ROW = /Обменник|Звонок без проекта/u;

fake.db.projects.push(
  fakeProject(PROJECT, "Обменник"),
  fakeProject(EMPTY_PROJECT, "Школа Ритм")
);
fake.db.people.push(fakePerson(ANNA, PROJECT, "Анна"));
fake.db.calls.push(
  // Oldest first: the page sorts them by their start.
  ...CALLS.map((id, index) => ({
    ...fakeCall(id, PROJECT, ""),
    endedAt: daysAgo(3 - index) + 600_000,
    participantIds: [ANNA],
    startedAt: daysAgo(3 - index),
  })),
  {
    ...fakeCall(LOOSE, null, ""),
    endedAt: daysAgo(10) + 300_000,
    startedAt: daysAgo(10),
  }
);

const OVERVIEW: CallOverview[] = [
  {
    audioDeleted: false,
    callId: CALLS[3] ?? "",
    openQuestions: 2,
    pendingProposals: 3,
    projectId: PROJECT,
    title: "Телеграм-бот для брони",
  },
  {
    audioDeleted: true,
    callId: CALLS[2] ?? "",
    openQuestions: 1,
    pendingProposals: 0,
    projectId: PROJECT,
    title: "Лимиты на брони",
  },
  {
    audioDeleted: false,
    callId: CALLS[1] ?? "",
    openQuestions: 0,
    pendingProposals: 0,
    projectId: PROJECT,
    title: "Курсы валют",
  },
  {
    audioDeleted: false,
    callId: CALLS[0] ?? "",
    openQuestions: 0,
    pendingProposals: 0,
    projectId: PROJECT,
    title: "Знакомство",
  },
  {
    audioDeleted: false,
    callId: LOOSE,
    openQuestions: 0,
    pendingProposals: 0,
    projectId: null,
    title: "",
  },
];

beforeEach(() => {
  fake.answers.clear();
  fake.answers.set("calls_overview", () => OVERVIEW);
});

const rowOf = (name: RegExp) => screen.findByRole("link", { name });

describe("project page: «Звонки»", () => {
  it("lists the newest stored calls with their overview", async () => {
    nav.search = new URLSearchParams(`id=${PROJECT}`);
    render(<ProjectPage />);

    const newest = await rowOf(NEWEST);
    expect(newest.textContent).toContain("сегодня 12:37");
    expect(newest.textContent).toContain("Анна");
    expect(newest.textContent).toContain("3 предложения ждут");
    // Proposals waiting: the row opens their review.
    expect(newest.getAttribute("href")).toBe(
      routes.callProposals(CALLS[3] ?? "")
    );

    const limits = await rowOf(LIMITS);
    expect(limits.textContent).toContain("вчера 12:37");
    expect(limits.textContent).toContain("Анна, аудио удалено");
    expect(limits.textContent).toContain("1 вопрос открыт");
    expect(limits.getAttribute("href")).toBe(
      routes.callSummary(CALLS[2] ?? "")
    );
    expect((await rowOf(RATES)).textContent).toContain("разобран");

    // Three rows, the fourth under «Показать ещё».
    expect(screen.queryByRole("link", { name: FIRST })).toBeNull();
    expect(screen.getByText("4 звонка, 3 открытых вопроса")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Показать ещё 1" }).getAttribute("href")
    ).toBe(routes.history(PROJECT));
  });

  it("says a project without calls has none", async () => {
    nav.search = new URLSearchParams(`id=${EMPTY_PROJECT}`);
    render(<ProjectPage />);

    expect(
      await screen.findByText("Звонков по проекту ещё не было")
    ).toBeTruthy();
    expect(screen.getByText("пока пусто")).toBeTruthy();
  });
});

describe("home: «Недавние звонки»", () => {
  it("lists every project's calls newest first, with the project", async () => {
    render(<HomePage />);

    const newest = await rowOf(NEWEST);
    expect(newest.textContent).toContain("Обменник");
    const section = newest.closest("section");
    expect(section).toBeTruthy();
    const rows = within(section as HTMLElement).getAllByRole("link", {
      name: HOME_ROW,
    });
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe(newest);
    // A call without a project is named after that.
    expect(rows[4]?.textContent).toContain("Звонок без проекта");
  });
});
