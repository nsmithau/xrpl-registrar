import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    // Live integration tests run separately via `pnpm test:integration`.
    exclude: [...configDefaults.exclude, "test/integration/**"],
    environment: "node",
    // Most suites boot an in-process Postgres (PGlite, WASM) in beforeAll /
    // beforeEach. On a loaded machine that start-up can exceed vitest's 10 s
    // default, which fails the hook and skips the whole file — a flake, not a
    // defect. The tests themselves keep the default 5 s budget.
    hookTimeout: 30_000,
  },
});
