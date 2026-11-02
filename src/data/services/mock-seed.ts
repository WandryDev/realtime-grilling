import type { Call, Person, Project, Value } from "@/bindings";
import { PROJECTS } from "@/features/mock/projects";
import {
  type HistoryCall,
  PROJECT_HISTORY,
  PROPOSAL_GROUPS,
} from "@/features/post-call/mock";

/*
 * The demo records the mock repository starts with, in the shapes of
 * `src/bindings.ts`. Seed ids stay readable ("telemedia", "olga"): the
 * demo links and the tests open them. Records created afterwards get
 * UUID v7 ids, like the Rust side.
 */

/** Id of the call the demo records; the post-call screens have its data. */
export const DEMO_CALL_ID = "telemedia-19-oct";

/** Seeds are older than anything created in the app, in list order. */
const SEED_CREATED_AT = Date.UTC(2026, 8, 1);

const SEED_PEOPLE: {
  id: string;
  name: string;
  profile: { [key: string]: Value };
  projectId: string;
  role: string;
}[] = [
  {
    id: "olga",
    name: "Ольга Демченко",
    profile: {
      howToAsk:
        "Спрашивать через последствия для бизнеса: деньги, пациенты, сроки. Без терминов.",
      initials: "ОД",
      project: 3,
      suggestion: "pending",
      tech: 1,
    },
    projectId: "telemedia",
    role: "CEO, решает по срокам и бюджету",
  },
  {
    id: "igor",
    name: "Игорь Савчук",
    profile: {
      howToAsk:
        "Можно сразу про API, поля и форматы. Любит конкретику, не любит «потом решим».",
      initials: "ИС",
      project: 4,
      tech: 5,
    },
    projectId: "telemedia",
    role: "Техлид, amoCRM и телефония",
  },
];

/* The call found by search in "Ветклиника Лапа" gets a history row too. */
const LAPA_CALLS: HistoryCall[] = [
  {
    date: "8 окт",
    duration: "27:15",
    id: "oct-8",
    openCount: 0,
    participants: "Марина Котова",
    time: "12:10",
    title: "Онлайн-запись и напоминания",
  },
];

/** History ids of the mock that stand for the call the demo records. */
const CALL_ALIASES: Record<string, string> = {
  "oct-19": DEMO_CALL_ID,
  today: DEMO_CALL_ID,
};

const SHORT_MONTHS = ["сен", "окт"];
/** The demo history happens in this year. */
const DEMO_YEAR = 2026;
const FIRST_DEMO_MONTH = 8;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const AUDIO_DELETED = ", аудио удалено";

/** "19 окт" + "12:01" → local time of that moment. */
function startOf(call: HistoryCall) {
  const [day = "1", month = "окт"] = call.date.split(" ");
  const [hours = "0", minutes = "0"] = call.time.split(":");
  return new Date(
    DEMO_YEAR,
    FIRST_DEMO_MONTH + SHORT_MONTHS.indexOf(month),
    Number(day),
    Number(hours),
    Number(minutes)
  ).getTime();
}

/** "40:12" → milliseconds. */
function durationOf(call: HistoryCall) {
  const [minutes = "0", seconds = "0"] = call.duration.split(":");
  return (
    (Number(minutes) * SECONDS_PER_MINUTE + Number(seconds)) * MS_PER_SECOND
  );
}

/**
 * The current call starts with the proposals of the Paper review; older
 * calls were reviewed already, so their pending proposals are accepted.
 */
function initialProposals(reviewed: boolean) {
  const proposals: { [id: string]: Value } = {};
  for (const group of PROPOSAL_GROUPS) {
    for (const proposal of group.proposals) {
      let decision = "pending";
      if (proposal.state === "accepted" || proposal.state === "rejected") {
        decision = proposal.state;
      } else if (reviewed) {
        decision = "accepted";
      }
      proposals[proposal.id] = { decision };
    }
  }
  return proposals;
}

function seedCall(call: HistoryCall, projectId: string, people: Person[]) {
  const id = CALL_ALIASES[call.id] ?? call.id;
  const label = call.participants.replace(AUDIO_DELETED, "");
  const names = label.split(", ");
  const known = names.map(
    (name) =>
      people.find(
        (person) => person.projectId === projectId && person.name === name
      )?.id
  );
  const participantIds = known.every((personId) => personId !== undefined)
    ? (known as string[])
    : [];
  const summary: { [key: string]: Value } = {
    audioDeleted: call.participants.includes(AUDIO_DELETED),
    proposals: initialProposals(id !== DEMO_CALL_ID),
    summary: "ready",
    tasks: {},
  };
  // People the project doesn't have yet keep the names of the history.
  if (participantIds.length === 0) {
    summary.participants = label;
  }
  const startedAt = startOf(call);
  return {
    endedAt: startedAt + durationOf(call),
    id,
    openQuestions: call.openCount,
    participantIds,
    projectId,
    startedAt,
    summary,
    title: call.title,
  };
}

export interface MockSeed {
  calls: Call[];
  people: Person[];
  projects: Project[];
}

/** A fresh copy of the demo records. */
export function mockSeed(): MockSeed {
  let created = SEED_CREATED_AT;
  const stamp = () => {
    created += 1;
    return { createdAt: created, updatedAt: created };
  };

  const projects: Project[] = PROJECTS.map((project) => ({
    brief: null,
    description: project.description,
    id: project.id,
    name: project.name,
    openQuestions: project.openQuestions,
    ...stamp(),
  }));

  const people: Person[] = SEED_PEOPLE.map((person) => ({
    ...person,
    profile: { ...person.profile },
    ...stamp(),
  }));

  const history: [HistoryCall, string][] = [];
  for (const [projectId, months] of Object.entries(PROJECT_HISTORY)) {
    for (const month of months) {
      for (const call of month.calls) {
        history.push([call, projectId]);
      }
    }
  }
  for (const call of LAPA_CALLS) {
    history.push([call, "lapa"]);
  }
  const calls: Call[] = history.map(([call, projectId]) => ({
    ...seedCall(call, projectId, people),
    status: "finished",
    ...stamp(),
  }));

  return { calls, people, projects };
}

/** Resolves the history ids other screens use to the seeded call. */
export function seedCallId(id: string) {
  return CALL_ALIASES[id] ?? id;
}
