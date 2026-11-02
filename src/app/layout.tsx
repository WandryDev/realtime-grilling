import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { DevNavigator } from "@/features/dev/dev-navigator";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Grill",
};

// Optical size axis: Paper sets Inter with opsz, large headings are tighter.
const inter = Inter({
  axes: ["opsz"],
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-jetbrains-mono",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={cn(
        "antialiased",
        "font-sans",
        inter.variable,
        jetbrainsMono.variable
      )}
      lang="ru"
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider>
          {/* Toasts from anywhere: `toast.add(…)` from @/components/ui/toast */}
          <Toaster>{children}</Toaster>
          {process.env.NODE_ENV === "production" ? null : <DevNavigator />}
        </ThemeProvider>
      </body>
    </html>
  );
}
