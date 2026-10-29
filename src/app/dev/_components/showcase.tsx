import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
 * Layout pieces for /dev. They mirror the artboards on the "Компоненты" page
 * in Paper: a titled section, a state matrix and captioned specimens.
 */

interface ShowcaseSectionProps {
  children: ReactNode;
  description: string;
  id: string;
  title: string;
}

export function ShowcaseSection({
  children,
  description,
  id,
  title,
}: ShowcaseSectionProps) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="border-border flex scroll-mt-20 flex-col gap-12 border-t py-16 first:border-t-0 first:pt-0"
      id={id}
    >
      <header className="flex flex-col gap-2">
        <h2
          className="text-2xl font-semibold tracking-tight"
          id={`${id}-title`}
        >
          {title}
        </h2>
        <p className="text-muted-foreground text-base">{description}</p>
      </header>
      {children}
    </section>
  );
}

export function ShowcaseGroup({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </div>
  );
}

/** State matrix: one row per variant, one column per state. */
export function StateTable({
  children,
  columns,
}: {
  children: ReactNode;
  columns: string[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] border-collapse text-left">
        <thead>
          <tr className="border-border border-b">
            <th className="w-40 pb-3 font-normal" scope="col">
              <span className="sr-only">Вариант</span>
            </th>
            {columns.map((column) => (
              <th
                className="text-muted-foreground pb-3 text-sm font-normal"
                key={column}
                scope="col"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function StateRow({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    <tr className="border-border border-b last:border-b-0">
      <th className="py-6 pr-4 align-top font-normal" scope="row">
        <div className="text-base font-medium">{label}</div>
        {hint ? (
          <div className="text-muted-foreground mt-0.5 text-sm">{hint}</div>
        ) : null}
      </th>
      {children}
    </tr>
  );
}

export function StateCell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <td className={cn("py-6 pr-4 align-top", className)}>
      <div className="flex flex-col items-start gap-2">{children}</div>
    </td>
  );
}

/** A component example with a caption underneath, like the notes in Paper. */
export function Specimen({
  caption,
  children,
  className,
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("flex flex-col gap-3", className)}>
      {children}
      <figcaption className="text-muted-foreground text-sm">
        {caption}
      </figcaption>
    </figure>
  );
}

/** Gray stage for components that live on the surface color. */
export function Stage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-surface rounded-md p-4", className)}>{children}</div>
  );
}
