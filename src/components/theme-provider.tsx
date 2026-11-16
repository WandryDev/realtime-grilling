"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/** Where every window remembers the last applied «Тема» (same origin). */
export const THEME_STORAGE_KEY = "grill.theme";

/*
 * Light and dark Grill (globals.css). next-themes puts `.light` / `.dark`
 * and `color-scheme` on <html>; its inline script does it from the last
 * applied theme before the first paint, so a window opens in its theme.
 * The «Тема» setting drives it (ThemeSync, src/features/shell): `system`
 * follows `prefers-color-scheme` live.
 */
function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      disableTransitionOnChange
      enableSystem
      storageKey={THEME_STORAGE_KEY}
      themes={["light", "dark"]}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}

export { ThemeProvider };
