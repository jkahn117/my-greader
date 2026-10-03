import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  flattenDiagnosticMessageText,
  parseConfigFileTextToJson,
} from "typescript";
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
  // Parse JSONC on the host, keeping filesystem access outside the Worker tests.
  const configPath = path.join(__dirname, "wrangler.jsonc");
  const { config, error } = parseConfigFileTextToJson(
    configPath,
    await readFile(configPath, "utf8"),
  );
  if (error) {
    throw new Error(flattenDiagnosticMessageText(error.messageText, "\n"));
  }

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
            TEST_WRANGLER_CONFIG: JSON.stringify(config),
            DEV_MODE: developmentAuth ? "true" : "false",
            CF_ACCESS_AUD: "test-access-audience",
            CF_ACCESS_ISSUER: "https://test-team.cloudflareaccess.com",
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
