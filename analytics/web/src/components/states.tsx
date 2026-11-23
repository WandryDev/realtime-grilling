"use client";

// What a page shows before its data and instead of it (the mockups' «B1 ·
// загрузка», «ошибка загрузки», «B2 · не найден»).

import Link from "next/link";
import type { ReactNode } from "react";

const WIDTHS = ["90%", "78%", "66%", "54%", "42%", "30%"];

/** Grey blocks in the shape of what loads. */
export const Loading = ({ rows = 4 }: { rows?: number }) => (
  <div aria-busy="true" className="flex flex-col gap-4" role="status">
    <span className="sr-only">Загружаем…</span>
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {["a", "b", "c", "d"].map((key) => (
        <div className="bg-card h-32 rounded-[18px] p-6" key={key}>
          <div className="bg-muted h-3 w-28 rounded" />
          <div className="bg-muted mt-5 h-8 w-24 rounded-md" />
        </div>
      ))}
    </div>
    <div className="bg-card flex flex-col gap-4 rounded-[18px] p-7">
      {WIDTHS.slice(0, rows).map((width) => (
        <div className="bg-muted h-3 rounded" key={width} style={{ width }} />
      ))}
    </div>
  </div>
);

export const Problem = ({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) => (
  <div className="bg-card flex flex-col gap-3 rounded-[18px] px-8 py-12 sm:px-16">
    <h1 className="text-[28px] font-semibold tracking-tight">{title}</h1>
    <div className="text-muted-foreground max-w-xl text-[15px] leading-6">
      {children}
    </div>
    {action ? <div className="pt-3">{action}</div> : null}
  </div>
);

export const LoadError = ({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) => (
  <Problem
    action={
      <button
        className="bg-foreground text-background rounded-[10px] px-4 py-2.5 text-sm font-medium"
        onClick={retry}
        type="button"
      >
        Повторить
      </button>
    }
    title="Не получилось загрузить"
  >
    Сервер аналитики не ответил. Звонки при этом не теряются: Grill хранит
    события у себя и дошлёт их, когда сервер вернётся.
    <div className="mt-3 font-mono text-[12px]">{message}</div>
  </Problem>
);

export const NotFound = ({ what }: { what: string }) => (
  <Problem
    action={
      <Link
        className="bg-foreground text-background rounded-[10px] px-4 py-2.5 text-sm font-medium"
        href="/"
      >
        Все проекты
      </Link>
    }
    title={`${what} не найден`}
  >
    Скорее всего, он ещё в пути: если у менеджера пропадала сеть, события
    копятся у него и уходят, когда связь вернётся. Страница покажет его сама,
    как только он придёт.
  </Problem>
);
