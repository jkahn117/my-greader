/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: string;
    TEST_WRANGLER_CONFIG: string;
    DEV_MODE: string;
  }
}
