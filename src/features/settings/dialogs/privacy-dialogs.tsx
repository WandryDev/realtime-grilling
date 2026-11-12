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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import { backendErrorKind, deleteAllData, isAbortError } from "../api";
import { DELETE_CONFIRM_WORD } from "../mock";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/*
 * «Очистить всё» of Settings → Приватность, confirmed by typing the word
 * «удалить». Rust deletes everything (`data_delete_all`); it refuses while
 * a call records, and may report a part it could not do (a secret left in
 * Keychain) after doing the rest.
 */

function DeleteAllForm({
  onBusyChange,
  onDeleted,
}: {
  onBusyChange: (busy: boolean) => void;
  /** Everything is gone; `warning`: what Rust could not do. */
  onDeleted: (warning?: string) => void;
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
        onBusyChange(false);
        const kind = backendErrorKind(deleteError);
        if (kind === "External" && deleteError instanceof Error) {
          onDeleted(deleteError.message);
          return;
        }
        setDeleting(false);
        if (kind === "Invalid") {
          showErrorToast("Сначала завершите звонок", deleteError);
          return;
        }
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
  summary,
}: {
  /** Everything is gone: leave Settings; `warning`: what Rust could not do. */
  onDeleted: (warning?: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** «4 проекта, 38 звонков…», from `data_summary`. */
  summary: string;
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
            {summary}. Вернуть их будет нельзя
          </AlertDialogDescription>
        </AlertDialogHeader>
        <DeleteAllForm onBusyChange={setBusy} onDeleted={onDeleted} />
      </AlertDialogContent>
    </AlertDialog>
  );
}
