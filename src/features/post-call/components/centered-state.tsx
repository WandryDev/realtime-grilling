import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@grill/ui/empty";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * A centered state inside the panel ("Всё разобрано", "Звонков пока не
 * было"): a big mark, a 28px title, a muted explanation, then a short list
 * and the actions. Built on Empty, a size up.
 */
export function CenteredState({
  children,
  className,
  description,
  media,
  mediaClassName,
  title,
}: {
  children?: ReactNode;
  className?: string;
  description: ReactNode;
  media: ReactNode;
  /** Shape and color of the mark tile. */
  mediaClassName?: string;
  title: string;
}) {
  return (
    <Empty className={cn("gap-5 px-0 pt-0 pb-16", className)}>
      <EmptyMedia className={mediaClassName} variant="icon">
        {media}
      </EmptyMedia>
      <EmptyHeader className="max-w-[460px] gap-2">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <EmptyDescription className="text-lg text-pretty">
          {description}
        </EmptyDescription>
      </EmptyHeader>
      {children}
    </Empty>
  );
}

/** Rows under a centered state, no lines. */
export function StateList({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn("flex w-full max-w-[420px] flex-col", className)}
    >
      {children}
    </ul>
  );
}

export function StateRow({
  children,
  className,
  media,
  trailing,
}: {
  children: ReactNode;
  className?: string;
  media: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex min-h-11 items-center gap-2.5 px-1 py-2.5 text-left",
        className
      )}
    >
      {media}
      <span className="min-w-0 flex-1 text-base">{children}</span>
      {trailing}
    </li>
  );
}

export function StateRowNote({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground text-sm">{children}</span>;
}
