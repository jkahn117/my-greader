import { Hono } from 'hono'
import { asc, eq, sql } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { feeds, subscriptions } from '../db/schema'
import { App } from '../views/app'
import { FeedTab } from '../views/feeds'

type Variables = { userId: string; email: string }

const handler = new Hono<{ Bindings: Env; Variables: Variables }>()

// ---------------------------------------------------------------------------
// GET /app/feeds — Feed tab (subscription list + OPML import form)
// ---------------------------------------------------------------------------

handler.get('/app/feeds', async (c) => {
  const userId = c.get('userId')
  const email  = c.get('email')
  const db     = getDb(c.env.DB)
  const logger = createLogger({ path: '/app/feeds', userId })

  const subs = await db
    .select({
      id:            subscriptions.id,
      // Use the user's custom subscription title if set, otherwise the feed's title
      title:         sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
      feedUrl:       feeds.feedUrl,
      htmlUrl:       feeds.htmlUrl,
      folder:        subscriptions.folder,
      lastFetchedAt: feeds.lastFetchedAt,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(eq(subscriptions.userId, userId))
    .orderBy(asc(sql`coalesce(${subscriptions.title}, ${feeds.title})`))

  logger.info('feed tab loaded', { subCount: subs.length })

  return c.html(
    <App email={email} active="feed">
      <FeedTab subs={subs} />
    </App>,
  )
})

export { handler as feedsUiHandler }
