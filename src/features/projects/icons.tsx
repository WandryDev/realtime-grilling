import type { ComponentProps } from "react";

/*
 * Line icons of the project screens, paths copied from Paper. 16px for rows
 * and dialogs, 14px inside buttons, 12px in small marks; stroke in
 * currentColor. Size them with `size-*` at the call site.
 */

type IconProps = ComponentProps<"svg">;

function Icon({
  children,
  strokeWidth = 1.4,
  viewBox = "0 0 14 14",
  ...props
}: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable={false}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox={viewBox}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 16 16" {...props}>
      <path d="M6 3.5L10.5 8L6 12.5" />
    </Icon>
  );
}

/** Breadcrumb separator in the title bar, 12px. */
export function BreadcrumbChevronIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 12 12" {...props}>
      <path d="M4.5 2.5L8 6L4.5 9.5" />
    </Icon>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12H4.5L11.5 5L9 2.5L2 9.5V12Z" />
    </Icon>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      focusable={false}
      viewBox="0 0 16 16"
      {...props}
    >
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.5 7A4.5 4.5 0 1 1 10.2 3.8M11.5 2V4.5H9" />
    </Icon>
  );
}

export function FolderPlusIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} viewBox="0 0 24 24" {...props}>
      <path d="M4 7.5C4 6.4 4.9 5.5 6 5.5H10L12 7.5H18C19.1 7.5 20 8.4 20 9.5V16.5C20 17.6 19.1 18.5 18 18.5H6C4.9 18.5 4 17.6 4 16.5V7.5Z" />
      <path d="M12 10.5V15.5M9.5 13H14.5" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 16 16" {...props}>
      <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" />
    </Icon>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.3} viewBox="0 0 12 12" {...props}>
      <path d="M4 2.5H9.5V8M9.5 2.5L3 9" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 4V7L9 8.2" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} viewBox="0 0 20 20" {...props}>
      <path d="M4 6H16M8 6V4.5C8 4 8.4 3.5 9 3.5H11C11.6 3.5 12 4 12 4.5V6M5.5 6L6.2 15.5C6.3 16.1 6.8 16.5 7.3 16.5H12.7C13.2 16.5 13.7 16.1 13.8 15.5L14.5 6" />
    </Icon>
  );
}

/** Check of a finished step or task, 12px. */
export function StepCheckIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} viewBox="0 0 12 12" {...props}>
      <path d="M2.5 6.2L5 8.5L9.5 3.5" />
    </Icon>
  );
}

/** Plus inside the dashed tile of the draft project, 10px. */
export function SmallPlusIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 10 10" {...props}>
      <path d="M5 1.5V8.5M1.5 5H8.5" />
    </Icon>
  );
}

/** Two-tone ring of a task the agent is working on, 18px viewBox. */
export function WorkingRingIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable={false}
      strokeLinecap="round"
      strokeWidth={2}
      viewBox="0 0 18 18"
      {...props}
    >
      <circle className="stroke-border" cx="9" cy="9" r="7" />
      <path className="stroke-accent" d="M9 2A7 7 0 0 1 16 9" />
    </svg>
  );
}
