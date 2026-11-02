import type { ComponentProps } from "react";

/*
 * Line icons of the floating widgets, paths copied from the Paper file
 * ("Звонок"). 14px inside controls, stroke in currentColor. Size them with
 * `size-*` at the call site.
 */

type IconProps = ComponentProps<"svg">;

function Icon({
  children,
  strokeWidth = 1.5,
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

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" />
    </Icon>
  );
}

/** The wider cross in the start widget header. */
export function DismissIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3L11 11M11 3L3 11" />
    </Icon>
  );
}

/** "−" in the widget header, drawn on a 20px grid. */
export function MinimizeIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 20 20" {...props}>
      <path d="M6 10H14" />
    </Icon>
  );
}

/** "−" in the overlay header, 14px grid. */
export function CollapseIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} {...props}>
      <path d="M3.5 7H10.5" />
    </Icon>
  );
}

/** Diagonal arrows: open the call window. */
export function ExpandIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} {...props}>
      <path d="M8.5 2.5H11.5V5.5M5.5 11.5H2.5V8.5M11.5 2.5L8 6M2.5 11.5L6 8" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 5.5L7 8.5L10 5.5" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7.5L5.8 10L11 4" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6.2" cy="6.2" r="4.2" />
      <path d="M9.3 9.3L12 12" />
    </Icon>
  );
}

/** Chip remove and add marks, 12px grid. */
export function SmallCloseIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} viewBox="0 0 12 12" {...props}>
      <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" />
    </Icon>
  );
}

export function SmallPlusIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} viewBox="0 0 12 12" {...props}>
      <path d="M6 2.5V9.5M2.5 6H9.5" />
    </Icon>
  );
}

/** Final check flag, 16px grid. */
export function FlagIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 16 16" {...props}>
      <path d="M3.5 14V2.5M3.5 3H11.5L9.8 5.8L11.5 8.6H3.5" />
    </Icon>
  );
}

/** Crossed eye: the overlay is hidden from screen sharing. 16px grid. */
export function EyeOffIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 16 16" {...props}>
      <path d="M2.5 8C3.8 5.6 5.7 4.3 8 4.3C10.3 4.3 12.2 5.6 13.5 8C12.2 10.4 10.3 11.7 8 11.7C5.7 11.7 3.8 10.4 2.5 8Z" />
      <path d="M3 13L13 3" />
    </Icon>
  );
}
