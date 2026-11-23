"use client";

// The call's compact head, revealed at the top of the screen once its big
// head and totals scroll away: the title, the project and the four totals,
// each told by an icon (its name stays for the screen reader and the hint).
// It slides down and fades in quickly, leaves a little faster, and only fades
// when the reader asks for less motion.

import { ClaudeIcon } from "@grill/ui/brand-icons";
import {
  BinaryIcon,
  CircleDollarSignIcon,
  type LucideIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";

/** Shown once `watched` has gone above the top of the screen. */
export const useScrolledPast = (
  watched: RefObject<HTMLElement | null>
): boolean => {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const element = watched.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) {
        setPast(!entry.isIntersecting && entry.boundingClientRect.top < 0);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [watched]);
  return past;
};

const Stat = ({
  children,
  icon: Icon,
  label,
  tone = "",
}: {
  children: ReactNode;
  icon: LucideIcon | typeof ClaudeIcon;
  label: string;
  tone?: string;
}) => (
  <span
    className={`flex shrink-0 items-center gap-1.5 tabular-nums ${tone}`}
    title={label}
  >
    <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
    <span className="sr-only">{label}: </span>
    {children}
  </span>
);

export interface StickyStats {
  readonly calls: number;
  readonly cost: string;
  readonly failures: number;
  readonly tokens: string;
}

export const StickyBar = ({
  live,
  project,
  shown,
  stats,
  title,
}: {
  live: boolean;
  project: string;
  shown: boolean;
  stats: StickyStats;
  title: string;
}) => (
  <div
    aria-hidden={!shown}
    className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-2 sm:px-10"
    inert={!shown}
  >
    <div
      className={`bg-card/95 shadow-touch pointer-events-auto flex h-11 w-full max-w-[1360px] min-w-0 items-center gap-3 rounded-[14px] px-4 text-[13px] backdrop-blur-xl transition-[translate,opacity] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:translate-y-0 ${
        shown
          ? "translate-y-0 opacity-100 duration-300"
          : "pointer-events-none -translate-y-3 opacity-0 duration-200"
      }`}
      data-shown={shown}
      data-testid="sticky-bar"
    >
      {live ? (
        <span className="relative flex size-2 shrink-0" title="Идёт звонок">
          <span className="bg-accent absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none" />
          <span className="bg-accent relative size-2 rounded-full" />
          <span className="sr-only">Идёт звонок</span>
        </span>
      ) : null}
      <span className="min-w-0 truncate font-semibold">{title}</span>
      <span className="text-muted-foreground hidden min-w-0 shrink truncate md:inline">
        {project}
      </span>
      <span className="ml-auto flex items-center gap-4">
        <Stat icon={CircleDollarSignIcon} label="Расход агента">
          {stats.cost}
        </Stat>
        <span className="hidden sm:contents">
          <Stat icon={BinaryIcon} label="Токены">
            {stats.tokens}
          </Stat>
          <Stat icon={ClaudeIcon} label="Вызовов агента">
            {stats.calls}
          </Stat>
        </span>
        <Stat
          icon={TriangleAlertIcon}
          label="Сбои вызовов"
          tone={stats.failures > 0 ? "text-contradiction" : ""}
        >
          {stats.failures}
        </Stat>
      </span>
    </div>
  </div>
);
