import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Browser tests use an isolated local database and explicit development auth.
// The override is serve-only so production builds never inherit the bypass.
export default defineConfig(({ command, mode }) => ({
  plugins: [
    cloudflare(
      command === "serve" && mode === "e2e"
        ? {
            persistState: { path: ".wrangler/e2e" },
            remoteBindings: false,
            config: {
              vars: { DEV_MODE: "true", ANALYTICS_ENABLED: "false" },
            },
          }
        : {},
    ),
    react(),
  ],
}));
