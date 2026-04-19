import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
    // better-sqlite3's native bindings + the MCP SDK's in-memory transport
    // do not play well with vitest's default worker pool; concurrent workers
    // can wedge on SIGTERM. A single forked process is plenty fast for this
    // surface.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
