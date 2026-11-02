"use client";

import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";

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
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { updateSetting } from "@/data/settings";

import { isAbortError, moveRecordings } from "../api";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/*
 * "Изменить" next to the recordings folder. In the app the system folder
 * picker opens; here the path is typed. The saved calls then move to the new
 * folder with progress, and the dialog can't be closed until they have.
 */

function FolderForm({
  current,
  onBusyChange,
  onDone,
}: {
  current: string;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const nextSignal = useAbortSignal();
  const [path, setPath] = useState(current);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<number | null>(null);
  const moving = progress !== null;

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPath(event.target.value);
    setError(undefined);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const next = path.trim();
      if (!next) {
        setError("Укажите папку");
        return;
      }
      if (next === current) {
        onDone();
        return;
      }
      setProgress(0);
      onBusyChange(true);
      try {
        await moveRecordings(next, setProgress, nextSignal());
        updateSetting("recordingsFolder", next);
        toast.add({
          description: next,
          title: "Записи перенесены",
          type: "success",
        });
        onBusyChange(false);
        onDone();
      } catch (moveError) {
        if (isAbortError(moveError)) {
          return;
        }
        setProgress(null);
        onBusyChange(false);
        showErrorToast("Не получилось перенести записи", moveError);
      }
    },
    [current, nextSignal, onBusyChange, onDone, path]
  );

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={handleSubmit}>
      {moving ? (
        <Progress value={progress}>
          <ProgressLabel>Переносим 38 звонков</ProgressLabel>
        </Progress>
      ) : (
        <Field invalid={Boolean(error)}>
          <FieldLabel>Новая папка</FieldLabel>
          <Input
            autoFocus
            className="font-mono text-sm"
            onChange={handleChange}
            spellCheck={false}
            value={path}
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      )}
      <DialogFooter>
        <DialogClose disabled={moving} render={<Button variant="secondary" />}>
          Отмена
        </DialogClose>
        <Button disabled={moving} type="submit">
          {moving ? "Переносим…" : "Перенести"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RecordingsFolderDialog({
  current,
  onOpenChange,
  open,
}: {
  current: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!busy) {
        onOpenChange(next);
      }
    },
    [busy, onOpenChange]
  );
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Папка для записей</DialogTitle>
          <DialogDescription>
            Аудио, расшифровки и итоги переедут в новую папку. Старая останется
            пустой.
          </DialogDescription>
        </DialogHeader>
        <FolderForm current={current} onBusyChange={setBusy} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}
