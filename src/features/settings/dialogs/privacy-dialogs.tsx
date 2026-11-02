"use client";

import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChoiceField, ChoiceFieldLabel } from "@/components/ui/choice-field";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";

import { deleteAllData, exportData, isAbortError } from "../api";
import { ReadonlyField } from "../components/settings-rows";
import { FolderIcon } from "../icons";
import { DATA_SUMMARY, DELETE_CONFIRM_WORD, EXPORT_FOLDER } from "../mock";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/*
 * Dialogs of Settings → Приватность: export to Markdown (audio optional)
 * and "Очистить всё", confirmed by typing the word «удалить».
 */

function ExportForm({
  onBusyChange,
  onDone,
}: {
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
}) {
  const nextSignal = useAbortSignal();
  const [includeAudio, setIncludeAudio] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const exporting = progress !== null;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setProgress(0);
      onBusyChange(true);
      try {
        await exportData(
          { folder: EXPORT_FOLDER, includeAudio },
          setProgress,
          nextSignal()
        );
        toast.add({
          description: EXPORT_FOLDER,
          title: includeAudio
            ? "Экспорт готов, вместе с аудио"
            : "Экспорт готов",
          type: "success",
        });
        onBusyChange(false);
        onDone();
      } catch (exportError) {
        if (isAbortError(exportError)) {
          return;
        }
        setProgress(null);
        onBusyChange(false);
        showErrorToast("Не получилось экспортировать", exportError);
      }
    },
    [includeAudio, nextSignal, onBusyChange, onDone]
  );

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Куда</p>
        <ReadonlyField icon={<FolderIcon />}>{EXPORT_FOLDER}</ReadonlyField>
      </div>
      <ChoiceField>
        <Checkbox
          checked={includeAudio}
          disabled={exporting}
          onCheckedChange={setIncludeAudio}
        />
        <ChoiceFieldLabel>Включить аудио, это ещё около 1 ГБ</ChoiceFieldLabel>
      </ChoiceField>
      {exporting ? (
        <Progress value={progress}>
          <ProgressLabel>Собираем проекты и звонки</ProgressLabel>
        </Progress>
      ) : null}
      <DialogFooter>
        <DialogClose
          disabled={exporting}
          render={<Button variant="secondary" />}
        >
          Отмена
        </DialogClose>
        <Button disabled={exporting} type="submit">
          {exporting ? "Экспортируем…" : "Экспортировать"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ExportDataDialog({
  onOpenChange,
  open,
}: {
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
          <DialogTitle>Экспорт данных</DialogTitle>
          <DialogDescription>
            Все проекты, итоги и расшифровки в Markdown, по папке на проект
          </DialogDescription>
        </DialogHeader>
        <ExportForm onBusyChange={setBusy} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

function DeleteAllForm({
  onBusyChange,
  onDeleted,
}: {
  onBusyChange: (busy: boolean) => void;
  onDeleted: () => void;
}) {
  const inputId = useId();
  const nextSignal = useAbortSignal();
  const [word, setWord] = useState("");
  const [deleting, setDeleting] = useState(false);
  const confirmed = word.trim().toLowerCase() === DELETE_CONFIRM_WORD;

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setWord(event.target.value);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!confirmed) {
        return;
      }
      setDeleting(true);
      onBusyChange(true);
      try {
        await deleteAllData(nextSignal());
        onBusyChange(false);
        onDeleted();
      } catch (deleteError) {
        if (isAbortError(deleteError)) {
          return;
        }
        setDeleting(false);
        onBusyChange(false);
        showErrorToast("Не получилось удалить данные", deleteError);
      }
    },
    [confirmed, nextSignal, onBusyChange, onDeleted]
  );

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={handleSubmit}>
      <Field>
        <FieldLabel htmlFor={inputId}>
          Введите «{DELETE_CONFIRM_WORD}», чтобы подтвердить
        </FieldLabel>
        <Input
          autoComplete="off"
          autoFocus
          id={inputId}
          onChange={handleChange}
          readOnly={deleting}
          spellCheck={false}
          value={word}
        />
      </Field>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={deleting}>Отмена</AlertDialogCancel>
        <Button
          disabled={!confirmed || deleting}
          type="submit"
          variant="destructive"
        >
          {deleting ? <Spinner aria-hidden="true" /> : null}
          {deleting ? "Удаляем…" : "Удалить всё"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

export function DeleteAllDataDialog({
  onDeleted,
  onOpenChange,
  open,
}: {
  /** Everything is gone: reset the app state and leave Settings. */
  onDeleted: () => void;
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

  return (
    <AlertDialog onOpenChange={handleOpenChange} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить всё из Grill?</AlertDialogTitle>
          <AlertDialogDescription>
            {DATA_SUMMARY}. Вернуть их будет нельзя
          </AlertDialogDescription>
        </AlertDialogHeader>
        <DeleteAllForm onBusyChange={setBusy} onDeleted={onDeleted} />
      </AlertDialogContent>
    </AlertDialog>
  );
}
