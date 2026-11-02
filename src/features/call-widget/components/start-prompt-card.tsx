"use client";

import { type ComponentProps, useCallback } from "react";

import { ZoomIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import {
  CallWidgetFooter,
  CallWidgetPeople,
} from "@/components/ui/call-widget";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  return <DropdownMenuItem onClick={add}>{person.name}</DropdownMenuItem>;
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

/*
 * "Начать звонок?": the meeting app took the microphone. Project and people
 * come from the last call; `projectOpen` shows the project list open.
 */
export function StartPromptCard({
  addablePeople,
  app,
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
  ...props
}: ComponentProps<"div"> & {
  /** The client's people not on the call yet, for the "+" menu. */
  addablePeople?: Participant[];
  app: string;
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
        <ZoomIcon className="-my-2 size-8" />
        <span className="text-muted-foreground text-sm">
          <span className="sr-only">{app} </span>
          использует микрофон
        </span>
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
      <ParticipantsField
        addable={addablePeople}
        onAdd={onAddParticipant}
        onRemove={onRemoveParticipant}
        participants={participants}
      />
      <CallWidgetFooter className="items-center pt-0.5">
        <Button className="flex-1" onClick={onStart} size="lg">
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
