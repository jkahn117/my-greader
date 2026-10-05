import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig(async () => {
  // wrangler.jsonc points assets at ./dist/client; miniflare requires the
  // directory to exist even when the client has not been built yet.
  fs.mkdirSync(path.join(__dirname, 'dist/client'), { recursive: true })

  const migrations = await readD1Migrations(path.join(__dirname, 'drizzle'))

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Pass migrations to the Workers runtime so setup.ts can apply them
          bindings: {
            TEST_MIGRATIONS: JSON.stringify(migrations),
            DEV_MODE: "true",
            DISPLAY_TIMEZONE: "America/Los_Angeles",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  }
})
