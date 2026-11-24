"use client";

import { Button } from "@grill/ui/button";
import { Checkbox } from "@grill/ui/checkbox";
import {
  ChoiceField,
  ChoiceFieldLabel,
  ChoiceFieldMeta,
} from "@grill/ui/choice-field";
import { Field, FieldLabel } from "@grill/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grill/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grill/ui/select";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useState,
} from "react";
import { SearchIcon } from "@/features/shell/icons";
import { linkButtonProps } from "@/lib/link-button";
import { cn } from "@/lib/utils";
import type { SourceKind } from "../mock";
import { SourceTile } from "./source-mark";

/*
 * Wizard step 2, "Источники": one block per connected integration. The head
 * is a 32px logo tile, the name, how it is connected and "Пропустить"; the
 * pickers sit under it, indented to the text (44px).
 *
 * "Пропустить" folds the block into "Без Outline" with "Вернуть". A service
 * that isn't connected shows "Подключить …" (to `connectHref`) instead of the
 * pickers.
 */
export function SourceBlock({
  children,
  className,
  connectHref,
  connected = true,
  description,
  kind,
  name,
}: {
  children: ReactNode;
  className?: string;
  connectHref?: string;
  connected?: boolean;
  description: ReactNode;
  kind: SourceKind;
  name: string;
}) {
  const [skipped, setSkipped] = useState(false);
  const skip = useCallback(() => setSkipped(true), []);
  const restore = useCallback(() => setSkipped(false), []);

  if (skipped) {
    return (
      <section
        aria-label={name}
        className={cn("flex items-center gap-3", className)}
      >
        <SourceTile className="opacity-50" kind={kind} size="lg" />
        <p className="text-muted-foreground min-w-0 flex-1 text-base">
          Без {name}
        </p>
        <Button
          className="-mx-2 -my-1.5 px-2"
          onClick={restore}
          size="sm"
          variant="ghost"
        >
          Вернуть
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-label={name}
      className={cn("flex flex-col gap-3.5", className)}
    >
      <div className="flex items-center gap-3">
        <SourceTile kind={kind} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-foreground text-base font-semibold">{name}</h2>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {connected ? (
          <Button
            className="-mx-2 -my-1.5 px-2"
            onClick={skip}
            size="sm"
            variant="ghost"
          >
            Пропустить
          </Button>
        ) : null}
      </div>
      <div className="flex gap-3 pl-11">
        {connected ? (
          children
        ) : (
          <Button {...linkButtonProps(connectHref ?? "#")} variant="secondary">
            Подключить {name}
          </Button>
        )}
      </div>
    </section>
  );
}

export interface SourceOption {
  label: string;
  /** Muted size on the right: "48 документов". */
  meta?: string;
  value: string;
}

/** A labelled select of a source: collection, space, list. */
export function SourceSelect({
  className,
  defaultValue,
  label,
  options,
}: {
  className?: string;
  defaultValue: string;
  label: string;
  options: SourceOption[];
}) {
  const selected = options.find((option) => option.value === defaultValue);

  return (
    <Field className={cn("min-w-0 flex-1", className)}>
      <FieldLabel className="text-sm font-medium">{label}</FieldLabel>
      <Select defaultValue={defaultValue} items={options}>
        <SelectTrigger className="gap-2.5 px-3.5">
          <SelectValue />
          {selected?.meta ? (
            <span className="text-muted-foreground ml-auto text-sm">
              {selected.meta}
            </span>
          ) : null}
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export interface RepoOption {
  checked: boolean;
  meta: string;
  name: string;
}

/**
 * GitHub repositories: a search over a list of checkboxes, the counter on
 * the right. `hovered` pins the hover look of one row for the preview. The
 * search filters and the boxes toggle; `repos` and `query` are the start.
 */
export function RepoPicker({
  className,
  hovered,
  query,
  repos,
}: {
  className?: string;
  hovered?: string;
  query?: string;
  repos: RepoOption[];
}) {
  const labelId = useId();
  const [search, setSearch] = useState(query ?? "");
  const [checked, setChecked] = useState(
    () => new Set(repos.filter((repo) => repo.checked).map((repo) => repo.name))
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? repos.filter((repo) => repo.name.toLowerCase().includes(needle))
      : repos;
  }, [repos, search]);

  const handleSearch = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearch(event.target.value);
  }, []);
  const toggle = useCallback((name: string, value: boolean) => {
    setChecked((current) => {
      const next = new Set(current);
      if (value) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  }, []);

  return (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5", className)}>
      <p className="text-foreground text-sm font-medium" id={labelId}>
        Репозитории
      </p>
      <div className="border-input flex flex-col overflow-clip rounded-sm border">
        <InputGroup className="border-border h-11 gap-2.5 rounded-none border-0 border-b px-3.5 not-has-[[aria-invalid=true]]:focus-within:shadow-none">
          <InputGroupAddon>
            <SearchIcon className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Поиск по репозиториям"
            onChange={handleSearch}
            type="search"
            value={search}
          />
          <InputGroupAddon
            align="inline-end"
            className="text-muted-foreground tabular-nums"
          >
            выбрано {checked.size} из {repos.length}
          </InputGroupAddon>
        </InputGroup>
        <fieldset aria-labelledby={labelId} className="flex min-w-0 flex-col">
          {visible.map((repo) => (
            <RepoRow
              checked={checked.has(repo.name)}
              hovered={repo.name === hovered}
              key={repo.name}
              onToggle={toggle}
              repo={repo}
            />
          ))}
          {visible.length === 0 ? (
            <p className="text-muted-foreground flex h-11 items-center px-3.5 text-sm">
              Ничего не нашлось
            </p>
          ) : null}
        </fieldset>
      </div>
    </div>
  );
}

function RepoRow({
  checked,
  hovered,
  onToggle,
  repo,
}: {
  checked: boolean;
  hovered: boolean;
  onToggle: (name: string, checked: boolean) => void;
  repo: RepoOption;
}) {
  const handleChange = useCallback(
    (value: boolean) => onToggle(repo.name, value),
    [onToggle, repo.name]
  );
  return (
    <ChoiceField
      className="hover:bg-surface h-11 gap-3 px-3.5 transition-colors"
      data-preview={hovered ? "hover" : undefined}
    >
      <Checkbox checked={checked} onCheckedChange={handleChange} />
      <ChoiceFieldLabel className="font-mono text-sm">
        {repo.name}
      </ChoiceFieldLabel>
      <ChoiceFieldMeta className="text-xs">{repo.meta}</ChoiceFieldMeta>
    </ChoiceField>
  );
}
