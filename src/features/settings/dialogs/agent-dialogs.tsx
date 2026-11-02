"use client";

import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { updateSetting } from "@/data/settings";

import { checkAgent, isAbortError } from "../api";
import { useAbortSignal } from "../use-abort-signal";

/*
 * Dialogs of Settings → Агент: another path to the CLI (checked before it
 * is saved) and the sign-out confirmation.
 */

function AgentPathForm({
  current,
  onDone,
}: {
  current: string;
  onDone: () => void;
}) {
  const nextSignal = useAbortSignal();
  const [path, setPath] = useState(current);
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPath(event.target.value);
    setError(undefined);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const next = path.trim();
      if (!next) {
        setError("Укажите путь к claude");
        return;
      }
      setChecking(true);
      try {
        await checkAgent(next, nextSignal());
        updateSetting("agentPath", next);
        toast.add({
          description: next,
          title: "Claude Code найден",
          type: "success",
        });
        onDone();
      } catch (checkError) {
        if (isAbortError(checkError)) {
          return;
        }
        setChecking(false);
        setError(
          checkError instanceof Error ? checkError.message : "Не нашли CLI"
        );
      }
    },
    [nextSignal, onDone, path]
  );

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={handleSubmit}>
      <Field invalid={Boolean(error)}>
        <FieldLabel>Путь к CLI</FieldLabel>
        <Input
          autoFocus
          className="font-mono text-sm"
          onChange={handleChange}
          placeholder="/usr/local/bin/claude"
          readOnly={checking}
          spellCheck={false}
          value={path}
        />
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button variant="secondary" />}>
          Отмена
        </DialogClose>
        <Button disabled={checking} type="submit">
          {checking ? <Spinner aria-hidden="true" /> : null}
          {checking ? "Проверяем…" : "Проверить и сохранить"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AgentPathDialog({
  current,
  onOpenChange,
  open,
}: {
  current: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Где лежит Claude Code</DialogTitle>
          <DialogDescription>
            Grill проверит, что CLI отвечает и вход выполнен, и только потом
            сохранит путь
          </DialogDescription>
        </DialogHeader>
        <AgentPathForm current={current} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

export function AgentSignOutDialog({
  onConfirm,
  onOpenChange,
  open,
}: {
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Выйти из Claude Code?</AlertDialogTitle>
          <AlertDialogDescription>
            Без входа агент не сможет предлагать вопросы на звонках. Войти снова
            можно в любой момент
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} variant="destructive">
            Выйти
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
