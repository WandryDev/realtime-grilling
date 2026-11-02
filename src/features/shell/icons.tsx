import type { ComponentProps } from "react";

/*
 * Line icons from the Paper file: 16px for navigation, 14px inside controls,
 * 1.4 stroke in currentColor. Size them with `size-*` at the call site.
 */

type IconProps = ComponentProps<"svg">;

function Icon({ children, viewBox = "0 0 16 16", ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable={false}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.4}
      viewBox={viewBox}
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.8 7L8 2.8L13.2 7V13H9.8V9.8H6.2V13H2.8V7Z" />
    </Icon>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5V8L10 9.4" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 4.5H9M12 4.5H13.5M2.5 11.5H4.5M7.5 11.5H13.5" />
      <circle cx="10.5" cy="4.5" r="1.5" />
      <circle cx="6" cy="11.5" r="1.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 14 14" {...props}>
      <path d="M7 2.5V11.5M2.5 7H11.5" />
    </Icon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 14 14" {...props}>
      <rect height="7" rx="2.2" width="4.4" x="4.8" y="1.6" />
      <path d="M2.8 6.6C2.8 8.9 4.7 10.8 7 10.8C9.3 10.8 11.2 8.9 11.2 6.6M7 10.8V12.6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 3.5L5.5 8L10 12.5" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 14 14" {...props}>
      <circle cx="6.2" cy="6.2" r="4.2" />
      <path d="M9.4 9.4L12 12" />
    </Icon>
  );
}
