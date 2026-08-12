import { defineConfig } from "vitest/config";

// Live integration tests: hit a real Clio endpoint, run only on demand via
// `pnpm test:integration`. Generous timeouts for real WebSocket round-trips.
export default defineConfig({
  test: {
    globals: true,
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
