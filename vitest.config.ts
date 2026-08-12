import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    // Live integration tests run separately via `pnpm test:integration`.
    exclude: [...configDefaults.exclude, "test/integration/**"],
    environment: "node",
  },
});
