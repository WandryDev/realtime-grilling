"use client";

import Link from "next/link";
import { type ComponentProps, type MouseEvent, useCallback } from "react";

import { inTauri } from "@/effect/runtime";
import { handOver } from "@/features/shell/api";

/*
 * A link of the start widget or the overlay. In the browser it navigates
 * the page like any link. In Tauri a floating window never loads another
 * page into itself (it is small, and only the overlay is hidden from
 * screen sharing): the click shows the window the route belongs to, the
 * main window opens the route, and this window hides.
 */
export function FloatingLink({
  href,
  onClick,
  ...props
}: ComponentProps<"a"> & { href: string }) {
  const open = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      handOver(href);
    },
    [href, onClick]
  );
  if (!inTauri) {
    return <Link href={href} onClick={onClick} {...props} />;
  }
  return <a href={href} onClick={open} {...props} />;
}
