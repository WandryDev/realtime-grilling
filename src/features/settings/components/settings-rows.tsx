"use client";

import { type ComponentProps, type ReactNode, useCallback } from "react";

import { ChoiceField } from "@/components/ui/choice-field";
import { Progress, type ProgressTone } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingRow,
  SettingRowContent,
  SettingRowControl,
  SettingRowDescription,
  SettingRowTitle,
} from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import type {
  BooleanSettingKey,
  SettingChange,
  StringSettingKey,
} from "@/data/settings";
import { cn } from "@/lib/utils";

import type { SelectOption } from "../mock";

/*
 * Controls bound to a preference: with `onSettingChange` the control is
 * controlled by `value` and writes `setting`; without it (the /dev/screens
 * previews) `value` is only the starting value and the control stays free.
 */
interface SettingBinding<K, V> {
  onSettingChange?: SettingChange;
  setting?: K;
  value: V;
}

function useBoundValue<K extends StringSettingKey | BooleanSettingKey, V>({
  onSettingChange,
  setting,
  value,
}: SettingBinding<K, V>) {
  const onValueChange = useCallback(
    (next: V) => {
      if (setting && onSettingChange) {
        onSettingChange(setting, next as never);
      }
    },
    [onSettingChange, setting]
  );
  const bound = Boolean(setting && onSettingChange);
  return {
    defaultValue: value,
    onValueChange: bound ? onValueChange : undefined,
    value: bound ? value : undefined,
  };
}

/*
 * Building blocks of a settings page: a titled group of rows, the row itself
 * and the controls the rows share (select, segments, level meter).
 */

/*
 * Group of rows under a muted 13px title, with an optional action right.
 * No lines: rows sit 28px apart, sections further (pt-12, the caller).
 */
export function SettingsSection({
  action,
  children,
  className,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col", className)}>
      {title ? (
        <div className="flex items-center justify-between gap-4 pb-4">
          <h2 className="text-muted-foreground text-sm font-medium">{title}</h2>
          {action}
        </div>
      ) : null}
      <div className="flex flex-col gap-7">{children}</div>
    </section>
  );
}

/*
 * Title and description left, the control right (under them when the row
 * is too narrow for both, see SettingRow); the section spaces the rows. `align="start"` for tall controls (select with a meter under it): the
 * text lines up with the 40px field. `children` go under the row at full
 * width (the folder path), 12px below.
 */
export function SettingsRow({
  align = "center",
  children,
  className,
  control,
  description,
  htmlFor,
  title,
}: {
  align?: "center" | "start";
  children?: ReactNode;
  className?: string;
  control?: ReactNode;
  description?: ReactNode;
  /** Id of the control, so the title toggles or focuses it. */
  htmlFor?: string;
  title: ReactNode;
}) {
  const content = (
    <>
      <SettingRowContent className={cn(align === "start" && "pt-2.5")}>
        <SettingRowTitle htmlFor={htmlFor}>{title}</SettingRowTitle>
        {description ? (
          <SettingRowDescription>{description}</SettingRowDescription>
        ) : null}
      </SettingRowContent>
      {control ? <SettingRowControl>{control}</SettingRowControl> : null}
    </>
  );

  if (children) {
    return (
      <SettingRow className={cn("flex-col items-stretch gap-3", className)}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {content}
        </div>
        {children}
      </SettingRow>
    );
  }

  return (
    <SettingRow
      className={cn("gap-x-6", align === "start" && "items-start", className)}
    >
      {content}
    </SettingRow>
  );
}

