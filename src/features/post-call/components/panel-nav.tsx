"use client";

import type { ReactNode } from "react";

import { NavItem, NavItemLabel } from "@/components/ui/nav-item";
import { Spinner } from "@/components/ui/spinner";
import { AppSidebar } from "@/features/shell/app-sidebar";
import { cn } from "@/lib/utils";

import { CheckIcon, ChevronRightIcon } from "../icons";
import { usePostCallLinks } from "./links";
import { StatusDot } from "./status-mark";

/*
 * Sidebar of the call and history windows: 36px pills with a medium ink
 * label and a marker on the right (count, time, pending dot, check). No
 * icons, unlike the main sidebar.
 */

export function PanelSidebar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <AppSidebar className={cn("justify-start gap-7 px-3 py-5", className)}>
      {children}
    </AppSidebar>
  );
}

export function PanelNavItem({
  active = false,
  className,
  disabled = false,
  href,
  label,
  trailing,
}: {
  active?: boolean;
  className?: string;
  /** Not ready yet: muted and not clickable. */
  disabled?: boolean;
  href: string;
  label: string;
  trailing?: ReactNode;
}) {
  const { Link } = usePostCallLinks();
  return (
    <NavItem
      active={active}
      aria-disabled={disabled || undefined}
      className={cn(
        "text-foreground h-9 gap-3 px-3 font-medium",
        disabled && "text-muted-foreground pointer-events-none",
        className
      )}
      href={disabled ? undefined : href}
      render={disabled ? <span /> : <Link href={href} />}
    >
      <NavItemLabel>{label}</NavItemLabel>
      {trailing}
    </NavItem>
  );
}

/** "‹ Телемедиа": a quiet way out of the window, above the navigation. */
export function PanelBackLink({
  className,
  href,
  label,
}: {
  className?: string;
  href: string;
  label: string;
}) {
  const { Link } = usePostCallLinks();
  return (
    <Link
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:focus-ring -mb-3 flex w-fit items-center gap-1.5 rounded-xs px-3 text-sm",
        className
      )}
      href={href}
    >
      <ChevronRightIcon className="size-3 rotate-180" />
      {label}
    </Link>
  );
}

/** Count or time in JetBrains Mono. */
export function NavMeta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-muted-foreground shrink-0 font-mono text-xs tabular-nums",
        className
      )}
    >
      {children}
    </span>
  );
}

/** Orange dot and count: items wait for your decision. */
export function NavPending({ count }: { count: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <StatusDot tone="accent" />
      <span className="text-accent-ink font-mono text-xs tabular-nums">
        {count}
      </span>
      <span className="sr-only"> ждут решения</span>
    </span>
  );
}

export function NavDone({ label = "всё разобрано" }: { label?: string }) {
  return (
    <span className="flex shrink-0">
      <CheckIcon className="text-confirmed size-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function NavBusy() {
  return <Spinner aria-label="Собираю" className="text-foreground" />;
}
