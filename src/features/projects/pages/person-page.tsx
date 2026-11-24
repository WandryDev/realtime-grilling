"use client";

import { toast } from "@grill/ui/toast";
import { useSearchParams } from "next/navigation";
import {
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Proposal } from "@/bindings";
import { type CallRecord, useCalls } from "@/data/calls";
import { updatePerson, usePerson } from "@/data/people";
import { useProject } from "@/data/projects";
import { usePersonProposals } from "@/data/proposals";
import { momentParam } from "@/features/post-call/moment";
import { plural } from "@/lib/plural";
import {
  proposalSection,
  proposalText,
  proposalValue,
} from "@/lib/proposal-fields";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { MissingEntity } from "../components/missing-entity";
import { personScales, toPersonProfile } from "../project-data";
import {
  type CallSuggestion,
  PERSON_FORM_SLOT,
  PersonScreen,
} from "../screens/person-screen";

/** `?demo=edit`: the profile opened for editing. */
export const PERSON_DEMO_STATES = ["edit"] as const;

const PORTRAIT_PREFIX = "portrait:";

/** 1–5; `null`: not set. */
interface Levels {
  project: number | null;
  tech: number | null;
}

/**
 * The person's pending proposals from the calls (newest call first), a
 * block per call with what would change, the first quote and the call's
 * review.
 */
function callSuggestions(
  proposals: readonly Proposal[],
  calls: readonly CallRecord[]
): CallSuggestion[] {
  const byCall = new Map<string, Proposal[]>();
  for (const proposal of proposals) {
    const list = byCall.get(proposal.callId);
    if (list) {
      list.push(proposal);
    } else {
      byCall.set(proposal.callId, [proposal]);
    }
  }
  return [...byCall].map(([callId, list]) => {
    const day = calls.find((call) => call.id === callId)?.day;
    const after = day ? ` после звонка ${day}` : " после звонка";
    const [quote] = list.flatMap((item) => item.evidence);
    return {
      id: callId,
      quoteHref: quote
        ? routes.callTranscript(callId, momentParam(quote))
        : undefined,
      reviewHref: routes.callProposals(callId),
      suggestion: {
        changes: list.map((item) => ({
          field: proposalSection(item),
          text: `+ ${proposalValue(item.field, proposalText(item))}`,
        })),
        quote: quote ? `«${quote.quote}»` : undefined,
        title:
          list.length === 1
            ? `Предложение${after}`
            : `${list.length} ${plural(list.length, "предложение", "предложения", "предложений")}${after}`,
      },
    };
  });
}

/** `/project/person?project=&id=`: the profile of a person of the client. */
export function PersonPage() {
  const params = useSearchParams();
  const projectId = params.get("project");
  const personId = params.get("id");
  return (
    <PersonView
      key={`${projectId}/${personId}`}
      personId={personId}
      projectId={projectId}
    />
  );
}

function PersonView({
  personId,
  projectId,
}: {
  personId: string | null;
  projectId: string | null;
}) {
  const project = useProject(projectId);
  const person = usePerson(projectId, personId);
  const proposals = usePersonProposals(person?.id).data;
  const calls = useCalls();
  const suggestions = useMemo(
    () => callSuggestions(proposals, calls),
    [calls, proposals]
  );
  const demo = useDemoState(PERSON_DEMO_STATES);
  const [editLevels, setEditLevels] = useState<Levels | null>(null);

  const profile = useMemo(
    () => (person ? toPersonProfile(person) : null),
    [person]
  );

  const startEdit = useCallback(() => {
    if (person) {
      setEditLevels({ project: person.project, tech: person.tech });
    }
  }, [person]);

  useEffect(() => {
    if (demo === "edit") {
      startEdit();
    }
  }, [demo, startEdit]);

  const cancelEdit = useCallback(() => setEditLevels(null), []);

  const handleSave = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!(person && profile && editLevels)) {
        return;
      }
      const data = new FormData(event.currentTarget);
      const portrait: Record<string, string> = {};
      for (const [key, value] of data.entries()) {
        if (key.startsWith(PORTRAIT_PREFIX)) {
          portrait[key.slice(PORTRAIT_PREFIX.length)] = String(value).trim();
        }
      }
      const askStyle = String(data.get("askStyle") ?? profile.askStyle).trim();
      const notes = String(data.get("notes") ?? person.notes ?? "").trim();
      updatePerson(person.projectId, person.id, {
        askStyle,
        // The card repeats the profile text once the manager rewrote it.
        howToAsk: askStyle === profile.askStyle ? person.howToAsk : askStyle,
        notes: notes || undefined,
        portrait,
        project: editLevels.project,
        role: String(data.get("role") ?? person.role).trim(),
        tech: editLevels.tech,
      }).then((saved) => {
        if (saved) {
          toast.add({ title: "Профиль сохранён", type: "success" });
        }
      });
      setEditLevels(null);
    },
    [editLevels, person, profile]
  );

  const handleScaleStep = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { level, scale } = event.currentTarget.dataset;
      const value = Number(level);
      if (!(value && (scale === "tech" || scale === "project"))) {
        return;
      }
      // The step that is set again clears the level: "не указано".
      setEditLevels((current) =>
        current
          ? { ...current, [scale]: current[scale] === value ? null : value }
          : current
      );
    },
    []
  );

  // ⌘S saves, Esc cancels while editing.
  const editing = editLevels !== null;
  useEffect(() => {
    if (!editing) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        document
          .querySelector<HTMLFormElement>(`[data-slot="${PERSON_FORM_SLOT}"]`)
          ?.requestSubmit();
      } else if (event.key === "Escape") {
        setEditLevels(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  if (!(project && person && profile)) {
    return (
      <MissingEntity
        backHref={project ? routes.project(project.id) : routes.home()}
        backLabel={project ? `К проекту ${project.name}` : "На главную"}
        className="h-svh"
        description={
          project
            ? "Такого человека нет в проекте. Возможно, его убрали."
            : "Проект этого человека не найден."
        }
        title="Профиль не найден"
      />
    );
  }

  const shown = editLevels
    ? { ...profile, scales: personScales(editLevels) }
    : profile;

  return (
    <PersonScreen
      callSuggestions={suggestions}
      className="h-svh"
      mode={editing ? "edit" : "view"}
      onCancelEdit={cancelEdit}
      onEdit={startEdit}
      onSave={handleSave}
      onScaleStep={handleScaleStep}
      person={shown}
      project={project}
    />
  );
}
