import { configDefaults, defineConfig } from "vitest/config";

// `pnpm test:pg` sets this to run the whole suite against a real Postgres
// server instead of in-process PGlite (see test/dbHelpers.ts).
const againstPostgres = (process.env.TEST_DATABASE_URL ?? "").trim() !== "";

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
    // A handful of suites open a second database inside the test body rather
    // than a hook. Against a networked server that means a schema create, a
    // pool, a connection handshake and a migration run — comfortably over the
    // 5 s default that an in-memory PGlite finishes in milliseconds. Raised
    // only for the Postgres run, so the default loop keeps the tighter budget
    // and a genuinely hung test still fails fast there.
    ...(againstPostgres ? { testTimeout: 30_000 } : {}),
  },
});
