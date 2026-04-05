import { defineConfig } from 'drizzle-kit'
import { globSync } from 'node:fs'

// Wrangler stores local D1 SQLite files under a content-addressed path
const [localDb] = globSync('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite')
  .filter(f => !f.endsWith('metadata.sqlite'))

if (!localDb) {
  throw new Error('No local D1 database found. Run `wrangler dev` first to create it.')
}

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  dbCredentials: {
    url: localDb,
  },
})
