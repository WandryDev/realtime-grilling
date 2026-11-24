import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import "./globals.css";

export const metadata: Metadata = {
  title: "Grill, аналитика",
};

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
      className={`font-sans antialiased ${inter.variable} ${jetbrainsMono.variable}`}
      lang="ru"
    >
      <body className="bg-surface min-h-dvh">{children}</body>
    </html>
  );
}
