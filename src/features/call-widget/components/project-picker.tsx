"use client";

import { useCallback, useState } from "react";

import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectAction,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  selectItemClassName,
  selectPopupClassName,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { CheckIcon, SearchIcon } from "../icons";
import type { PickerProject } from "../mock";
import { StatusDot } from "./status-dot";

const NO_PROJECT_LABEL = "Звонок без проекта";

/* Two-line option: 44px high, name over "who and when". */
const optionClassName = "h-11 gap-2.5";

/** Option body: dot, name and detail. The check slot is added by the menu. */
function ProjectOptionText({ project }: { project: PickerProject }) {
  return (
    <>
      <StatusDot className="mx-0.5 mt-2.5 self-start" tone="ink" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{project.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {project.detail}
        </span>
      </span>
    </>
  );
}

/** "Звонок без проекта", its text aligned with the project names. */
function NoProjectLabel() {
  return (
    <>
      <span aria-hidden="true" className="w-3 shrink-0" />
      {NO_PROJECT_LABEL}
    </>
  );
}

/*
 * The open project list, drawn in place for previews: search, the projects
 * with the chosen one highlighted and checked, and "Звонок без проекта".
 * A live popup would portal over the page and take focus on load. Same
 * classes as SelectContent and SelectItem.
 */
export function ProjectPickerMenu({
  className,
  projects,
  selectedId,
}: {
  className?: string;
  projects: PickerProject[];
  selectedId?: string;
}) {
  return (
    <div
      className={cn(selectPopupClassName, "flex flex-col gap-0.5", className)}
      inert
    >
      <div className="flex h-9 shrink-0 items-center gap-2 px-2.5">
        <SearchIcon className="text-subtle size-3.5 shrink-0" />
        <input
          aria-label="Найти проект"
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none"
          placeholder="Найти проект"
          type="search"
        />
      </div>
      <div className="bg-border h-px shrink-0" />
      {projects.map((project) => {
        const selected = project.id === selectedId;
        return (
          <div
            className={cn(selectItemClassName, optionClassName)}
            data-highlighted={selected ? "" : undefined}
            key={project.id}
          >
            <ProjectOptionText project={project} />
            <span className="flex size-4 shrink-0 items-center justify-center">
              {selected ? <CheckIcon className="size-3.5" /> : null}
            </span>
          </div>
        );
      })}
      <div className="bg-border h-px shrink-0" />
      <div
        className={cn(
          selectItemClassName,
          "text-muted-foreground h-10 gap-2.5"
        )}
      >
        <NoProjectLabel />
      </div>
    </div>
  );
}

/*
 * "Проект" field of the start widget: a 40px select with the project dot,
 * its name and when the last call was. `open` pins the open look for
 * previews (ink border, halo, chevron up) and draws the list under it.
 * With `onValueChange` the field is controlled: picking a project or
 * "Звонок без проекта" (null) reports the new value.
 */
export function ProjectField({
  className,
  onValueChange,
  open = false,
  projects,
  value,
}: {
  className?: string;
  onValueChange?: (projectId: string | null) => void;
  open?: boolean;
  projects: PickerProject[];
  /** null: a call without a project. */
  value: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const controlled = onValueChange !== undefined;
  const items = Object.fromEntries(
    projects.map((project) => [project.id, project.name])
  );
  const lastCall = projects.find((project) => project.id === value)?.lastCall;

  const handleValueChange = useCallback(
    (next: string | null) => onValueChange?.(next),
    [onValueChange]
  );
  const chooseNoProject = useCallback(() => {
    onValueChange?.(null);
    setMenuOpen(false);
  }, [onValueChange]);

  return (
    <Field className={cn("gap-1.5", className)}>
      <FieldLabel className="text-muted-foreground">Проект</FieldLabel>
      <div className="relative">
        <Select
          defaultValue={controlled ? undefined : value}
          items={items}
          onOpenChange={setMenuOpen}
          onValueChange={controlled ? handleValueChange : undefined}
          open={menuOpen}
          value={controlled ? value : undefined}
        >
          <SelectTrigger
            className="gap-2.5 [&_svg]:size-3.5"
            data-popup-open={open ? "" : undefined}
          >
            {value === null ? null : <StatusDot tone="ink" />}
            <SelectValue
              className="font-medium"
              placeholder={NO_PROJECT_LABEL}
            />
            {lastCall ? (
              <span className="text-muted-foreground text-sm">{lastCall}</span>
            ) : null}
          </SelectTrigger>
          <SelectContent
            className="gap-0.5"
            footer={
              <SelectAction className="h-10 gap-2.5" onClick={chooseNoProject}>
                <NoProjectLabel />
              </SelectAction>
            }
          >
            {projects.map((project) => (
              <SelectItem
                className={optionClassName}
                key={project.id}
                label={project.name}
                value={project.id}
              >
                <ProjectOptionText project={project} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {open ? (
          <ProjectPickerMenu
            className="absolute inset-x-0 top-full z-10 mt-1.5"
            projects={projects}
            selectedId={value ?? undefined}
          />
        ) : null}
      </div>
    </Field>
  );
}
