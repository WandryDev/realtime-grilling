"use client";

import { Alert, AlertDescription, AlertTitle } from "@grill/ui/alert";
import { ZoomIcon } from "@grill/ui/brand-icons";
import { Button } from "@grill/ui/button";
import { CallWidgetFooter, CallWidgetPeople } from "@grill/ui/call-widget";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grill/ui/dropdown-menu";
import { Spinner } from "@grill/ui/spinner";
import { CircleAlertIcon } from "lucide-react";
import { type ComponentProps, useCallback } from "react";
import { cn } from "@/lib/utils";

import { DismissIcon } from "../icons";
import type { Participant, PickerProject } from "../mock";
import { ParticipantAdd, ParticipantChip } from "./participant-chip";
import { ProjectField } from "./project-picker";
import { StatusDot } from "./status-dot";
import { WidgetCard } from "./widget-card";
import { WidgetHeader, WidgetHeading, WidgetIconButton } from "./widget-header";

function RemovableParticipant({
  onRemove,
  person,
}: {
  onRemove?: (id: string) => void;
  person: Participant;
}) {
  const remove = useCallback(() => onRemove?.(person.id), [onRemove, person]);
  return (
    <ParticipantChip
      detail={person.detail}
      initials={person.initials}
      name={person.name}
      onRemove={onRemove ? remove : undefined}
    />
  );
}

function AddPersonItem({
  onAdd,
  person,
}: {
  onAdd: (id: string) => void;
  person: Participant;
}) {
  const add = useCallback(() => onAdd(person.id), [onAdd, person]);
  return (
    <DropdownMenuItem onClick={add} title={person.detail}>
      {person.name}
    </DropdownMenuItem>
  );
}

/*
 * The dashed "+": with `onAdd` it opens a menu of the client's people who
 * aren't on the call yet; disabled when everyone is already there.
 */
function AddParticipant({
  addable,
  onAdd,
}: {
  addable: Participant[];
  onAdd?: (id: string) => void;
}) {
  if (!onAdd) {
    return <ParticipantAdd />;
  }
  if (addable.length === 0) {
    return <ParticipantAdd disabled />;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<ParticipantAdd />} />
      <DropdownMenuContent>
        {addable.map((person) => (
          <AddPersonItem key={person.id} onAdd={onAdd} person={person} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Участники": removable chips and a dashed "+" circle. */
function ParticipantsField({
  addable = [],
  className,
  onAdd,
  onRemove,
  participants,
}: {
  addable?: Participant[];
  className?: string;
  onAdd?: (id: string) => void;
  onRemove?: (id: string) => void;
  participants: Participant[];
}) {
  return (
    <fieldset className={cn("flex min-w-0 flex-col", className)}>
      {/* A legend sits outside the flex flow, so it carries the 8px gap */}
      <legend className="text-muted-foreground mb-2 text-sm font-medium">
        Участники
      </legend>
      <CallWidgetPeople>
        {participants.map((person) => (
          <RemovableParticipant
            key={person.id}
            onRemove={onRemove}
            person={person}
          />
        ))}
        <AddParticipant addable={addable} onAdd={onAdd} />
      </CallWidgetPeople>
    </fieldset>
  );
}

const ZOOM = /zoom/iu;

/*
 * "Zoom использует микрофон": Zoom has its logo (and its name for screen
 * readers), any other app its name.
 */
function MeetingApp({ app }: { app: string }) {
  if (ZOOM.test(app)) {
    return (
      <>
        <ZoomIcon className="-my-2 size-8" />
        <span className="text-muted-foreground text-sm">
          <span className="sr-only">{app} </span>
          использует микрофон
        </span>
      </>
    );
  }
  return (
    <span className="text-muted-foreground min-w-0 truncate text-sm">
      <span className="text-foreground font-medium">{app}</span> использует
      микрофон
    </span>
  );
}

/** Why "Начать" didn't start the recording. */
export interface StartError {
  description: string;
  /** "Открыть настройки": where the access is turned on. */
  onOpenSettings?: () => void;
  title: string;
}

function StartErrorAlert({ error }: { error: StartError }) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{error.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        {error.description}
        {error.onOpenSettings ? (
          <Button onClick={error.onOpenSettings} size="sm" variant="secondary">
            Открыть настройки
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/*
 * "Начать звонок?": the meeting app took the microphone. Project and people
 * come from the last call; `projectOpen` shows the project list open.
 */
export function StartPromptCard({
  addablePeople,
  app,
  briefNote,
  className,
  onAddParticipant,
  onDismiss,
  onProjectChange,
  onRemoveParticipant,
  onStart,
  participants,
  projectId,
  projectOpen = false,
  projects,
  startError,
  starting = false,
  ...props
}: ComponentProps<"div"> & {
  /** The client's people not on the call yet, for the "+" menu. */
  addablePeople?: Participant[];
  app: string;
  /** "Обновляю бриф…": the project's brief is being refreshed. */
  briefNote?: string;
  onAddParticipant?: (id: string) => void;
  /** × and "Не сейчас": collapse into the pill. */
  onDismiss?: () => void;
  onProjectChange?: (projectId: string | null) => void;
  onRemoveParticipant?: (id: string) => void;
  onStart?: () => void;
  participants: Participant[];
  projectId: string | null;
  projectOpen?: boolean;
  projects: PickerProject[];
  /** The last "Начать" failed: why, and where to fix it. */
  startError?: StartError | null;
  /** "Начать" was pressed and the recording is starting. */
  starting?: boolean;
}) {
  return (
    <WidgetCard className={className} {...props}>
      <WidgetHeader
        action={
          <WidgetIconButton aria-label="Закрыть" onClick={onDismiss}>
            <DismissIcon />
          </WidgetIconButton>
        }
      >
        <StatusDot tone="accent" />
        <MeetingApp app={app} />
      </WidgetHeader>
      <WidgetHeading
        description="Буду слушать и подсказывать вопросы. В звонок никто не подключится."
        title="Начать звонок?"
      />
      <ProjectField
        onValueChange={onProjectChange}
        open={projectOpen}
        projects={projects}
        value={projectId}
      />
      {briefNote ? (
        <p
          className="text-muted-foreground -mt-2 flex items-center gap-2 text-sm"
          role="status"
        >
          <Spinner className="size-3.5" />
          {briefNote}
        </p>
      ) : null}
      <ParticipantsField
        addable={addablePeople}
        onAdd={onAddParticipant}
        onRemove={onRemoveParticipant}
        participants={participants}
      />
      {startError ? <StartErrorAlert error={startError} /> : null}
      <CallWidgetFooter className="items-center pt-0.5">
        <Button
          className="flex-1"
          disabled={starting}
          onClick={onStart}
          size="lg"
        >
          <span
            aria-hidden="true"
            className="bg-recording size-[7px] shrink-0 rounded-full"
          />
          Начать
        </Button>
        <Button
          className="px-4"
          onClick={onDismiss}
          size="lg"
          variant="secondary"
        >
          Не сейчас
        </Button>
      </CallWidgetFooter>
    </WidgetCard>
  );
}
