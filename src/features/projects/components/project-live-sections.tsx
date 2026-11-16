"use client";

import { type ChangeEvent, useCallback, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { MoreIcon, TrashIcon } from "../icons";
import { SectionHeading } from "./section-heading";
import { ManagerNotesField } from "./wizard-brief";

/*
 * The parts of the project page that hold state: a person's menu and the
 * editable notes. The rest of the sections render on the server too (the
 * /dev/screens previews).
 */

/** "⋯" on a person's card: edit or remove them, next to the card's link. */
export function PersonMenu({
  name,
  onEdit,
  onRemove,
  personId,
}: {
  name: string;
  onEdit?: (personId: string) => void;
  onRemove?: (personId: string) => void;
  personId: string;
}) {
  const edit = useCallback(() => onEdit?.(personId), [onEdit, personId]);
  const remove = useCallback(() => onRemove?.(personId), [onRemove, personId]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Действия: ${name}`}
            className="absolute top-4 right-4"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <MoreIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onEdit ? (
          <DropdownMenuItem onClick={edit}>Изменить</DropdownMenuItem>
        ) : null}
        {onRemove ? (
          <DropdownMenuItem onClick={remove} variant="destructive">
            <TrashIcon />
            Убрать из проекта
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Заметки менеджера": what only the manager knows. The agent reads them
 * into the brief; "Сохранить" writes them, and the brief may go outdated.
 */
export function NotesSection({
  className,
  id,
  notes,
  onSave,
}: {
  className?: string;
  id?: string;
  notes: string;
  onSave?: (notes: string) => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState(notes);
  const [saved, setSaved] = useState(notes);
  // The stored notes changed (here or in another window): show them.
  if (saved !== notes) {
    setSaved(notes);
    setDraft(notes);
  }
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
    []
  );
  const save = useCallback(() => onSave?.(draft.trim()), [draft, onSave]);
  const changed = draft.trim() !== notes.trim();
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex scroll-mt-20 flex-col gap-4 pt-9", className)}
      id={id}
    >
      <SectionHeading
        action={
          <Button
            className="px-3.5"
            disabled={!(changed && onSave)}
            onClick={save}
            variant="secondary"
          >
            Сохранить заметки
          </Button>
        }
        id={titleId}
        meta="то, чего нет в документах"
        title="Заметки"
      />
      <ManagerNotesField
        className="max-w-[760px]"
        onChange={onSave ? handleChange : undefined}
        value={onSave ? draft : notes}
      />
    </section>
  );
}
