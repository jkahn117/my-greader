import { Hono } from 'hono'
import { and, asc, eq, sql } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { parseOpml } from '../lib/opml'
import { fetchAndStoreFeed } from './cron'
import { feeds, subscriptions } from '../db/schema'
import { ImportResult } from '../views/import'
import { SubscriptionListContent } from '../views/feeds'

type Variables = { userId: string; email: string }

const handler = new Hono<{ Bindings: Env; Variables: Variables }>()

// ---------------------------------------------------------------------------
// POST /import — parse an OPML upload and bulk-subscribe
// ---------------------------------------------------------------------------

handler.post('/import', async (c) => {
  const userId = c.get('userId')
  const logger = createLogger({ path: '/import', userId })

  // Parse multipart upload
  const body = await c.req.parseBody()
  const file = body['opml']

  if (!file || typeof file === 'string') {
    return c.html(
      <p class="text-sm text-destructive">Please upload an OPML file.</p>,
    )
  }

  const xml        = await (file as File).text()
  const parsedList = parseOpml(xml)

  if (parsedList.length === 0) {
    return c.html(
      <p class="text-sm text-destructive">No feeds found in the uploaded file.</p>,
    )
  }

  const db = getDb(c.env.DB)

  let imported   = 0
  let duplicates = 0
  const errors:     string[]                                 = []
  const newFeedRows: Parameters<typeof fetchAndStoreFeed>[0][] = []

  for (const parsed of parsedList) {
    try {
      // Upsert the canonical feed row (shared across all users)
      await db
        .insert(feeds)
        .values({
          id:      crypto.randomUUID(),
          feedUrl: parsed.feedUrl,
          title:   parsed.title,
          htmlUrl: parsed.htmlUrl,
        })
        .onConflictDoNothing()

      const feed = await db
        .select()
        .from(feeds)
        .where(eq(feeds.feedUrl, parsed.feedUrl))
        .get()

      if (!feed) {
        // Should not happen, but guards the type narrowing below
        errors.push(parsed.feedUrl)
        continue
      }

      // Check for an existing subscription for this user + feed
      const existing = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feed.id)))
        .get()

      if (existing) {
        duplicates++
        continue
      }

      // Create the subscription
      await db.insert(subscriptions).values({
        id:     crypto.randomUUID(),
        userId,
        feedId: feed.id,
        title:  parsed.title,   // user's custom title; null defers to feed default
        folder: parsed.folder,
      })

      imported++
      newFeedRows.push(feed)
    } catch (err) {
      logger.error('error importing feed', { feedUrl: parsed.feedUrl, err: String(err) })
      errors.push(parsed.feedUrl)
    }
  }

  logger.info('OPML import complete', { imported, duplicates, errors: errors.length })

  // Trigger an immediate fetch for each newly imported feed — non-blocking
  if (newFeedRows.length > 0) {
    c.executionCtx.waitUntil(
      Promise.allSettled(
        newFeedRows.map(feed =>
          fetchAndStoreFeed(feed, c.env).catch(err =>
            logger.error('post-import fetch failed', { feedId: feed.id, err: String(err) }),
          ),
        ),
      ),
    )
  }

  // Re-query the updated subscription list for OOB swap
  const updatedSubs = await db
    .select({
      id:            subscriptions.id,
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

  // Return the import summary + OOB update that refreshes the subscription table
  return c.html(
    <>
      <ImportResult imported={imported} duplicates={duplicates} errors={errors} />
      <SubscriptionListContent subs={updatedSubs} oob />
    </>,
  )
})

export { handler as importHandler }
