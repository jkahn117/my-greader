import { defineConfig, mergeConfig } from "vitest/config";
import { createWorkersTestConfig } from "./vitest.shared";

export default defineConfig(async () =>
  mergeConfig(await createWorkersTestConfig({ developmentAuth: true }), {
    test: {
      include: ["test/**/*.test.ts"],
      exclude: ["test/**/*.production.test.ts"],
    },
  }),
);
