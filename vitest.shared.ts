import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

interface TestConfigOptions {
  developmentAuth: boolean;
}

// Builds a local-only Workers test configuration with every variable fixed in source control.
export async function createWorkersTestConfig({
  developmentAuth,
}: TestConfigOptions) {
  const migrations = await readD1Migrations(path.join(__dirname, "drizzle"));

  return {
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Tests replace outbound services explicitly and may never reach the public network.
          outboundService: {
            network: { deny: ["0.0.0.0/0", "::/0"] },
          },
          bindings: {
            TEST_MIGRATIONS: JSON.stringify(migrations),
            DEV_MODE: developmentAuth ? "true" : "false",
            CF_ACCESS_AUD: "test-access-audience",
            CF_API_TOKEN: "test-api-token",
            CF_ACCOUNT_ID: "test-account-id",
            DISPLAY_TIMEZONE: "UTC",
            ITEM_RETENTION_DAYS: "30",
            ANALYTICS_ENABLED: "false",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
}
