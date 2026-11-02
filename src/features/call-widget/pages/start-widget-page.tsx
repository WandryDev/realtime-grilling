"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { usePeople } from "@/data/people";
import { useProjects } from "@/data/projects";
import { useSettings } from "@/data/settings";
import { inTauri } from "@/effect/runtime";
import { hideWindow, useOpenRoute } from "@/features/shell/api";
import { linkButtonProps } from "@/lib/link-button";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import {
  buildBrief,
  getLastCallParticipantIds,
  startRecording,
  toParticipant,
  toPickerProject,
} from "../api";
import type { BriefProgress } from "../backend";
import { DesktopStage } from "../components/desktop-stage";
import { FloatingLink } from "../components/floating-link";
import { FloatingSurface } from "../components/floating-surface";
import { LAST_CALL_PROJECT_ID, LAUNCH, type Participant } from "../mock";
import { joinNames } from "../names";
import { StartWidget, type StartWidgetLaunch } from "../screens/start-widget";
import { useCallTime } from "../use-call-clock";

/*
 * /widget: the start widget. The meeting app took the microphone, the
 * widget asks to start the call with the project and people of the last
 * one. "Начать" starts recording and refreshes the brief; when it is ready
 * the widget hands over to the compact overlay (or the call window when the
 * overlay is off in Settings).
 *
 * In Tauri the widget is its own window and never shows the call itself:
 * "Начать" starts the call (shared with every window), hides the widget and
 * shows the overlay, which takes the call over, or the main window on the
 * call window. The pill's × hides the window.
 *
 * The project and the people come from the live lists: the choice is kept
 * only while its project exists, otherwise the widget falls back to the
 * default. Nothing from the prerendered demo data sticks.
 */

type Phase = "prompt" | "launching" | "collapsed" | "hidden";

/** States the navigator can open directly; the rest come by clicking. */
const DEMO_STATES = ["launching", "collapsed", "hidden"] as const;

/** What the user picked; `undefined` keys follow the defaults. */
interface Choice {
  projectId?: string | null;
  /** People picked for `projectId`. */
  selectedIds?: string[];
}

/**
 * The project the widget shows: the picked one while it exists, else the
 * last call's (the demo's, in the browser) or the first one.
 */
function resolveProjectId(
  projects: { id: string }[],
  picked: string | null | undefined
): string | null {
  if (
    picked === null ||
    (picked !== undefined && projects.some((item) => item.id === picked))
  ) {
    return picked;
  }
  const last = inTauri
    ? undefined
    : projects.find((project) => project.id === LAST_CALL_PROJECT_ID);
  return last?.id ?? projects[0]?.id ?? null;
}

/** Pause on the finished brief before the widget hands over. */
const HANDOVER_MS = 1200;

const LAUNCH_SPEECH = "Можно говорить, расшифровка уже идёт.";

/** "Телемедиа, с Ольгой и Игорем. Можно говорить, …" */
function launchDescription(
  project: string,
  people: { instrumental?: string; name: string }[]
) {
  const names = people.map((person) => person.instrumental ?? person.name);
  const who = names.length > 0 ? `, с ${joinNames(names)}` : "";
  return `${project}${who}. ${LAUNCH_SPEECH}`;
}

/*
 * The widget's × after "Не сейчас": in Tauri the window just closes. In the
 * browser a small note stays, so the flow can be replayed.
 */
function HiddenNotice({ onShow }: { onShow: () => void }) {
  const openGrill = linkButtonProps(routes.home(), FloatingLink);
  return (
    <FloatingSurface className="w-widget gap-3 p-5">
      <p className="text-base font-medium">Виджет скрыт до следующего звонка</p>
      <p className="text-muted-foreground text-sm">
        Начать запись можно из окна Grill или сочетанием клавиш.
      </p>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={onShow} variant="secondary">
          Показать снова
        </Button>
        <Button {...openGrill}>Открыть Grill</Button>
      </div>
    </FloatingSurface>
  );
}

