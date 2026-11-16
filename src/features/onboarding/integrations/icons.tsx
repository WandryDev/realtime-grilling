import type { ComponentProps } from "react";

/*
 * 14px line icons of the integration steps that the shared onboarding set
 * (components/icons) doesn't have. Paths from Paper, stroke currentColor;
 * size them with `size-*` at the call site.
 */

type IconProps = ComponentProps<"svg">;

function Icon({ children, strokeWidth = 1.5, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable={false}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 14 14"
      {...props}
    >
      {children}
    </svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.3} {...props}>
      <rect height="7" rx="1.5" width="7" x="4.5" y="4.5" />
      <path d="M9.5 4.5V3.5A1 1 0 0 0 8.5 2.5h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
    </Icon>
  );
}

/** Question in a circle: where to find the key. */
export function HelpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="5.75" />
      <path d="M5.4 5.5a1.6 1.6 0 0 1 3.1.5c0 1-1.5 1.3-1.5 2.2" />
      <circle cx="7" cy="10.1" fill="currentColor" r="0.8" stroke="none" />
    </Icon>
  );
}

/** Microphone of the setup summary. */
export function MicSmallIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} {...props}>
      <rect height="6.5" rx="2" width="4" x="5" y="1.75" />
      <path d="M3 6.75a4 4 0 0 0 8 0M7 10.75v1.75" />
    </Icon>
  );
}

/** Speech recognition in the setup summary. */
export function SpeechBarsIcon(props: IconProps) {
  return (
    <Icon strokeWidth={1.4} {...props}>
      <path d="M2 6v2M4.75 4v6M7.5 2.5v9M10.25 4.5v5M13 6.25v1.5" />
    </Icon>
  );
}
