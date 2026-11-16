import type { ComponentProps, ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { MinimizeIcon } from "../icons";
import { StatusDot, type StatusDotTone } from "./status-dot";

/** Top row of a floating widget: status on the left, one icon button right. */
export function WidgetHeader({
  action,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { action?: ReactNode }) {
  return (
    <div
      className={cn("flex items-center justify-between gap-2", className)}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      {action}
    </div>
  );
}

/**
 * Dot, muted label and the call time in mono: "● Запись идёт 00:06",
 * "● Телемедиа 39:04". Without a time it is a plain status line.
 */
export function WidgetStatus({
  children,
  className,
  time,
  tone,
  ...props
}: ComponentProps<"div"> & { time?: string; tone: StatusDotTone }) {
  return (
    <div
      className={cn("flex min-w-0 items-center gap-2", className)}
      {...props}
    >
      <StatusDot tone={tone} />
      <span className="text-muted-foreground truncate text-sm">{children}</span>
      {time ? (
        <span className="text-foreground font-mono text-xs tabular-nums">
          {time}
        </span>
      ) : null}
    </div>
  );
}

/*
 * A 28px ghost circle that pulls itself 4px into the widget padding, so its
 * icon lines up with the content edge, as in Paper.
 */
export function WidgetIconButton({
  className,
  size = "icon-sm",
  variant = "ghost",
  ...props
}: ButtonProps) {
  return (
    <Button
      className={cn("-my-1 -mr-1", className)}
      size={size}
      variant={variant}
      {...props}
    />
  );
}

/** "−" in the widget header: collapse the widget to the pill. */
export function WidgetMinimizeButton({ className, ...props }: ButtonProps) {
  return (
    <WidgetIconButton
      aria-label="Свернуть"
      className={cn("text-subtle", className)}
      {...props}
    >
      <MinimizeIcon className="size-5" />
    </WidgetIconButton>
  );
}

/** Widget title (20/600) with an optional leading mark and a muted line. */
export function WidgetHeading({
  className,
  description,
  icon,
  title,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)} {...props}>
      <div className="flex items-center gap-2.5">
        {icon}
        <h1 className="text-xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
      </div>
      {description ? (
        <p className="text-muted-foreground text-sm">{description}</p>
      ) : null}
    </div>
  );
}
