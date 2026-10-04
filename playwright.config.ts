import { defineConfig, devices } from "@playwright/test";

// Browser acceptance layer for the React management client.
// Runs against `pnpm dev` (Vite + miniflare) with DEV_MODE auth bypass.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: { baseURL: "http://localhost:5176" },
  webServer: {
    command: "pnpm build:css && pnpm exec vite --port 5176 --strictPort",
    url: "http://localhost:5176/app/overview",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
