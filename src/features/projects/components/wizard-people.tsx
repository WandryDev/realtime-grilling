"use client";

import {
  type FormEvent,
  type MouseEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

import { CloseIcon } from "../icons";
import { PersonAvatar } from "./person-card";

/*
 * Wizard step 3, "Люди клиента": the added people (avatar, name, role, the
 * tech tag and a cross) and the quick add form on gray.
 */
export function PersonLine({
  className,
  initials,
  name,
  onRemove,
  role,
  tag,
}: {
  className?: string;
  initials: string;
  name: string;
  /** The cross; the person's name is in `data-name`. */
  onRemove?: (event: MouseEvent<HTMLButtonElement>) => void;
  role: string;
  tag: string;
}) {
  return (
    <Item className={cn("px-0", className)} variant="plain">
      <ItemMedia>
        <PersonAvatar initials={initials} />
      </ItemMedia>
      <ItemContent className="gap-0.5">
        <ItemTitle className="text-[15px]/[22px]">{name}</ItemTitle>
        <ItemDescription>{role}</ItemDescription>
      </ItemContent>
      <Badge className="text-xs" variant="neutral">
        {tag}
      </Badge>
      <Button
        aria-label={`Убрать ${name}`}
        className="text-subtle -mx-1.5"
        data-name={name}
        onClick={onRemove}
        size="icon-sm"
        variant="ghost"
      >
        <CloseIcon className="size-4" />
      </Button>
    </Item>
  );
}

export interface QuickPerson {
  level: string;
  name: string;
  role: string;
}

/**
 * Name, role and the tech level. Enter in any field adds the person, then
 * the form clears and the focus goes back to "Имя".
 */
export function QuickAddPerson({
  className,
  defaultName,
  levels,
  level,
  onAdd,
}: {
  className?: string;
  defaultName?: string;
  level: string;
  levels: { label: string; value: string }[];
  onAdd?: (person: QuickPerson) => void;
}) {
  const titleId = useId();
  const techId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [currentLevel, setCurrentLevel] = useState(level);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const name = String(data.get("name") ?? "").trim();
      if (!name) {
        nameRef.current?.focus();
        return;
      }
      onAdd?.({
        level: currentLevel,
        name,
        role: String(data.get("role") ?? "").trim(),
      });
      form.reset();
      nameRef.current?.focus();
    },
    [currentLevel, onAdd]
  );

  return (
    <form
      aria-labelledby={titleId}
      className={cn(
        "bg-surface flex flex-col gap-3.5 rounded-md p-5",
        className
      )}
      onSubmit={handleSubmit}
    >
      <h2 className="text-foreground text-sm font-medium" id={titleId}>
        Добавить человека
      </h2>
      <div className="flex gap-2.5">
        <Input
          aria-label="Имя"
          autoComplete="off"
          data-preview={defaultName ? "focus" : undefined}
          defaultValue={defaultName}
          name="name"
          placeholder="Имя и фамилия"
          ref={nameRef}
        />
        <Input
          aria-label="Роль в компании"
          autoComplete="off"
          name="role"
          placeholder="Роль в компании"
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="text-muted-foreground text-sm" id={techId}>
            В технике
          </span>
          <SegmentedControl
            aria-labelledby={techId}
            className="bg-background ring-border ring-1"
            onValueChange={setCurrentLevel}
            value={currentLevel}
          >
            {levels.map((option) => (
              <SegmentedControlItem
                className="data-pressed:bg-foreground data-pressed:text-on-ink h-7 font-normal data-pressed:shadow-none"
                key={option.value}
                value={option.value}
              >
                {option.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        <Button
          className="bg-background shadow-touch hover:bg-background h-[34px] px-3.5"
          type="submit"
          variant="secondary"
        >
          Добавить
          <span
            aria-hidden="true"
            className="text-muted-foreground font-mono text-xs font-normal"
          >
            ⏎
          </span>
        </Button>
      </div>
    </form>
  );
}
