import { LaunchCard } from "../components/launch-card";
import { StartPill } from "../components/start-pill";
import {
  type StartError,
  StartPromptCard,
} from "../components/start-prompt-card";
import {
  BRIEF_STEPS,
  type BriefStepItem,
  CALL_PARTICIPANTS,
  LAUNCH,
  MEETING_APP,
  type Participant,
  PICKER_PROJECTS,
  type PickerProject,
} from "../mock";

/*
 * Paper "01 Виджет старта". The widget pops up at the top right two seconds
 * after Zoom, Meet or Telegram takes the microphone.
 * - prompt: "Начать звонок?" with the project and people of the last call
 * - choosing-project: the project list is open
 * - launching: recording started, the brief is being refreshed
 * - collapsed: "Не сейчас" turned it into a pill
 */
export type StartWidgetState =
  | "prompt"
  | "choosing-project"
  | "launching"
  | "collapsed";

/** The launch card's live data; previews use the Paper values. */
export interface StartWidgetLaunch {
  caption: string;
  description: string;
  progress: number;
  steps: BriefStepItem[];
  time: string;
}

export function StartWidget({
  addablePeople,
  app = MEETING_APP,
  briefNote,
  callHref,
  className,
  launch,
  onAddParticipant,
  onDismiss,
  onExpand,
  onHide,
  onMinimize,
  onProjectChange,
  onRemoveParticipant,
  onStart,
  overlayHref,
  participants = CALL_PARTICIPANTS,
  projectId = PICKER_PROJECTS[0].id,
  projects = PICKER_PROJECTS,
  startError,
  starting,
  state = "prompt",
  steps = BRIEF_STEPS,
}: {
  /** The client's people not on the call yet, for the "+" menu. */
  addablePeople?: Participant[];
  /** The meeting app that holds the microphone. */
  app?: string;
  /** "Обновляю бриф…" under the project while its brief is refreshed. */
  briefNote?: string;
  /** "Открыть окно звонка" on the launch card. */
  callHref?: string;
  className?: string;
  launch?: StartWidgetLaunch;
  onAddParticipant?: (id: string) => void;
  /** × and "Не сейчас" on the prompt. */
  onDismiss?: () => void;
  /** The pill's arrows. */
  onExpand?: () => void;
  /** The pill's ×. */
  onHide?: () => void;
  /** "−" on the launch card. */
  onMinimize?: () => void;
  onProjectChange?: (projectId: string | null) => void;
  onRemoveParticipant?: (id: string) => void;
  /** "Начать" on the prompt and on the pill. */
  onStart?: () => void;
  /** "Оверлей" on the launch card. */
  overlayHref?: string;
  participants?: Participant[];
  /** null: a call without a project. */
  projectId?: string | null;
  projects?: PickerProject[];
  /** The last "Начать" failed: shown on the prompt. */
  startError?: StartError | null;
  /** The recording is starting: "Начать" waits. */
  starting?: boolean;
  state?: StartWidgetState;
  steps?: BriefStepItem[];
}) {
  if (state === "collapsed") {
    const project = projects.find((item) => item.id === projectId);
    return (
      <StartPill
        app={app}
        className={className}
        onExpand={onExpand}
        onHide={onHide}
        onStart={onStart}
        project={project?.name ?? "Звонок"}
      />
    );
  }

  if (state === "launching") {
    const data = launch ?? { ...LAUNCH, steps };
    return (
      <LaunchCard
        callHref={callHref}
        caption={data.caption}
        className={className}
        description={data.description}
        onMinimize={onMinimize}
        overlayHref={overlayHref}
        progress={data.progress}
        steps={data.steps}
        time={data.time}
      />
    );
  }

  return (
    <StartPromptCard
      addablePeople={addablePeople}
      app={app}
      briefNote={briefNote}
      className={className}
      onAddParticipant={onAddParticipant}
      onDismiss={onDismiss}
      onProjectChange={onProjectChange}
      onRemoveParticipant={onRemoveParticipant}
      onStart={onStart}
      participants={participants}
      projectId={projectId}
      projectOpen={state === "choosing-project"}
      projects={projects}
      startError={startError}
      starting={starting}
    />
  );
}
