import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The stores in Tauri mode, over a fake IPC (./helpers/fake-tauri.ts):
 * they read on the first subscriber, follow `DataChanged` from every
 * window and leave the data as the storage has it when a write fails.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

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

const push = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push,
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

const { fakeCall, fakePerson, fakeProject } = await import(
  "./helpers/fake-tauri"
);

fake.db.projects.push(
  fakeProject("019a0000-0000-7000-8000-000000000001", "Телемедиа"),
  fakeProject("019a0000-0000-7000-8000-000000000002", "Ветклиника Лапа")
);

const [TELEMEDIA, LAPA] = fake.db.projects.map((project) => project.id) as [
  string,
  string,
];

const { inTauri } = await import("@/effect/runtime");
const { getProjects, updateProject, useProjects } = await import(
  "@/data/projects"
);
const { usePeople } = await import("@/data/people");
const { AppFrame } = await import("@/features/shell/app-frame");
const { toast } = await import("@/components/ui/toast");
const { setProposalDecision, useCalls } = await import("@/data/calls");

const CALL_ID = "019a0000-0000-7000-8000-0000000000c1";

function CallsProbe() {
  const calls = useCalls();
  return (
    <ul>
      {calls.map((call) => (
        <li key={call.id}>
          {call.title}: {Object.keys(call.proposals).sort().join(", ")}
        </li>
      ))}
    </ul>
  );
}

function ProjectsProbe() {
  const projects = useProjects();
  const people = usePeople(LAPA);
  return (
    <ul>
      {projects.map((project) => (
        <li key={project.id}>{project.name}</li>
      ))}
      {people.map((person) => (
        <li key={person.id}>{person.name}</li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  push.mockReset();
  fake.failures.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stores in Tauri", () => {
  it("runs on the Tauri layers", () => {
    expect(inTauri).toBe(true);
  });

  it("reads on the first subscriber and follows writes of another window", async () => {
    render(
      <AppFrame>
        <ProjectsProbe />
      </AppFrame>
    );
    expect(await screen.findByText("Телемедиа")).toBeTruthy();

    // The start widget renames the project and adds a person to Лапа.
    act(() => {
      const [project] = fake.db.projects;
      if (project) {
        project.name = "Телемедиа Плюс";
      }
      fake.db.people.push(
        fakePerson(
          "019a0000-0000-7000-8000-0000000000aa",
          LAPA,
          "Марина Котова"
        )
      );
      fake.dataChanged({
        change: "updated",
        entity: "project",
        id: TELEMEDIA,
        projectId: TELEMEDIA,
      });
      fake.dataChanged({
        change: "created",
        entity: "person",
        id: "019a0000-0000-7000-8000-0000000000aa",
        projectId: LAPA,
      });
    });

    expect(await screen.findByText("Телемедиа Плюс")).toBeTruthy();
    expect(await screen.findByText("Марина Котова")).toBeTruthy();
    expect(screen.queryByText("Телемедиа")).toBeNull();
    // The person's change re-read only the people of that project.
    const peopleReads = fake.invoked.filter(
      (call) => call.command === "people_list"
    );
    expect(peopleReads.at(-1)?.args).toEqual({ projectId: LAPA });
  });

  it("keeps the stored data and shows a toast when a write fails", async () => {
    const add = vi.spyOn(toast, "add");
    render(<ProjectsProbe />);
    await screen.findByText("Ветклиника Лапа");
    fake.failures.set("projects_update", {
      kind: "Invalid",
      message: "Название не может быть пустым",
    });

    const result = await act(() => updateProject(LAPA, { name: " " }));

    expect(result).toBeUndefined();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Название не может быть пустым",
        type: "error",
      })
    );
    expect(getProjects().find((project) => project.id === LAPA)?.name).toBe(
      "Ветклиника Лапа"
    );
    expect(screen.getByText("Ветклиника Лапа")).toBeTruthy();
  });

  it("opens the route the tray asks the main window for", async () => {
    render(
      <AppFrame>
        <ProjectsProbe />
      </AppFrame>
    );
    await screen.findByText("Ветклиника Лапа");
    await waitFor(() => expect(fake.handlers.get("navigate")?.size).toBe(1));

    act(() => fake.emit("navigate", { route: "/settings/general" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/general"));
  });

  it("keeps both of two summary decisions made within one round trip", async () => {
    render(<CallsProbe />);
    act(() => {
      fake.db.calls.push(fakeCall(CALL_ID, TELEMEDIA, "Созвон"));
      fake.dataChanged({
        change: "created",
        entity: "call",
        id: CALL_ID,
        projectId: TELEMEDIA,
      });
    });
    await screen.findByText("Созвон:", { exact: false });

    // Two proposals accepted before the first write came back.
    await act(() =>
      Promise.all([
        setProposalDecision(CALL_ID, "p1", { decision: "accepted" }),
        setProposalDecision(CALL_ID, "p2", { decision: "rejected" }),
      ])
    );

    const patches = fake.invoked
      .filter((call) => call.command === "calls_patch_summary")
      .map((call) => call.args?.patch);
    expect(patches).toEqual([
      { proposals: { p1: { decision: "accepted" } } },
      { proposals: { p2: { decision: "rejected" } } },
    ]);
    expect(fake.db.calls[0]?.summary).toEqual({
      proposals: {
        p1: { decision: "accepted" },
        p2: { decision: "rejected" },
      },
    });
    expect(await screen.findByText("Созвон: p1, p2")).toBeTruthy();
  });
});
