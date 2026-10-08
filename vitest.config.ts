import { defineConfig } from "vitest/config";

// Root config: runs every workspace project's tests with `pnpm test`.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "site"],
  },
});
