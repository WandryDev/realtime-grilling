import type { ComponentProps } from "react";

/*
 * Line icons from the onboarding artboards in Paper. 16px icons (feature
 * list, permission and model tiles) use a 1.4 stroke, 14px ones inside
 * controls and hints use 1.5. All draw in currentColor: color and size them
 * at the call site.
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

export function MicrophoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="8" rx="2.5" width="5" x="5.5" y="1.75" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </Icon>
  );
}

export function QuestionCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.3 6.4c0-1 .8-1.6 1.7-1.6s1.7.6 1.7 1.5c0 1.1-1.7 1.2-1.7 2.4" />
      <circle cx="8" cy="11.2" fill="currentColor" r="0.8" stroke="none" />
    </Icon>
  );
}

export function NotesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 2.75h9v10.5h-9z" />
      <path d="M5.75 6h4.5M5.75 8.5h4.5M5.75 11h2.5" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="7" rx="2" width="10" x="3" y="7" />
      <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" />
    </Icon>
  );
}

/** Monitor with a sound wave: screen and system audio recording. */
export function ScreenAudioIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="8.5" rx="1.75" width="12.5" x="1.75" y="2.5" />
      <path d="M5.5 13.75h5M8 11v2.75" />
      <path d="M6.5 5.5v2.5M8 4.75v4M9.5 5.5v2.5" />
    </Icon>
  );
}

export function SpeakerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 6h2.25L8 3.25v9.5L4.75 10H2.5z" />
      <path d="M10.5 5.75a3 3 0 0 1 0 4.5M12.25 4a5.5 5.5 0 0 1 0 8" />
    </Icon>
  );
}

export function WaveformIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 8h1.5M4.75 5v6M7.25 3v10M9.75 5.5v5M12.25 7v2M14 8h0" />
    </Icon>
  );
}

export function DiskIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="9" rx="2" width="12" x="2" y="3.5" />
      <path d="M2 9.5h12" />
      <circle cx="11.5" cy="11" fill="currentColor" r="0.75" stroke="none" />
    </Icon>
  );
}

export function WifiOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.75 6a9 9 0 0 1 12.5 0M4 8.5a5.75 5.75 0 0 1 8 0M6.25 11a2.5 2.5 0 0 1 3.5 0" />
      <path d="M2.5 2.5l11 11" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.6} viewBox="0 0 14 14" {...props}>
      <path d="M3 7.3l2.6 2.5L11 4.4" />
    </Icon>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.6} viewBox="0 0 14 14" {...props}>
      <path d="M4 4l6 6M10 4l-6 6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} viewBox="0 0 14 14" {...props}>
      <path d="M8.5 3.5L5 7l3.5 3.5" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} viewBox="0 0 14 14" {...props}>
      <path d="M7 2v7M4 6.5L7 9.5l3-3M2.5 12h9" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.5} viewBox="0 0 14 14" {...props}>
      <circle cx="7" cy="7" r="5.25" />
      <path d="M7 6.25v3.25" />
      <circle cx="7" cy="4.4" fill="currentColor" r="0.7" stroke="none" />
    </Icon>
  );
}

/** Two opposite arrows: "can be changed later". */
export function SwapIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.3} viewBox="0 0 14 14" {...props}>
      <path d="M2.5 5h8l-2-2M11.5 9h-8l2 2" />
    </Icon>
  );
}

/** Arrow out of the window: the action opens the browser. */
export function ExternalArrowIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.3} viewBox="0 0 12 12" {...props}>
      <path d="M4 2.5h5.5V8M9.5 2.5L3 9" />
    </Icon>
  );
}

/** Dashed circle: a check that hasn't started yet. */
export function PendingCircleIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} viewBox="0 0 14 14" {...props}>
      <circle
        cx="7"
        cy="7"
        r="5"
        strokeDasharray="2 2.2"
        strokeLinecap="butt"
      />
    </Icon>
  );
}
