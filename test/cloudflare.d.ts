/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: string;
    TEST_WRANGLER_CONFIG: string;
    DEV_MODE: string;
  }
}
