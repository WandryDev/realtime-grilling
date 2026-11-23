"use client";

import { usePathname } from "next/navigation";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import { AsideIcon, SidebarIcon } from "./icons";

/*
 * Side columns of a window that leave the row when the window gets narrow.
 *
 * At its breakpoint and wider a column sits in the window body as it is
 * (`display: contents`, the child is the flex item). Narrower, it is a drawer
 * over the panel: a title bar button opens it, Escape, the scrim, a link
 * inside it or a route change close it. The breakpoints are the window's own
 * width (`@container/window` on AppWindow), so artboards in /dev/screens
 * behave like the real window of that size.
 *
 *   const nav = useWindowColumn();
 *   <WindowColumnToggle column={nav} side="start" breakpoint="lg" />
 *   …
 *   <WindowColumn column={nav} label="Навигация" side="start" breakpoint="lg">
 *     <AppSidebar>…</AppSidebar>
 *   </WindowColumn>
 */

/** `lg`: the window is 1024 wide or wider, `xl`: 1280. */
export type WindowBreakpoint = "lg" | "xl";
export type WindowColumnSide = "start" | "end";

export interface WindowColumnState {
  close: () => void;
  id: string;
  open: boolean;
  toggle: () => void;
}

/** Open state of one collapsible column; closes on a route change. */
export function useWindowColumn(): WindowColumnState {
  const [open, setOpen] = useState(false);
  const id = useId();
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on navigation
  useEffect(() => setOpen(false), [pathname]);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return useMemo(
    () => ({ close, id, open, toggle }),
    [close, id, open, toggle]
  );
}

// Static class names per breakpoint, Tailwind only sees whole strings.
const COLUMN: Record<WindowBreakpoint, string> = {
  lg: "@5xl/window:contents @max-5xl/window:absolute @max-5xl/window:top-14 @max-5xl/window:bottom-0 @max-5xl/window:z-30 @max-5xl/window:not-data-open:hidden",
  xl: "@7xl/window:contents @max-7xl/window:absolute @max-7xl/window:top-14 @max-7xl/window:bottom-0 @max-7xl/window:z-30 @max-7xl/window:not-data-open:hidden",
};

const DRAWER_SIDE: Record<WindowColumnSide, string> = {
  end: "right-0 rounded-l-panel pr-2 pb-2",
  start: "left-0 rounded-r-panel pb-2 pl-2",
};

const NARROW_ONLY: Record<WindowBreakpoint, string> = {
  lg: "@5xl/window:hidden",
  xl: "@7xl/window:hidden",
};

/** A side column; a drawer below `breakpoint`. */
export function WindowColumn({
  breakpoint,
  children,
  column,
  label,
  side,
}: {
  breakpoint: WindowBreakpoint;
  children: ReactNode;
  column: WindowColumnState;
  /** Name of the drawer, e.g. «Навигация». */
  label: string;
  side: WindowColumnSide;
}) {
  const ref = useRef<HTMLElement>(null);
  const { close, id, open } = column;

  useEffect(() => {
    const element = ref.current;
    if (!(open && element)) {
      return;
    }
    // Into the drawer, so Tab goes through it next.
    if (getComputedStyle(element).position === "absolute") {
      element.focus({ preventScroll: true });
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        document.querySelector<HTMLElement>(`[aria-controls="${id}"]`)?.focus();
      }
    };
    // A link inside the drawer opens its page: the drawer has done its job.
    const onClick = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("a")) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    element.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("click", onClick);
    };
  }, [close, id, open]);

  return (
    <>
      {open ? (
        <button
          aria-label="Закрыть панель"
          className={cn(
            "bg-foreground/10 absolute inset-x-0 top-14 bottom-0 z-20 cursor-default",
            NARROW_ONLY[breakpoint]
          )}
          onClick={close}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <section
        aria-label={label}
        className={cn(
          "bg-surface shadow-float flex min-h-0 outline-none",
          COLUMN[breakpoint],
          DRAWER_SIDE[side]
        )}
        data-open={open ? "" : undefined}
        data-slot="window-column"
        id={id}
        ref={ref}
        tabIndex={-1}
      >
        {children}
      </section>
    </>
  );
}

/** Title bar button that opens a column's drawer; hidden when it fits. */
export function WindowColumnToggle({
  breakpoint,
  className,
  column,
  label,
  side,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  breakpoint: WindowBreakpoint;
  column: WindowColumnState;
  label: string;
  side: WindowColumnSide;
}) {
  const Icon = side === "start" ? SidebarIcon : AsideIcon;
  return (
    <button
      aria-controls={column.id}
      aria-expanded={column.open}
      aria-label={label}
      className={cn(
        "text-muted-foreground hover:bg-border hover:text-foreground focus-visible:focus-ring aria-expanded:bg-background aria-expanded:text-foreground flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        NARROW_ONLY[breakpoint],
        className
      )}
      onClick={column.toggle}
      type="button"
      {...props}
    >
      <Icon className="size-4" />
    </button>
  );
}
