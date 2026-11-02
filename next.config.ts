import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const internalHost = process.env.TAURI_DEV_HOST || "localhost";
// Tauri's devUrl expects 3000; set PORT to run the dev server elsewhere.
const devPort = process.env.PORT || "3000";

// Tauri has no Node.js server, so the app is shipped as a static export.
// https://v2.tauri.app/start/frontend/nextjs/
const nextConfig: NextConfig = {
  // Load assets from the dev server when running inside the Tauri webview.
  assetPrefix: isProd ? undefined : `http://${internalHost}:${devPort}`,
  images: {
    unoptimized: true,
  },
  output: "export",
};

export default nextConfig;
