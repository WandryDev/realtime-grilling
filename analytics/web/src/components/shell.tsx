"use client";

// The frame of every page: the name, the way back, and the state of the
// live connection in one fixed slot, so a change of it moves nothing.

import Link from "next/link";
import type { ReactNode } from "react";
import type { Connection } from "@/lib/live";

const CONNECTION: Record<
  Connection,
  { label: string; tone: string; dot: string }
> = {
  connecting: {
    dot: "bg-subtle",
    label: "Подключаемся…",
    tone: "text-muted-foreground",
  },
  live: { dot: "bg-confirmed", label: "Вживую", tone: "text-muted-foreground" },
  lost: {
    dot: "bg-contradiction",
    label: "Нет связи · переподключаемся",
    tone: "text-contradiction",
  },
};

export const Shell = ({
  children,
  connection,
  crumbs,
}: {
  children: ReactNode;
  connection?: Connection;
  crumbs?: ReactNode;
}) => {
  const state = connection ? CONNECTION[connection] : null;
  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 pt-5 pb-14 sm:px-10">
      <header className="flex min-h-9 items-center justify-between gap-4">
        <Link
          className="flex items-center gap-2.5 text-[15px] font-medium"
          href="/"
        >
          <span className="bg-foreground grid size-6 place-items-center rounded-md">
            <span className="bg-accent size-2.5 rounded-full" />
          </span>
          Grill{" "}
          <span className="text-muted-foreground font-normal">Аналитика</span>
        </Link>
        <div className="flex min-w-56 justify-end">
          {state ? (
            <span
              className={`border-border flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] ${state.tone}`}
              data-testid="connection"
            >
              <span className={`size-1.5 rounded-full ${state.dot}`} />
              {state.label}
            </span>
          ) : null}
        </div>
      </header>
      {crumbs ? (
        <nav className="text-muted-foreground text-[13px]">{crumbs}</nav>
      ) : null}
      {children}
    </div>
  );
};

/** A card of a page: a title, what it counts, its content. */
export const Panel = ({
  aside,
  children,
  className = "",
  title,
}: {
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) => (
  <section
    className={`bg-card flex flex-col gap-5 rounded-[18px] p-6 sm:p-7 ${className}`}
  >
    {title || aside ? (
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {aside ? (
          <div className="text-muted-foreground text-[13px]">{aside}</div>
        ) : null}
      </div>
    ) : null}
    {children}
  </section>
);

/** A figure that matters, with what it is and what it rests on. */
export const Kpi = ({
  hint,
  label,
  tone = "",
  value,
}: {
  hint?: ReactNode;
  label: string;
  tone?: string;
  value: ReactNode;
}) => (
  <div className="bg-card flex flex-col gap-2 rounded-[18px] px-6 py-5">
    <div className="text-muted-foreground text-sm">{label}</div>
    <div
      className={`text-[34px] leading-10 font-semibold tracking-tight tabular-nums ${tone}`}
    >
      {value}
    </div>
    {hint ? (
      <div className="text-muted-foreground text-[13px]">{hint}</div>
    ) : null}
  </div>
);
