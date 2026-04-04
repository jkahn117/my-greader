import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'drizzle'))

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Pass migrations to the Workers runtime so setup.ts can apply them
          bindings: { TEST_MIGRATIONS: JSON.stringify(migrations) },
        },
      }),
    ],
    test: {
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
