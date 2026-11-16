import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    server: {
      deps: {
        // Through the module graph, so its `invoke` is the mocked one of
        // the Tauri-mode tests (./src/__tests__/helpers/fake-tauri.ts).
        inline: ["@tauri-apps/plugin-dialog"],
      },
    },
    setupFiles: ["./vitest.setup.ts"],
    // Room for the condition waits of vitest.setup.ts on a loaded machine.
    testTimeout: 30_000,
  },
});
