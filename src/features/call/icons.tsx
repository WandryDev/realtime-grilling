import type { ComponentProps } from "react";

/*
 * Line icons of the call window, paths from the Paper page "Звонок". Stroke
 * in currentColor; size them with `size-*` at the call site.
 */

type IconProps = ComponentProps<"svg">;

function Icon({
  children,
  strokeWidth = 1.5,
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

export function CheckIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.6} viewBox="0 0 14 14" {...props}>
      <path d="M3 7.5L5.8 10L11 4" />
    </Icon>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 2.5L13.5 6.5M10.8 3.8L7.4 6.2L4.5 6.6L9.4 11.5L9.8 8.6L12.2 5.2M6.9 9.1L3 13" />
    </Icon>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 8C3.8 5.6 5.7 4.3 8 4.3C10.3 4.3 12.2 5.6 13.5 8C12.2 10.4 10.3 11.7 8 11.7C5.7 11.7 3.8 10.4 2.5 8Z" />
      <path d="M3 13L13 3" />
    </Icon>
  );
}

/** Opens the collapsed transcript rail. */
export function PanelExpandIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} {...props}>
      <rect height="10" rx="2.5" width="11" x="2.5" y="3" />
      <path d="M6.5 3V13" />
      <path d="M9 6.5L10.5 8L9 9.5" />
    </Icon>
  );
}

export function FlagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 14V2.5M3.5 3H11.5L9.8 5.8L11.5 8.6H3.5" />
    </Icon>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 18 18" {...props}>
      <rect height="8.5" rx="2.5" width="5" x="6.5" y="2.5" />
      <path d="M4 8.5C4 11.3 6.2 13.5 9 13.5C11.8 13.5 14 11.3 14 8.5M9 13.5V16" />
      <path d="M3 2.5L15 15.5" />
    </Icon>
  );
}

export function SpeakerOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 6H5L8.5 3V13L5 10H2.5V6Z" />
      <path d="M11 6L14 10M14 6L11 10" />
    </Icon>
  );
}
