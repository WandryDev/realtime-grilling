import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { RowStatus } from "@/components/ui/row-status";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { IconTile } from "./icon-tile";
import { CheckIcon } from "./icons";

/*
 * Permission list of the "Разрешения" step: rows between hairlines, each
 * with a 36px icon tile, a title over a muted line and a 132px right column
 * holding the action or the status.
 *
 *   <PermissionList>
 *     <PermissionRow
 *       icon={<MicrophoneIcon />}
 *       title="Микрофон"
 *       description="Чтобы слышать вас"
 *       status={<PermissionStatus state="granted" />}
 *     />
 *   </PermissionList>
 */
export function PermissionList({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      className={cn("border-border flex flex-col border-b", className)}
      {...props}
    />
  );
}

export function PermissionRow({
  className,
  description,
  icon,
  status,
  title,
  ...props
}: Omit<ComponentProps<"li">, "title"> & {
  description: ReactNode;
  icon: ReactNode;
  /** Button or PermissionStatus for the right column. */
  status: ReactNode;
  title: ReactNode;
}) {
  return (
    <li
      className={cn(
        "border-border flex items-center gap-3.5 border-t py-4",
        className
      )}
      {...props}
    >
      <IconTile>{icon}</IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-base font-semibold">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="flex w-[132px] shrink-0 justify-end">{status}</div>
    </li>
  );
}

export type PermissionState = "granted" | "waiting" | "denied";

const STATUS_LABEL: Record<PermissionState, string> = {
  denied: "Запрещено",
  granted: "Разрешено",
  waiting: "Ждём ответа",
};

/** What the system answered: granted, waiting for the dialog, or denied. */
export function PermissionStatus({
  className,
  state,
}: {
  className?: string;
  state: PermissionState;
}) {
  if (state === "denied") {
    return (
      <Badge
        className={cn("font-medium", className)}
        size="sm"
        variant="contradiction"
      >
        {STATUS_LABEL.denied}
      </Badge>
    );
  }
  if (state === "waiting") {
    return (
      <RowStatus className={cn("h-8 gap-2", className)}>
        <span aria-hidden="true" className="flex">
          <Spinner />
        </span>
        {STATUS_LABEL.waiting}
      </RowStatus>
    );
  }
  return (
    <RowStatus className={cn("h-8 font-medium", className)} tone="confirmed">
      <CheckIcon className="size-3.5" />
      {STATUS_LABEL.granted}
    </RowStatus>
  );
}
