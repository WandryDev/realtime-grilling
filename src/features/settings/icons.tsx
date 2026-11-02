import type { ComponentProps } from "react";

/*
 * Line icons of the settings screens, paths from the Paper file. 16px for
 * navigation and rows, 14px inside buttons, 1.4 stroke in currentColor. Size
 * them with `size-*` at the call site. The sliders icon of "Общие" is the
 * shell's SettingsIcon.
 */

type IconProps = ComponentProps<"svg">;

function Icon({
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

export function BackIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} {...props}>
      <path d="M9.5 3.5L5 8L9.5 12.5" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5L10.5 8L6 12.5" />
    </Icon>
  );
}

export function SoundIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="7.4" rx="2.2" width="4.4" x="5.8" y="2" />
      <path d="M3.6 7.6C3.6 10 5.6 12 8 12C10.4 12 12.4 10 12.4 7.6M8 12V14" />
    </Icon>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="10.4" rx="2.4" width="12.4" x="1.8" y="2.8" />
      <path d="M4.8 6.2L6.8 8L4.8 9.8M8.6 10H11.2" />
    </Icon>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="8" rx="2" width="12.4" x="1.8" y="4" />
      <path d="M4.5 7H5.5M7.5 7H8.5M10.5 7H11.5M5.5 9.5H10.5" />
    </Icon>
  );
}

export function IntegrationsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="5" r="2.2" />
      <circle cx="11" cy="11" r="2.2" />
      <path d="M7 5H9.5C10.3 5 11 5.7 11 6.5V8.8M9 11H6.5C5.7 11 5 10.3 5 9.5V7.2" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="7" rx="2" width="10" x="3" y="7" />
      <path d="M5.3 7V5.2C5.3 3.7 6.5 2.5 8 2.5C9.5 2.5 10.7 3.7 10.7 5.2V7" />
    </Icon>
  );
}

/** 12px lock of the "Только чтение" chip. */
export function SmallLockIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 12 12" {...props}>
      <rect height="5" rx="1.2" width="7" x="2.5" y="5.2" />
      <path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 4.6C2 3.7 2.7 3 3.6 3H6.2L7.6 4.6H12.4C13.3 4.6 14 5.3 14 6.2V11.4C14 12.3 13.3 13 12.4 13H3.6C2.7 13 2 12.3 2 11.4V4.6Z" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 14 14" {...props}>
      <path d="M4.5 3.2V10.8L10.8 7L4.5 3.2Z" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 14 14" {...props}>
      <path d="M11.5 7A4.5 4.5 0 1 1 9.8 3.5M11.5 2V4.8H8.7" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 14 14" {...props}>
      <path d="M7 2.5V9M4.3 6.4L7 9L9.7 6.4M3 11.5H11" />
    </Icon>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 14 14" {...props}>
      <path d="M7 9V2.5M4.3 5.1L7 2.5L9.7 5.1M3 11.5H11" />
    </Icon>
  );
}

/** 16px check of lists and toasts. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.6} {...props}>
      <path d="M3.5 8.2L6.5 11L12.5 5" />
    </Icon>
  );
}

/** 14px check before "Подключено". */
export function SmallCheckIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.6} viewBox="0 0 14 14" {...props}>
      <path d="M3 7.3l2.6 2.5L11 4.4" />
    </Icon>
  );
}

/** 18px crossed-out microphone of the "микрофон отключён" banner. */
export function MicOffIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} viewBox="0 0 18 18" {...props}>
      <rect height="8.2" rx="2.4" width="4.8" x="6.6" y="2" />
      <path d="M4 8.6C4 11.4 6.2 13.6 9 13.6C11.8 13.6 14 11.4 14 8.6M9 13.6V16M3 3L15 15" />
    </Icon>
  );
}
