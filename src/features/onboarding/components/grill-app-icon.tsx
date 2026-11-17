import { type ComponentProps, useId } from "react";

import { cn } from "@/lib/utils";

/*
 * The Grill app icon: the drawing of `src-tauri/app-icon.svg` without its
 * margins, shadow and glow. A charcoal tile with three grill sear marks, the
 * third one still hot. It is the app's own icon, so its colours are fixed and
 * do not follow the theme. Change the two together.
 */
const CHARCOAL = "#151413";
const ASH = "#f1ece4";
const EMBER = "#f58827";

const NOT_ID_SAFE = /[^a-zA-Z0-9]/gu;

export function GrillAppIcon({ className, ...props }: ComponentProps<"svg">) {
  const shineId = `grill-icon-shine-${useId().replace(NOT_ID_SAFE, "")}`;

  return (
    <svg
      aria-hidden="true"
      className={cn("size-14 shrink-0", className)}
      focusable={false}
      viewBox="100 100 824 824"
      {...props}
    >
      <defs>
        <linearGradient id={shineId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.13" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.02" />
          <stop offset="1" stopColor="#000" stopOpacity="0.1" />
        </linearGradient>
      </defs>
      <rect fill={CHARCOAL} height="824" rx="185" width="824" x="100" y="100" />
      <rect
        fill={`url(#${shineId})`}
        height="824"
        rx="185"
        width="824"
        x="100"
        y="100"
      />
      {/* A one-pixel inner edge: it keeps the tile apart from a dark window. */}
      <rect
        fill="none"
        height="810"
        rx="178"
        stroke="#fff"
        strokeOpacity="0.12"
        vectorEffect="non-scaling-stroke"
        width="810"
        x="107"
        y="107"
      />
      <g
        fill="none"
        strokeLinecap="round"
        strokeWidth="80"
        transform="translate(512 512) rotate(45) scale(1.1)"
      >
        <line stroke={ASH} x1="-150" x2="-150" y1="-120" y2="160" />
        <line stroke={ASH} x1="0" x2="0" y1="-225" y2="225" />
        <line stroke={EMBER} x1="150" x2="150" y1="-160" y2="120" />
      </g>
    </svg>
  );
}