function StartWidgetFlow({ initialPhase }: { initialPhase: Phase }) {
  const openRoute = useOpenRoute();
  const projects = useProjects();
  const { compactOverlay } = useSettings();

  const pickerProjects = useMemo(
    () => projects.map(toPickerProject),
    [projects]
  );
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [choice, setChoice] = useState<Choice>({});
  const projectId = resolveProjectId(projects, choice.projectId);
  const pickedPeople =
    choice.projectId === projectId ? choice.selectedIds : undefined;
  const selectedIds = useMemo(
    () => pickedPeople ?? getLastCallParticipantIds(projectId),
    [pickedPeople, projectId]
  );
  const [brief, setBrief] = useState<BriefProgress | null>(null);

  const people = usePeople(projectId);
  const clientPeople = useMemo(() => people.map(toParticipant), [people]);
  // Who is on the call, fixed by "Начать" (the ?demo=launching start uses
  // the preselected people).
  const [callPeople, setCallPeople] = useState<Participant[]>(() =>
    initialPhase === "launching"
      ? clientPeople.filter((person) => selectedIds.includes(person.id))
      : []
  );
  const participants = useMemo(
    () => clientPeople.filter((person) => selectedIds.includes(person.id)),
    [clientPeople, selectedIds]
  );
  const addablePeople = useMemo(
    () => clientPeople.filter((person) => !selectedIds.includes(person.id)),
    [clientPeople, selectedIds]
  );
  const projectName =
    projects.find((project) => project.id === projectId)?.name ??
    "Звонок без проекта";

  const afterStartHref = compactOverlay ? routes.overlay() : routes.call();
  const time = useCallTime(LAUNCH.time);

  // Refresh the brief while the launch card is up.
  useEffect(() => {
    if (phase !== "launching") {
      return;
    }
    return buildBrief(callPeople, setBrief);
  }, [callPeople, phase]);

  // Brief ready: the widget hands over to the overlay or the call window.
  useEffect(() => {
    if (phase !== "launching" || !brief?.done) {
      return;
    }
    const timer = setTimeout(() => openRoute(afterStartHref), HANDOVER_MS);
    return () => clearTimeout(timer);
  }, [afterStartHref, brief?.done, openRoute, phase]);

  const changeProject = useCallback((next: string | null) => {
    setChoice({ projectId: next });
  }, []);
  const addParticipant = useCallback(
    (id: string) => {
      setChoice({ projectId, selectedIds: [...selectedIds, id] });
    },
    [projectId, selectedIds]
  );
  const removeParticipant = useCallback(
    (id: string) => {
      setChoice({
        projectId,
        selectedIds: selectedIds.filter((item) => item !== id),
      });
    },
    [projectId, selectedIds]
  );

  const start = useCallback(() => {
    startRecording({ participants, projectId });
    if (inTauri) {
      // The overlay (or the call window) takes the call over.
      openRoute(afterStartHref);
      setChoice({});
      setPhase("prompt");
      return;
    }
    setCallPeople(participants);
    setBrief(null);
    setPhase("launching");
  }, [afterStartHref, openRoute, participants, projectId]);
  const collapse = useCallback(() => setPhase("collapsed"), []);
  const expand = useCallback(() => setPhase("prompt"), []);
  const hide = useCallback(() => {
    if (inTauri) {
      hideWindow();
      setPhase("prompt");
      return;
    }
    setPhase("hidden");
  }, []);
  const minimize = useCallback(
    () => openRoute(afterStartHref),
    [afterStartHref, openRoute]
  );

  const launch: StartWidgetLaunch | undefined = brief
    ? {
        caption: LAUNCH.caption,
        description: launchDescription(projectName, callPeople),
        progress: brief.progress,
        steps: brief.steps,
        time,
      }
    : undefined;

  return (
    <DesktopStage>
      {phase === "hidden" ? (
        <HiddenNotice onShow={expand} />
      ) : (
        <StartWidget
          addablePeople={addablePeople}
          callHref={routes.call()}
          launch={launch}
          onAddParticipant={addParticipant}
          onDismiss={collapse}
          onExpand={expand}
          onHide={hide}
          onMinimize={minimize}
          onProjectChange={changeProject}
          onRemoveParticipant={removeParticipant}
          onStart={start}
          overlayHref={routes.overlay()}
          participants={participants}
          projectId={projectId}
          projects={pickerProjects}
          state={phase}
        />
      )}
    </DesktopStage>
  );
}

export function StartWidgetPage() {
  const demo = useDemoState(DEMO_STATES);
  // A new ?demo= restarts the flow from that state
  return <StartWidgetFlow initialPhase={demo ?? "prompt"} key={demo} />;
}
