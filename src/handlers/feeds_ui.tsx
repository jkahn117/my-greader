import { Hono } from 'hono'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { feeds, subscriptions } from '../db/schema'
import { triggerFeedPollingWorkflow } from './cron'
import { App } from '../views/app'
import { FeedRow, FeedTab } from '../views/feeds'

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
      id:                   subscriptions.id,
      feedId:               feeds.id,
      // Use the user's custom subscription title if set, otherwise the feed's title
      title:                sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
      feedUrl:              feeds.feedUrl,
      htmlUrl:              feeds.htmlUrl,
      folder:               subscriptions.folder,
      lastFetchedAt:        feeds.lastFetchedAt,
      consecutiveErrors:    feeds.consecutiveErrors,
      lastError:            feeds.lastError,
      deactivatedAt:        feeds.deactivatedAt,
      checkIntervalMinutes: feeds.checkIntervalMinutes,
      lastNewItemAt:        feeds.lastNewItemAt,
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

// ---------------------------------------------------------------------------
// POST /feeds/sync — manually trigger a full feed fetch cycle
// ---------------------------------------------------------------------------

handler.post('/feeds/sync', async (c) => {
  const logger = createLogger({ path: '/feeds/sync', userId: c.get('userId') })
  logger.info('manual sync triggered')
  // Trigger the Workflow — returns immediately, fetch runs asynchronously
  c.executionCtx.waitUntil(triggerFeedPollingWorkflow(c.env))
  return c.html(
    <p class="text-sm text-muted-foreground">
      Sync started — refresh the page in a moment to see updated fetch times.
    </p>
  )
})

// ---------------------------------------------------------------------------
// POST /feeds/:id/reactivate — manually reactivate a deactivated feed
// ---------------------------------------------------------------------------

handler.post('/feeds/:id/reactivate', async (c) => {
  const { id } = c.req.param()
  const userId = c.get('userId')
  const logger = createLogger({ path: `/feeds/${id}/reactivate`, userId })
  const db = getDb(c.env.DB)

  // Verify the feed belongs to one of this user's subscriptions
  const sub = await db
    .select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .where(eq(subscriptions.userId, userId))
    .get()

  if (!sub) return c.text('Not found', 404)

  await db
    .update(feeds)
    .set({ deactivatedAt: null, consecutiveErrors: 0, lastError: null, checkIntervalMinutes: 30 })
    .where(eq(feeds.id, id))

  logger.info('feed reactivated', { feedId: id })

  // Return updated row fragment for htmx swap
  const updated = await db
    .select({
      id:                   subscriptions.id,
      feedId:               feeds.id,
      title:                sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
      feedUrl:              feeds.feedUrl,
      htmlUrl:              feeds.htmlUrl,
      folder:               subscriptions.folder,
      lastFetchedAt:        feeds.lastFetchedAt,
      consecutiveErrors:    feeds.consecutiveErrors,
      lastError:            feeds.lastError,
      deactivatedAt:        feeds.deactivatedAt,
      checkIntervalMinutes: feeds.checkIntervalMinutes,
      lastNewItemAt:        feeds.lastNewItemAt,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(eq(subscriptions.userId, userId))
    .get()

  if (!updated) return c.text('Not found', 404)

  return c.html(<FeedRow sub={updated} />)
})

// ---------------------------------------------------------------------------
// POST /feeds/:id/deactivate — manually deactivate an active feed
// ---------------------------------------------------------------------------

handler.post('/feeds/:id/deactivate', async (c) => {
  const { id } = c.req.param()
  const userId = c.get('userId')
  const logger = createLogger({ path: `/feeds/${id}/deactivate`, userId })
  const db = getDb(c.env.DB)

  // Verify the feed belongs to one of this user's subscriptions
  const sub = await db
    .select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, id)))
    .get()

  if (!sub) return c.text('Not found', 404)

  await db
    .update(feeds)
    .set({ deactivatedAt: Date.now() })
    .where(eq(feeds.id, id))

  logger.info('feed deactivated', { feedId: id })

  const updated = await db
    .select({
      id:                   subscriptions.id,
      feedId:               feeds.id,
      title:                sql<string>`coalesce(${subscriptions.title}, ${feeds.title})`,
      feedUrl:              feeds.feedUrl,
      htmlUrl:              feeds.htmlUrl,
      folder:               subscriptions.folder,
      lastFetchedAt:        feeds.lastFetchedAt,
      consecutiveErrors:    feeds.consecutiveErrors,
      lastError:            feeds.lastError,
      deactivatedAt:        feeds.deactivatedAt,
      checkIntervalMinutes: feeds.checkIntervalMinutes,
      lastNewItemAt:        feeds.lastNewItemAt,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, id)))
    .get()

  if (!updated) return c.text('Not found', 404)

  return c.html(<FeedRow sub={updated} />)
})

export { handler as feedsUiHandler }
