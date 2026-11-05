"use client";

import { type FormEvent, useCallback, useState } from "react";
import type { TaskCardDecision } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { ClickUpIcon, GitHubIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { CheckIcon } from "../icons";

/*
 * Decisions on a task card in the app: accept, edit the title, discard
 * and bring back. Sending an accepted card to ClickUp or GitHub waits for
 * the integrations: the buttons are there, unavailable, marked «скоро».
 */

export type TaskCardCommand = "accept" | "discard" | "edit" | "restore";

const SERVICES = [
  { icon: ClickUpIcon, id: "clickup", name: "ClickUp" },
  { icon: GitHubIcon, id: "github", name: "GitHub" },
] as const;

/** «Отправить в ClickUp», not available until the integration is. */
function SoonButton({ service }: { service: (typeof SERVICES)[number] }) {
  const { icon: Icon, name } = service;
  return (
    <Button className="gap-1.5" disabled variant="secondary">
      <Icon aria-hidden="true" className="size-3.5" />
      {`Отправить в ${name}`}
      <Badge indicator={false} size="sm" variant="outline">
        скоро
      </Badge>
    </Button>
  );
}

export function TaskCardActions({
  cardId,
  decision,
  onCommand,
}: {
  cardId: string;
  decision: TaskCardDecision;
  onCommand: (cardId: string, command: TaskCardCommand) => void;
}) {
  const accept = useCallback(
    () => onCommand(cardId, "accept"),
    [cardId, onCommand]
  );
  const edit = useCallback(
    () => onCommand(cardId, "edit"),
    [cardId, onCommand]
  );
  const discard = useCallback(
    () => onCommand(cardId, "discard"),
    [cardId, onCommand]
  );
  const restore = useCallback(
    () => onCommand(cardId, "restore"),
    [cardId, onCommand]
  );

  if (decision === "discarded") {
    return (
      <div className="flex items-center gap-2">
        <Button onClick={restore} size="sm" variant="secondary">
          Вернуть
        </Button>
      </div>
    );
  }

  if (decision === "accepted") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge indicator={false} variant="confirmed">
          <CheckIcon className="size-3" />
          принята
        </Badge>
        {SERVICES.map((service) => (
          <SoonButton key={service.id} service={service} />
        ))}
        <Button className="ml-auto" onClick={edit} variant="ghost">
          Изменить
        </Button>
        <Button onClick={restore} variant="ghost">
          Отменить
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button className="gap-1.5" onClick={accept} variant="secondary">
        <CheckIcon className="size-3.5" />
        Принять
      </Button>
      <Button className="text-foreground px-3.5" onClick={edit} variant="ghost">
        Изменить
      </Button>
      <Button className="px-2.5" onClick={discard} variant="ghost">
        Отбросить
      </Button>
    </div>
  );
}

/** "Изменить": the card's title in a dialog. */
export function EditTaskCardDialog({
  onOpenChange,
  onSave,
  open,
  title,
}: {
  onOpenChange: (open: boolean) => void;
  onSave: (title: string) => void;
  open: boolean;
  title: string;
}) {
  const [value, setValue] = useState(title);
  const [syncedTitle, setSyncedTitle] = useState(title);
  if (title !== syncedTitle) {
    setSyncedTitle(title);
    setValue(title);
  }

  const change = useCallback(
    (event: { target: { value: string } }) => setValue(event.target.value),
    []
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const next = value.trim();
      if (next) {
        onSave(next);
      }
    },
    [onSave, value]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Изменить карточку</DialogTitle>
            <DialogDescription>
              Название карточки во всех окнах и в задаче, когда её можно будет
              отправить в ClickUp или GitHub.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Название карточки"
            onChange={change}
            value={value}
          />
          <DialogFooter>
            <Button type="submit">Сохранить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
