import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema:  './src/db/schema.ts',
  out:     './drizzle',
  // D1 migrations are applied via: wrangler d1 migrations apply rss-reader
  driver:  'd1-http',
})
