"use client";

import { type FormEvent, useCallback, useState } from "react";

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
import { Spinner } from "@/components/ui/spinner";
import type { TaskCardReview, TaskSync, TaskSyncService } from "@/data/calls";
import type { IntegrationStatus } from "@/data/integrations";

import { CheckIcon } from "../icons";
import { LinkButton } from "./link-button";

/*
 * Decisions on a task card in the app: accept, edit the title, discard;
 * an accepted card goes to ClickUp as a task or to GitHub as an issue. A
 * service that is not connected offers a link to Settings → Integrations.
 */

export type TaskCardCommand = "accept" | "discard" | "edit" | "restore";

const SERVICE = {
  clickup: { icon: ClickUpIcon, name: "ClickUp" },
  github: { icon: GitHubIcon, name: "GitHub" },
} as const;

function SendButton({
  cardId,
  connectHref,
  onSend,
  service,
  status,
  sync,
}: {
  cardId: string;
  connectHref: string;
  onSend: (cardId: string, service: TaskSyncService) => void;
  service: TaskSyncService;
  status: IntegrationStatus;
  sync?: TaskSync;
}) {
  const { icon: Icon, name } = SERVICE[service];
  const send = useCallback(
    () => onSend(cardId, service),
    [cardId, onSend, service]
  );

  if (sync?.status === "sent") {
    return (
      <p className="text-muted-foreground flex h-9 items-center gap-1.5 px-1 text-sm">
        <CheckIcon className="text-confirmed size-3.5 shrink-0" />
        {`В ${name}: `}
        <span className="text-foreground font-mono text-xs">{sync.ref}</span>
      </p>
    );
  }
  if (sync?.status === "sending") {
    return (
      <Button className="gap-1.5" disabled variant="secondary">
        <Spinner aria-hidden="true" className="size-3.5" role="presentation" />
        {`Отправляю в ${name}`}
      </Button>
    );
  }
  if (status !== "connected") {
    return (
      <LinkButton className="gap-1.5" href={connectHref} variant="ghost">
        <Icon aria-hidden="true" className="size-3.5" />
        {`Подключить ${name}`}
      </LinkButton>
    );
  }
  return (
    <Button className="gap-1.5" onClick={send} variant="secondary">
      <Icon aria-hidden="true" className="size-3.5" />
      {`Отправить в ${name}`}
    </Button>
  );
}

export function TaskCardActions({
  cardId,
  connectHref,
  integrations,
  onCommand,
  onSend,
  review,
}: {
  cardId: string;
  /** Settings → Integrations. */
  connectHref: string;
  integrations: Record<TaskSyncService, IntegrationStatus>;
  onCommand: (cardId: string, command: TaskCardCommand) => void;
  onSend: (cardId: string, service: TaskSyncService) => void;
  review: TaskCardReview;
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

  if (review.decision === "discarded") {
    return (
      <div className="flex items-center gap-2">
        <Button onClick={restore} size="sm" variant="secondary">
          Вернуть
        </Button>
      </div>
    );
  }

  if (review.decision === "accepted") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge indicator={false} variant="confirmed">
          <CheckIcon className="size-3" />
          принята
        </Badge>
        {(["clickup", "github"] as const).map((service) => (
          <SendButton
            cardId={cardId}
            connectHref={connectHref}
            key={service}
            onSend={onSend}
            service={service}
            status={integrations[service]}
            sync={review.sync[service]}
          />
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
              Название уйдёт в задачу ClickUp или GitHub, когда вы её отправите.
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
