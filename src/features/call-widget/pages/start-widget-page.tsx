"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { usePeople } from "@/data/people";
import { useProjects } from "@/data/projects";
import { useSettings } from "@/data/settings";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import {
  type BriefProgress,
  buildBrief,
  getLastCallParticipantIds,
  joinNames,
  startRecording,
  toParticipant,
  toPickerProject,
} from "../api";
import { DesktopStage } from "../components/desktop-stage";
import { FloatingSurface } from "../components/floating-surface";
import { LAST_CALL_PROJECT_ID, LAUNCH, type Participant } from "../mock";
import { StartWidget, type StartWidgetLaunch } from "../screens/start-widget";
import { useCallTime } from "../use-call-clock";

/*
 * /widget: the start widget. The meeting app took the microphone, the
 * widget asks to start the call with the project and people of the last
 * one. "Начать" starts recording and refreshes the brief; when it is ready
 * the widget hands over to the compact overlay (or the call window when the
 * overlay is off in Settings).
 */

type Phase = "prompt" | "launching" | "collapsed" | "hidden";

/** States the navigator can open directly; the rest come by clicking. */
const DEMO_STATES = ["launching", "collapsed", "hidden"] as const;

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
        <Button nativeButton={false} render={<Link href={routes.home()} />}>
          Открыть Grill
        </Button>
      </div>
    </FloatingSurface>
  );
}

function StartWidgetFlow({ initialPhase }: { initialPhase: Phase }) {
  const router = useRouter();
  const projects = useProjects();
  const { compactOverlay } = useSettings();

  const pickerProjects = useMemo(
    () => projects.map(toPickerProject),
    [projects]
  );
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [projectId, setProjectId] = useState<string | null>(
    () =>
      projects.find((project) => project.id === LAST_CALL_PROJECT_ID)?.id ??
      projects[0]?.id ??
      null
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    getLastCallParticipantIds(projectId)
  );
  const [brief, setBrief] = useState<BriefProgress | null>(null);

  const people = usePeople(projectId);
  const clientPeople = useMemo(() => people.map(toParticipant), [people]);
  // Who is on the call, fixed by "Начать" (the ?demo=launching start uses
  // the preselected people).
  const [callPeople, setCallPeople] = useState<Participant[]>(() =>
    clientPeople.filter((person) => selectedIds.includes(person.id))
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
    const timer = setTimeout(() => router.push(afterStartHref), HANDOVER_MS);
    return () => clearTimeout(timer);
  }, [afterStartHref, brief?.done, phase, router]);

  const changeProject = useCallback((next: string | null) => {
    setProjectId(next);
    setSelectedIds(getLastCallParticipantIds(next));
  }, []);
  const addParticipant = useCallback((id: string) => {
    setSelectedIds((ids) => [...ids, id]);
  }, []);
  const removeParticipant = useCallback((id: string) => {
    setSelectedIds((ids) => ids.filter((item) => item !== id));
  }, []);

  const start = useCallback(() => {
    startRecording({ participants, projectId });
    setCallPeople(participants);
    setBrief(null);
    setPhase("launching");
  }, [participants, projectId]);
  const collapse = useCallback(() => setPhase("collapsed"), []);
  const expand = useCallback(() => setPhase("prompt"), []);
  const hide = useCallback(() => setPhase("hidden"), []);
  const minimize = useCallback(
    () => router.push(afterStartHref),
    [afterStartHref, router]
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
