import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // One database for the tests: the files take turns.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