/** Select with its options, 200 wide by default. */
export function SettingsSelect({
  className,
  defaultValue,
  disabled,
  id,
  invalid,
  label,
  onSettingChange,
  onValueChange,
  options,
  setting,
  valueClassName,
}: {
  className?: string;
  /** Starting value; the bound preference's value when `setting` is set. */
  defaultValue: string;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  /** Accessible name when there is no label pointing at `id`. */
  label?: string;
  onSettingChange?: SettingChange;
  /** Called with the picked value, for selects not bound to a preference. */
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  setting?: StringSettingKey;
  valueClassName?: string;
}) {
  const bound = useBoundValue({
    onSettingChange,
    setting,
    value: defaultValue,
  });
  const handleValueChange = useCallback(
    (next: string | null) => {
      if (next === null) {
        return;
      }
      bound.onValueChange?.(next);
      onValueChange?.(next);
    },
    [bound.onValueChange, onValueChange]
  );
  return (
    <Select
      defaultValue={bound.value === undefined ? defaultValue : undefined}
      disabled={disabled}
      items={options}
      onValueChange={handleValueChange}
      value={bound.value}
    >
      <SelectTrigger
        aria-invalid={invalid || undefined}
        aria-label={label}
        className={cn(
          "aria-invalid:border-contradiction w-50 aria-invalid:shadow-none",
          className
        )}
        id={id}
      >
        <SelectValue className={valueClassName} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Segmented control of the rows: 10px segment padding, unavailable ones subtle. */
export function SettingsSegments({
  className,
  defaultValue,
  itemClassName,
  label,
  onSettingChange,
  options,
  setting,
}: {
  className?: string;
  /** Starting value; the bound preference's value when `setting` is set. */
  defaultValue: string;
  /** Fixed width for numeric segments. */
  itemClassName?: string;
  label: string;
  onSettingChange?: SettingChange;
  options: (SelectOption & { disabled?: boolean })[];
  setting?: StringSettingKey;
}) {
  const bound = useBoundValue({
    onSettingChange,
    setting,
    value: defaultValue,
  });
  return (
    <SegmentedControl
      aria-label={label}
      className={className}
      defaultValue={bound.value === undefined ? defaultValue : undefined}
      onValueChange={bound.onValueChange}
      value={bound.value}
    >
      {options.map((option) => (
        <SegmentedControlItem
          className={cn(
            "data-disabled:text-subtle px-2.5 group-not-data-disabled/segmented-control:data-disabled:opacity-100",
            itemClassName
          )}
          disabled={option.disabled}
          key={option.value}
          value={option.value}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/*
 * Live input level under a device select: a 4px bar on the hairline gray and
 * a 64px caption on the right. Orange while there is signal, gray on silence.
 */
export function LevelMeter({
  caption,
  className,
  label,
  value,
}: {
  caption: string;
  className?: string;
  label: string;
  value: number;
}) {
  const tone: ProgressTone = value > 5 ? "active" : "paused";
  return (
    <div className={cn("flex items-center gap-2.5 px-0.5", className)}>
      <Progress
        aria-label={label}
        className="[&_[data-slot=progress-track]]:bg-border flex-1"
        locale="ru-RU"
        size="sm"
        tone={tone}
        value={value}
      />
      <span className="text-muted-foreground min-w-16 shrink-0 text-right text-xs whitespace-nowrap">
        {caption}
      </span>
    </div>
  );
}

/** Gray rounded field with a path or a value to read and copy. */
export function ReadonlyField({
  className,
  icon,
  ...props
}: ComponentProps<"p"> & { icon?: ReactNode }) {
  return (
    <div
      className={cn(
        "bg-surface flex h-10 items-center gap-2.5 rounded-sm px-3 [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
    >
      {icon ? <span className="text-muted-foreground flex">{icon}</span> : null}
      <p className="min-w-0 truncate font-mono text-sm select-all" {...props} />
    </div>
  );
}

/** Switch of a row, bound to a boolean preference like the selects. */
export function SettingsSwitch({
  checked,
  id,
  onSettingChange,
  setting,
}: {
  checked: boolean;
  id: string;
  onSettingChange?: SettingChange;
  setting?: BooleanSettingKey;
}) {
  const bound = useBoundValue({ onSettingChange, setting, value: checked });
  return (
    <Switch
      checked={bound.value}
      defaultChecked={bound.value === undefined ? checked : undefined}
      id={id}
      onCheckedChange={bound.onValueChange}
    />
  );
}

/** Radio list of a section: rows 28px apart, like the other rows. */
export function SettingsRadioGroup({
  className,
  defaultValue,
  onSettingChange,
  setting,
  ...props
}: Omit<ComponentProps<typeof RadioGroup>, "defaultValue" | "value"> & {
  defaultValue: string;
  onSettingChange?: SettingChange;
  setting?: StringSettingKey;
}) {
  const bound = useBoundValue({
    onSettingChange,
    setting,
    value: defaultValue,
  });
  return (
    <RadioGroup
      className={cn("gap-7", className)}
      defaultValue={bound.value === undefined ? defaultValue : undefined}
      onValueChange={
        bound.onValueChange as ((value: unknown) => void) | undefined
      }
      value={bound.value}
      {...props}
    />
  );
}

/*
 * One option of a SettingsRadioGroup: radio, title with an optional badge,
 * description. `trailing` (size, action) sits outside the clickable label.
 */
export function SettingsRadioRow({
  align = "start",
  badge,
  className,
  description,
  disabled,
  title,
  trailing,
  value,
}: {
  /** "center" puts the radio in the middle of a two-line row. */
  align?: "start" | "center";
  badge?: ReactNode;
  className?: string;
  description?: ReactNode;
  /** Not selectable (a model that is not downloaded yet). */
  disabled?: boolean;
  title: ReactNode;
  trailing?: ReactNode;
  value: string;
}) {
  return (
    <div
      className={cn("flex items-center gap-3.5", className)}
      data-slot="settings-radio-row"
    >
      <ChoiceField
        className={cn(
          "min-w-0 flex-1 gap-3.5",
          align === "start" ? "items-start" : "items-center"
        )}
      >
        <RadioGroupItem
          className={cn(align === "start" && "mt-px")}
          disabled={disabled}
          value={value}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="font-medium">{title}</span>
            {badge}
          </span>
          {description ? (
            <span className="text-muted-foreground text-sm">{description}</span>
          ) : null}
        </span>
      </ChoiceField>
      {trailing}
    </div>
  );
}
