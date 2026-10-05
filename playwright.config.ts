import { defineConfig, devices } from "@playwright/test";

// Browser acceptance layer for the React management client.
// Runs against Vite + miniflare, or the built Worker with PLAYWRIGHT_BUILD=1.
// Auth bypass is supplied only to the local test server, never a deploy build.
const serverCommand =
  process.env.PLAYWRIGHT_BUILD === "1"
    ? "pnpm build && pnpm exec wrangler dev --config dist/my_greader/wrangler.json --local --port 5176 --local-upstream localhost:5176 --persist-to .wrangler/e2e --var DEV_MODE:true --var ANALYTICS_ENABLED:false"
    : "pnpm build:css && pnpm exec vite --mode e2e --port 5176 --strictPort";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  // Tests mutate the same D1 fixtures, so files must not race each other.
  workers: 1,
  use: { baseURL: "http://localhost:5176" },
  webServer: {
    command: `pnpm exec wrangler d1 migrations apply rss-reader --local --persist-to .wrangler/e2e --config wrangler.jsonc && ${serverCommand}`,
    url: "http://localhost:5176/app/overview",
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
