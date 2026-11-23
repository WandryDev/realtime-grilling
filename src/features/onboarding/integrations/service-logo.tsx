import { ClickUpIcon, GitHubIcon, OutlineIcon } from "@grill/ui/brand-icons";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

import type { ServiceId } from "./mock";

const LOGOS = {
  clickup: ClickUpIcon,
  github: GitHubIcon,
  outline: OutlineIcon,
} as const;

/** Brand mark of a service. Decorative; size it with `size-*`. */
export function ServiceLogo({
  service,
  ...props
}: ComponentProps<"svg"> & { service: ServiceId }) {
  const Logo = LOGOS[service];
  return <Logo {...props} />;
}

/*
 * Gray tile with the brand mark: 36px with an 18px mark in the service list,
 * 48px with a 24px mark above the heading of a service step.
 */
export function ServiceTile({
  className,
  service,
  size = "md",
}: {
  className?: string;
  service: ServiceId;
  size?: "md" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-surface flex shrink-0 items-center justify-center",
        size === "lg" ? "size-12 rounded-sm" : "size-9 rounded-xs",
        className
      )}
    >
      <ServiceLogo
        className={size === "lg" ? "size-6" : "size-4.5"}
        service={service}
      />
    </span>
  );
}
