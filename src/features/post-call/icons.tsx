import type { ComponentProps } from "react";

/*
 * Icons of the after-call screens, paths copied from the Paper file. Stroke
 * icons use currentColor; size them with `size-*` at the call site.
 */

type IconProps = ComponentProps<"svg">;

function StrokeIcon({
  children,
  strokeWidth = 1.4,
  viewBox = "0 0 16 16",
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

export function LockIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.5} {...props}>
      <rect height="7" rx="2" width="10" x="3" y="7" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </StrokeIcon>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <rect height="10" rx="2.5" width="11" x="2.5" y="3.5" />
      <path d="M2.5 6.5H13.5M5.5 2V4.5M10.5 2V4.5" />
    </StrokeIcon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5V8L10 9.5" />
    </StrokeIcon>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.75 13c.5-2.2 2.2-3.5 4.25-3.5s3.75 1.3 4.25 3.5" />
      <path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.2.5 2 1.6 2.25 3.2" />
    </StrokeIcon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <StrokeIcon viewBox="0 0 12 12" {...props}>
      <path d="M4.5 2.5L8 6L4.5 9.5" />
    </StrokeIcon>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <StrokeIcon viewBox="0 0 12 12" {...props}>
      <path d="M3 7.5L6 4.5L9 7.5" />
    </StrokeIcon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <StrokeIcon viewBox="0 0 12 12" {...props}>
      <path d="M3 4.5L6 7.5L9 4.5" />
    </StrokeIcon>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <StrokeIcon {...props}>
      <path d="M4 2.5h5.5L12.5 5.5v8H4z" />
      <path d="M6 8.5h4.5M6 11h3" />
    </StrokeIcon>
  );
}

/** Speech balloon: the source is something said on the call. */
export function SpeechIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.5} {...props}>
      <path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" />
    </StrokeIcon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.5} viewBox="0 0 12 12" {...props}>
      <path d="M2.5 6H9.5M6.5 3L9.5 6L6.5 9" />
    </StrokeIcon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.6} viewBox="0 0 14 14" {...props}>
      <path d="M3 7.5L5.8 10L11 4" />
    </StrokeIcon>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.6} viewBox="0 0 14 14" {...props}>
      <path d="M4 4L10 10M10 4L4 10" />
    </StrokeIcon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.5} {...props}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </StrokeIcon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.5} {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L13.5 13.5" />
    </StrokeIcon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <StrokeIcon strokeWidth={1.6} viewBox="0 0 24 24" {...props}>
      <rect height="11" rx="3" width="6" x="9" y="3.5" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </StrokeIcon>
  );
}

/** Small filled triangle of "Послушать". */
export function PlaySmallIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      focusable={false}
      viewBox="0 0 12 12"
      {...props}
    >
      <path d="M3.5 2.5L9.5 6L3.5 9.5Z" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      focusable={false}
      stroke="currentColor"
      strokeLinejoin="round"
      viewBox="0 0 14 14"
      {...props}
    >
      <path d="M4.5 2.8L11 7L4.5 11.2Z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      focusable={false}
      viewBox="0 0 14 14"
      {...props}
    >
      <rect height="9" rx="1" width="2.6" x="3" y="2.5" />
      <rect height="9" rx="1" width="2.6" x="8.4" y="2.5" />
    </svg>
  );
}
