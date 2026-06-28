import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests touch the local Postgres / filesystem; run serially
    // to avoid cross-test interference on shared resources.
    fileParallelism: false,
  },
});
