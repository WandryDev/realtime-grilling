import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const internalHost = process.env.TAURI_DEV_HOST || "localhost";

// Tauri has no Node.js server, so the app is shipped as a static export.
// https://v2.tauri.app/start/frontend/nextjs/
const nextConfig: NextConfig = {
  // Load assets from the dev server when running inside the Tauri webview.
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
  images: {
    unoptimized: true,
  },
  output: "export",
};

export default nextConfig;
