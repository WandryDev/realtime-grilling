import type { ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** 20px spinner with what we wait for and what happens next. */
export function PendingStatus({
  className,
  description,
  title,
}: {
  className?: string;
  description: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)} role="status">
      <Spinner
        aria-hidden="true"
        aria-label={undefined}
        className="text-foreground [&_[data-slot=spinner-track]]:stroke-border size-5"
        role="presentation"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-base font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
    </div>
  );
}
