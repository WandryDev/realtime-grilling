import type { NextConfig } from "next";

// A static export: the analytics server serves it from the same address as
// its API (call-analytics design.md, decision 9).
const nextConfig: NextConfig = {
  images: { unoptimized: true },
  output: "export",
  // Workspace packages of TypeScript sources.
  transpilePackages: ["@grill/ui", "@grill/analytics-server"],
};

export default nextConfig;
