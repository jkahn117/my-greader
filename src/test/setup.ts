// Runs inside the Workers runtime before each test file.
// Applies D1 migrations so tests have the correct schema.
import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import { beforeAll } from 'vitest'

beforeAll(async () => {
  // TEST_MIGRATIONS is injected by vitest.config.ts as a JSON-stringified array
  const migrations: D1Migration[] = JSON.parse((env as unknown as Record<string, string>).TEST_MIGRATIONS)
  await applyD1Migrations(env.DB, migrations)
})
