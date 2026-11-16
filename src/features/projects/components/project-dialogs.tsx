"use client";

import {
  type ChangeEvent,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useCallback,
  useId,
  useState,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogSurfaceClassName,
  dialogTitleClassName,
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import {
  DESCRIPTION_LIMIT_HINT,
  DESCRIPTION_MAX_CHARS,
} from "@/data/project-limits";
import { cn } from "@/lib/utils";

import { CloseIcon, TrashIcon } from "../icons";
import type { ADD_PERSON, DELETE_PROJECT } from "../mock";

/*
 * Dialogs over the project page. The preview draws them open in place (the
 * same surface and parts as Dialog and AlertDialog, shared class names) on a
 * 20% ink scrim that covers the window. The app opens the live versions
 * below (`*Live`), built from the same body parts.
 */
export function DialogScrim({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-foreground/20 dark:bg-scrim absolute inset-0 z-10 flex items-center justify-center",
        className
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------ Новый человек */

interface LevelOption {
  label: string;
  value: string;
}

/** Fields of "Новый человек": name, role, two scales and notes. */
export function AddPersonFields({
  defaults,
  levels,
  onTechChange,
  onUnderstandingChange,
  preview = false,
  tech,
  understanding,
}: {
  /** Prefilled values (the agent heard a new name on a call). */
  defaults?: { name?: string; role?: string };
  levels: Pick<typeof ADD_PERSON, "techLevels" | "understandingLevels">;
  onTechChange?: (value: string) => void;
  onUnderstandingChange?: (value: string) => void;
  /** Pins the focus look on "Роль" for the static preview. */
  preview?: boolean;
  tech: string;
  understanding: string;
}) {
  return (
    <>
      <div className="flex gap-3">
        <Field>
          <FieldLabel className="text-sm font-medium">Имя</FieldLabel>
          <Input
            autoComplete="off"
            defaultValue={defaults?.name}
            name="name"
            required
          />
        </Field>
        <Field>
          <FieldLabel className="text-sm font-medium">Роль</FieldLabel>
          <Input
            autoComplete="off"
            data-preview={preview ? "focus" : undefined}
            defaultValue={defaults?.role}
            name="role"
          />
        </Field>
      </div>
      <LevelChoice
        label="В технике"
        onValueChange={onTechChange}
        options={levels.techLevels}
        value={tech}
      />
      <LevelChoice
        label="Понимание проекта"
        onValueChange={onUnderstandingChange}
        options={levels.understandingLevels}
        value={understanding}
      />
      <Field>
        <div className="flex justify-between gap-4">
          <FieldLabel className="text-sm font-medium">
            Что важно знать
          </FieldLabel>
          <span className="text-muted-foreground text-sm">необязательно</span>
        </div>
        <Textarea
          className="min-h-18"
          name="notes"
          placeholder="Например: будет на звонках про сценарии оператора, говорит по делу"
        />
      </Field>
    </>
  );
}

export function AddPersonDialog({
  className,
  person,
  project,
}: {
  className?: string;
  person: typeof ADD_PERSON;
  project: string;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      aria-modal="true"
      className={cn(
        dialogSurfaceClassName,
        "relative w-[520px] p-7",
        className
      )}
      role="dialog"
    >
      <div className={cn(dialogHeaderClassName, "gap-1")}>
        <h2 className={dialogTitleClassName} id={titleId}>
          Новый человек
        </h2>
        <p className={cn(dialogDescriptionClassName, "text-sm")}>
          Со стороны клиента, проект {project}
        </p>
      </div>
      <Button
        aria-label="Закрыть"
        className="absolute top-5 right-5"
        size="icon"
        variant="ghost"
      >
        <CloseIcon className="size-4" />
      </Button>
      <AddPersonFields
        defaults={person}
        levels={person}
        preview
        tech={person.tech}
        understanding={person.understanding}
      />
      <div className={cn(dialogFooterClassName, "pt-1 [&>button]:text-sm")}>
        <Button variant="secondary">Отмена</Button>
        <Button>Добавить</Button>
      </div>
    </section>
  );
}

/** What the person dialogs save: every field but the name is optional. */
export interface PersonFormValues {
  /** "Как формулировать вопросы", word for word for the agent. */
  askStyle: string;
  character: string;
  name: string;
  notes: string;
  /** 1–5; `null`: not set. */
  project: number | null;
  role: string;
  tech: number | null;
  temperament: string;
}

export const EMPTY_PERSON: PersonFormValues = {
  askStyle: "",
  character: "",
  name: "",
  notes: "",
  project: null,
  role: "",
  tech: null,
  temperament: "",
};

const NOT_SET = "";

function levelOf(value: FormDataEntryValue | null): number | null {
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 5 ? level : null;
}

/** A 1–5 scale as a select, "Не указано" first. */
function LevelSelect({
  defaultValue,
  label,
  labels,
  name,
}: {
  defaultValue: number | null;
  label: string;
  labels: readonly string[];
  name: string;
}) {
  const id = useId();
  return (
    <Field className="min-w-0 flex-1">
      <FieldLabel className="text-sm font-medium" htmlFor={id}>
        {label}
      </FieldLabel>
      <NativeSelect
        className="w-full [&_select]:h-9"
        defaultValue={defaultValue === null ? NOT_SET : String(defaultValue)}
        id={id}
        name={name}
      >
        <NativeSelectOption value={NOT_SET}>Не указано</NativeSelectOption>
        {labels.map((text, index) => (
          <NativeSelectOption key={text} value={String(index + 1)}>
            {index + 1}, {text}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

/**
 * Live "Новый человек" and "Изменить человека": the profile the agent words
 * its questions by. Enter adds, Esc or the backdrop closes. `person` fills
 * the fields when editing; `levels` names the steps of the two scales.
 */
export function PersonDialog({
  levels,
  onOpenChange,
  onSave,
  open,
  person,
  project,
}: {
  levels: { project: readonly string[]; tech: readonly string[] };
  onOpenChange: (open: boolean) => void;
  onSave: (values: PersonFormValues) => void;
  open: boolean;
  /** The person to edit; a new one without it. */
  person?: PersonFormValues;
  project: string;
}) {
  const editing = person !== undefined;
  const values = person ?? EMPTY_PERSON;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const text = (key: string) => String(data.get(key) ?? "").trim();
      const name = text("name");
      if (!name) {
        return;
      }
      onSave({
        askStyle: text("askStyle"),
        character: text("character"),
        name,
        notes: text("notes"),
        project: levelOf(data.get("project")),
        role: text("role"),
        tech: levelOf(data.get("tech")),
        temperament: text("temperament"),
      });
    },
    [onSave]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="p-7 sm:max-w-[560px]" showCloseButton={false}>
        <form className="contents" onSubmit={handleSubmit}>
          <DialogHeader className="gap-1">
            <DialogTitle>
              {editing ? "Изменить человека" : "Новый человек"}
            </DialogTitle>
            <DialogDescription className="text-sm">
              Со стороны клиента, проект {project}
            </DialogDescription>
          </DialogHeader>
          <DialogClose
            aria-label="Закрыть"
            render={
              <Button
                className="absolute top-5 right-5"
                size="icon"
                variant="ghost"
              />
            }
          >
            <CloseIcon className="size-4" />
          </DialogClose>
          <div className="flex gap-3">
            <Field>
              <FieldLabel className="text-sm font-medium">Имя</FieldLabel>
              <Input
                autoComplete="off"
                defaultValue={values.name}
                name="name"
                required
              />
            </Field>
            <Field>
              <FieldLabel className="text-sm font-medium">Роль</FieldLabel>
              <Input
                autoComplete="off"
                defaultValue={values.role}
                name="role"
              />
            </Field>
          </div>
          <div className="flex gap-3">
            <LevelSelect
              defaultValue={values.tech}
              label="В технике"
              labels={levels.tech}
              name="tech"
            />
            <LevelSelect
              defaultValue={values.project}
              label="Понимание проекта"
              labels={levels.project}
              name="project"
            />
          </div>
          <div className="flex gap-3">
            <Field>
              <FieldLabel className="text-sm font-medium">
                Темперамент
              </FieldLabel>
              <Input
                autoComplete="off"
                defaultValue={values.temperament}
                name="temperament"
                placeholder="Например: быстрый, перебивает"
              />
            </Field>
            <Field>
              <FieldLabel className="text-sm font-medium">Характер</FieldLabel>
              <Input
                autoComplete="off"
                defaultValue={values.character}
                name="character"
                placeholder="Например: ценит цифры и сроки"
              />
            </Field>
          </div>
          <Field>
            <FieldLabel className="text-sm font-medium">
              Как формулировать вопросы
            </FieldLabel>
            <Textarea
              className="min-h-16"
              defaultValue={values.askStyle}
              name="askStyle"
              placeholder="Например: простым языком, через деньги и сроки"
            />
          </Field>
          <Field>
            <div className="flex justify-between gap-4">
              <FieldLabel className="text-sm font-medium">
                Что важно знать
              </FieldLabel>
              <span className="text-muted-foreground text-sm">
                необязательно
              </span>
            </div>
            <Textarea
              className="min-h-16"
              defaultValue={values.notes}
              name="notes"
              placeholder="Например: будет на звонках про сценарии оператора, говорит по делу"
            />
          </Field>
          <DialogFooter className="pt-1 [&>button]:text-sm">
            <DialogClose render={<Button variant="secondary" />}>
              Отмена
            </DialogClose>
            <Button type="submit">{editing ? "Сохранить" : "Добавить"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Убрать из проекта": the person leaves the project and its calls. */
export function RemovePersonDialog({
  name,
  onOpenChange,
  onRemove,
  open,
}: {
  name: string;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
  open: boolean;
}) {
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      <AlertDialogContent className="p-7 sm:max-w-[440px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Убрать {name} из проекта?</AlertDialogTitle>
          <AlertDialogDescription>
            Профиль удалится, в участниках звонков этого человека больше не
            будет. Бриф может устареть.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="pt-1 [&>button]:text-sm">
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction onClick={onRemove} variant="destructive">
            Убрать
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Full-width segmented choice with a label above it. */
function LevelChoice({
  label,
  onValueChange,
  options,
  value,
}: {
  label: string;
  onValueChange?: (value: string) => void;
  options: LevelOption[];
  value: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-foreground text-sm font-medium">{label}</p>
      <SegmentedControl
        aria-label={label}
        className="w-full"
        defaultValue={onValueChange ? undefined : value}
        onValueChange={onValueChange}
        value={onValueChange ? value : undefined}
      >
        {options.map((option) => (
          <SegmentedControlItem
            className="h-[30px] flex-1 font-normal data-pressed:font-medium"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </div>
  );
}

/* ---------------------------------------------------- Удаление проекта */

function DeleteProjectMark() {
  return (
    <span className="bg-contradiction-soft text-contradiction flex size-11 shrink-0 items-center justify-center rounded-sm">
      <TrashIcon className="size-5" />
    </span>
  );
}

/**
 * What goes away, the name to type and "export first". The input and the
 * checkbox take live props in the app, static defaults in the preview.
 */
export function DeleteProjectBody({
  checkboxProps,
  contents,
  inputProps,
  preview = false,
}: {
  checkboxProps?: ComponentProps<typeof Checkbox>;
  contents: typeof DELETE_PROJECT.contents;
  inputProps?: ComponentProps<typeof Input>;
  /** Pins the focus look on the name field for the static preview. */
  preview?: boolean;
}) {
  return (
    <>
      <dl className="bg-surface flex flex-col gap-3 rounded-md px-4 py-3.5">
        {contents.map((entry) => (
          <div className="flex justify-between gap-4" key={entry.label}>
            <dt className="text-foreground text-base">{entry.label}</dt>
            <dd
              className={cn(
                "text-muted-foreground text-sm/5 tabular-nums",
                entry.mono && "font-mono"
              )}
            >
              {entry.value}
            </dd>
          </div>
        ))}
      </dl>
      <Field className="gap-2">
        <FieldLabel className="text-sm font-medium">
          Чтобы подтвердить, введите название проекта
        </FieldLabel>
        <Input
          autoComplete="off"
          data-preview={preview ? "focus" : undefined}
          {...inputProps}
        />
      </Field>
      <ChoiceField>
        <Checkbox {...checkboxProps} />
        <ChoiceFieldLabel>
          Сначала сохранить итоги звонков в Markdown
        </ChoiceFieldLabel>
      </ChoiceField>
    </>
  );
}

export function DeleteProjectDialog({
  className,
  contents,
  description,
  project,
}: {
  className?: string;
  contents: typeof DELETE_PROJECT.contents;
  description: string;
  project: string;
}) {
  const titleId = useId();
  const textId = useId();
  return (
    <section
      aria-describedby={textId}
      aria-labelledby={titleId}
      aria-modal="true"
      className={cn(dialogSurfaceClassName, "w-[480px] p-7", className)}
      role="alertdialog"
    >
      <DeleteProjectMark />
      <div className={dialogHeaderClassName}>
        <h2 className={dialogTitleClassName} id={titleId}>
          Удалить проект «{project}»?
        </h2>
        <p className={dialogDescriptionClassName} id={textId}>
          {description}
        </p>
      </div>
      <DeleteProjectBody
        checkboxProps={{ defaultChecked: true }}
        contents={contents}
        inputProps={{ defaultValue: project }}
        preview
      />
      <div className={cn(dialogFooterClassName, "pt-1 [&>button]:text-sm")}>
        <Button variant="secondary">Отмена</Button>
        <Button variant="destructive">Удалить проект</Button>
      </div>
    </section>
  );
}

/**
 * Live delete confirmation. The red button stays disabled until the name is
 * typed exactly; `onDelete` gets whether to export the calls first.
 */
export function DeleteProjectDialogLive({
  contents,
  description,
  onDelete,
  onOpenChange,
  open,
  project,
}: {
  contents: typeof DELETE_PROJECT.contents;
  description: string;
  onDelete: (options: { exportFirst: boolean }) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  project: string;
}) {
  const [typed, setTyped] = useState("");
  const [exportFirst, setExportFirst] = useState(true);
  const matches = typed.trim() === project;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setTyped("");
        setExportFirst(true);
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );
  const handleTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTyped(event.target.value);
  }, []);
  const handleExport = useCallback((checked: boolean) => {
    setExportFirst(checked);
  }, []);
  const handleDelete = useCallback(() => {
    if (matches) {
      onDelete({ exportFirst });
    }
  }, [exportFirst, matches, onDelete]);
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      handleDelete();
    },
    [handleDelete]
  );

  return (
    <AlertDialog onOpenChange={handleOpenChange} open={open}>
      <AlertDialogContent className="p-7 sm:max-w-[480px]">
        <form className="contents" onSubmit={handleSubmit}>
          <DeleteProjectMark />
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить проект «{project}»?</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <DeleteProjectBody
            checkboxProps={{
              checked: exportFirst,
              onCheckedChange: handleExport,
            }}
            contents={contents}
            inputProps={{
              onChange: handleTyped,
              placeholder: project,
              value: typed,
            }}
          />
          <AlertDialogFooter className="pt-1 [&>button]:text-sm">
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={!matches}
              type="submit"
              variant="destructive"
            >
              Удалить проект
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ------------------------------------------------------ Изменить проект */

/** "Изменить" in the project header: name and description. */
export function EditProjectDialog({
  description,
  name,
  onOpenChange,
  onSave,
  open,
}: {
  description: string;
  name: string;
  onOpenChange: (open: boolean) => void;
  onSave: (values: { description: string; name: string }) => void;
  open: boolean;
}) {
  const [invalid, setInvalid] = useState(false);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setInvalid(false);
      onOpenChange(next);
    },
    [onOpenChange]
  );
  const handleInput = useCallback(() => {
    setInvalid(false);
  }, []);
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const nextName = String(data.get("name") ?? "").trim();
      if (!nextName) {
        setInvalid(true);
        return;
      }
      onSave({
        description: String(data.get("description") ?? "").trim(),
        name: nextName,
      });
    },
    [onSave]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="p-7 sm:max-w-[520px]">
        <form className="contents" noValidate onSubmit={handleSubmit}>
          <DialogHeader className="gap-1">
            <DialogTitle>Изменить проект</DialogTitle>
            <DialogDescription className="text-sm">
              Название видно в начале звонка, описание агент берёт в бриф.
            </DialogDescription>
          </DialogHeader>
          <Field invalid={invalid}>
            <FieldLabel className="text-sm font-medium">Название</FieldLabel>
            <Input
              autoComplete="off"
              defaultValue={name}
              name="name"
              onInput={handleInput}
            />
            {invalid ? (
              <FieldError>
                Нужно название, по нему вы выберете проект в начале звонка
              </FieldError>
            ) : null}
          </Field>
          <Field>
            <FieldLabel className="text-sm font-medium">Описание</FieldLabel>
            <Textarea
              className="min-h-24"
              defaultValue={description}
              maxLength={DESCRIPTION_MAX_CHARS}
              name="description"
            />
            <FieldDescription>{DESCRIPTION_LIMIT_HINT}</FieldDescription>
          </Field>
          <DialogFooter className="pt-1 [&>button]:text-sm">
            <DialogClose render={<Button variant="secondary" />}>
              Отмена
            </DialogClose>
            <Button type="submit">Сохранить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
