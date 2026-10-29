"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

// The Grill design system is light only ("ink on paper"), see globals.css.
function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      disableTransitionOnChange
      forcedTheme="light"
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}

export { ThemeProvider };
