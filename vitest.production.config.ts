import { defineConfig, mergeConfig } from "vitest/config";
import { createWorkersTestConfig } from "./vitest.shared";

export default defineConfig(async () =>
  mergeConfig(await createWorkersTestConfig({ developmentAuth: false }), {
    test: {
      include: ["test/**/*.production.test.ts"],
    },
  }),
);
