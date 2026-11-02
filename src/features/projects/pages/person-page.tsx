"use client";

import { useSearchParams } from "next/navigation";
import {
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { toast } from "@/components/ui/toast";
import { updatePerson, usePerson } from "@/data/people";
import { useProject } from "@/data/projects";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { MissingEntity } from "../components/missing-entity";
import { personScales, toPersonProfile } from "../project-data";
import { PERSON_FORM_SLOT, PersonScreen } from "../screens/person-screen";

/** `?demo=edit`: the profile opened for editing. */
export const PERSON_DEMO_STATES = ["edit"] as const;

const PORTRAIT_PREFIX = "portrait:";

interface Levels {
  project: number;
  tech: number;
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
      updatePerson(person.projectId, person.id, {
        askStyle,
        // The card repeats the profile text once the manager rewrote it.
        howToAsk: askStyle === profile.askStyle ? person.howToAsk : askStyle,
        portrait,
        project: editLevels.project,
        role: String(data.get("role") ?? person.role).trim(),
        // The edit fields carry the suggested change: saving accepts it.
        suggestion:
          person.suggestion === "pending" ? "accepted" : person.suggestion,
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
      setEditLevels((current) =>
        current ? { ...current, [scale]: value } : current
      );
    },
    []
  );

  const handleAccept = useCallback(() => {
    if (person) {
      updatePerson(person.projectId, person.id, { suggestion: "accepted" });
      toast.add({ title: "Правка принята, профиль обновлён", type: "success" });
    }
  }, [person]);

  const handleDecline = useCallback(() => {
    if (!person) {
      return;
    }
    const { id, projectId: owner } = person;
    updatePerson(owner, id, { suggestion: "declined" });
    toast.add({
      actionProps: {
        children: "Вернуть",
        onClick: () => updatePerson(owner, id, { suggestion: "pending" }),
      },
      title: "Отклонено",
      type: "success",
    });
  }, [person]);

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
      className="h-svh"
      mode={editing ? "edit" : "view"}
      onAcceptSuggestion={handleAccept}
      onCancelEdit={cancelEdit}
      onDeclineSuggestion={handleDecline}
      onEdit={startEdit}
      onEditSuggestion={startEdit}
      onSave={handleSave}
      onScaleStep={handleScaleStep}
      person={shown}
      project={project}
    />
  );
}
