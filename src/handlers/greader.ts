import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import {
  deriveItemId,
  decodeContinuation,
  encodeContinuation,
  normalizeItemId,
  toGreaderItemId,
  sha256,
} from '../lib/crypto'
import { feeds, items, itemState, subscriptions, apiTokens } from '../db/schema'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variables = { userId: string; email: string }
const greader = new Hono<{ Bindings: Env; Variables: Variables }>()

// ---------------------------------------------------------------------------
// POST /accounts/ClientLogin
// ---------------------------------------------------------------------------
// Entry point for GReader clients. Validates the raw API token (Passwd field)
// and returns the same token as the Auth value — clients reuse it as the
// Authorization header on all subsequent requests.

export const clientLoginSchema = z.object({
  Email:   z.string().email(),
  Passwd:  z.string().min(1),
  service: z.string().optional(),
})

greader.post('/accounts/ClientLogin', async (c) => {
  const logger = createLogger({ path: '/accounts/ClientLogin' })

  const body   = await c.req.parseBody()
  const parsed = clientLoginSchema.safeParse(body)

  if (!parsed.success) {
    logger.warn('ClientLogin bad request', { errors: parsed.error.flatten() })
    return c.text('BadAuthentication', 403)
  }

  const { Passwd } = parsed.data

  // Validate the Passwd as a real API token (hash lookup)
  const db   = getDb(c.env.DB)
  const hash = await sha256(Passwd)
  const row  = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
    .get()

  if (!row) {
    logger.warn('ClientLogin failed — token not found or revoked')
    return c.text('BadAuthentication', 403)
  }

  logger.info('ClientLogin success', { email: parsed.data.Email })

  // GReader clients expect plain-text line-delimited response
  return c.text(`SID=none\nLSID=none\nAuth=${Passwd}\n`)
})

// ---------------------------------------------------------------------------
// All routes below require token auth middleware applied in index.tsx
// ---------------------------------------------------------------------------

// GET /reader/api/0/user-info
greader.get('/reader/api/0/user-info', (c) => {
  const userId = c.get('userId')
  const email  = c.get('email')
  return c.json({
    userId,
    userName:      email,
    userProfileId: userId,
    userEmail:     email,
  })
})

// ---------------------------------------------------------------------------
// GET /reader/api/0/subscription/list
// ---------------------------------------------------------------------------

greader.get('/reader/api/0/subscription/list', async (c) => {
  const logger = createLogger({ path: '/reader/api/0/subscription/list', userId: c.get('userId') })
  const db     = getDb(c.env.DB)
  const userId = c.get('userId')

  const rows = await db
    .select({
      subId:   subscriptions.id,
      title:   subscriptions.title,
      folder:  subscriptions.folder,
      feedId:  feeds.id,
      feedUrl: feeds.feedUrl,
      htmlUrl: feeds.htmlUrl,
      feedTitle: feeds.title,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .where(eq(subscriptions.userId, userId))

  logger.info('subscription/list', { count: rows.length })

  return c.json({
    subscriptions: rows.map(r => ({
      id:      `feed/${r.feedId}`,
      title:   r.title ?? r.feedTitle ?? r.feedUrl,
      htmlUrl: r.htmlUrl ?? '',
      url:     r.feedUrl,
      categories: r.folder
        ? [{ id: `user/-/label/${r.folder}`, label: r.folder }]
        : [],
    })),
  })
})

// ---------------------------------------------------------------------------
// POST /reader/api/0/subscription/edit
// ---------------------------------------------------------------------------

const subscriptionEditSchema = z.object({
  ac: z.enum(['subscribe', 'unsubscribe', 'edit']),
  s:  z.string().min(1),               // feed/<feed-url> or feed/<feed-id>
  t:  z.string().optional(),           // custom title
  a:  z.string().optional(),           // add label: user/-/label/<folder>
  r:  z.string().optional(),           // remove label
})

greader.post('/reader/api/0/subscription/edit', async (c) => {
  const logger = createLogger({ path: '/reader/api/0/subscription/edit', userId: c.get('userId') })
  const db     = getDb(c.env.DB)
  const userId = c.get('userId')

  const body   = await c.req.parseBody()
  const parsed = subscriptionEditSchema.safeParse(body)

  if (!parsed.success) {
    logger.warn('subscription/edit bad request', { errors: parsed.error.flatten() })
    return c.text('Error', 400)
  }

  const { ac, s, t, a, r } = parsed.data

  // s is always "feed/<url-or-id>"
  const feedRef = s.startsWith('feed/') ? s.slice(5) : s

  if (ac === 'subscribe') {
    // feedRef is the feed URL when subscribing
    const feedUrl = feedRef

    // Upsert feed row (cron will populate title/content later)
    let feed = await db.select().from(feeds).where(eq(feeds.feedUrl, feedUrl)).get()
    if (!feed) {
      const id = crypto.randomUUID()
      await db.insert(feeds).values({ id, feedUrl }).onConflictDoNothing()
      feed = await db.select().from(feeds).where(eq(feeds.feedUrl, feedUrl)).get()
    }
    if (!feed) return c.text('Error', 500)

    // Derive folder from label param if provided
    const folder = a?.startsWith('user/-/label/') ? a.slice('user/-/label/'.length) : null

    await db.insert(subscriptions)
      .values({ id: crypto.randomUUID(), userId, feedId: feed.id, title: t ?? null, folder })
      .onConflictDoNothing()

    logger.info('subscribed', { feedUrl, folder })
  }

  if (ac === 'unsubscribe') {
    // feedRef may be the feed ID (not URL) — look up by either
    const feed = await db.select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.id, feedRef))
      .get()
      ?? await db.select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.feedUrl, feedRef))
        .get()

    if (feed) {
      await db.delete(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feed.id)))
    }

    logger.info('unsubscribed', { feedRef })
  }

  if (ac === 'edit') {
    const feed = await db.select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.id, feedRef))
      .get()
      ?? await db.select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.feedUrl, feedRef))
        .get()

    if (!feed) return c.text('Error', 404)

    const updates: Partial<typeof subscriptions.$inferInsert> = {}
    if (t !== undefined) updates.title = t

    // a = add label, r = remove label
    if (a?.startsWith('user/-/label/')) updates.folder = a.slice('user/-/label/'.length)
    if (r?.startsWith('user/-/label/')) updates.folder = null

    if (Object.keys(updates).length > 0) {
      await db.update(subscriptions)
        .set(updates)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feed.id)))
    }

    logger.info('subscription edited', { feedRef, updates })
  }

  return c.text('OK')
})

// ---------------------------------------------------------------------------
// Shared stream query helpers
// ---------------------------------------------------------------------------

type StreamType = 'feed' | 'folder' | 'all' | 'starred'

function parseStreamId(s: string): { type: StreamType; value: string | null } {
  if (s.startsWith('feed/'))               return { type: 'feed',    value: s.slice(5) }
  if (s.startsWith('user/-/label/'))       return { type: 'folder',  value: s.slice('user/-/label/'.length) }
  if (s === 'user/-/state/com.google/starred') return { type: 'starred', value: null }
  return { type: 'all', value: null }
}

const streamParamsSchema = z.object({
  s:  z.string().default('user/-/state/com.google/reading-list'),
  n:  z.coerce.number().int().min(1).max(1000).default(20),
  xt: z.string().optional(),   // exclude tag, e.g. user/-/state/com.google/read
  c:  z.string().optional(),   // continuation token
  ot: z.coerce.number().optional(), // older than (unix seconds)
})

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/contents
// ---------------------------------------------------------------------------

greader.get('/reader/api/0/stream/contents', async (c) => {
  const logger = createLogger({ path: '/reader/api/0/stream/contents', userId: c.get('userId') })
  const db     = getDb(c.env.DB)
  const userId = c.get('userId')

  const parsed = streamParamsSchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'Bad request' }, 400)

  const { s, n, xt, c: contToken } = parsed.data
  const stream = parseStreamId(s)
  const excludeRead = xt === 'user/-/state/com.google/read'

  // Decode continuation cursor (published_at ms)
  const cursor = contToken ? decodeContinuation(contToken) : null

  const conditions = [eq(subscriptions.userId, userId)]

  if (stream.type === 'feed') {
    // stream.value may be feed ID or feed URL
    const feed = await db.select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.id, stream.value!))
      .get()
      ?? await db.select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.feedUrl, stream.value!))
        .get()
    if (feed) conditions.push(eq(items.feedId, feed.id))
  } else if (stream.type === 'folder') {
    conditions.push(eq(subscriptions.folder, stream.value!))
  } else if (stream.type === 'starred') {
    conditions.push(eq(itemState.isStarred, 1))
  }

  if (excludeRead) {
    // Exclude items where is_read = 1; treat missing item_state rows as unread
    conditions.push(
      sql`COALESCE(${itemState.isRead}, 0) = 0`
    )
  }

  if (cursor !== null) {
    conditions.push(lt(items.publishedAt, cursor))
  }

  // Fetch n+1 to detect whether a next page exists
  const rows = await db
    .select({
      item:      items,
      feedId:    feeds.id,
      feedTitle: feeds.title,
      htmlUrl:   feeds.htmlUrl,
      isRead:    itemState.isRead,
      isStarred: itemState.isStarred,
    })
    .from(items)
    .innerJoin(feeds, eq(items.feedId, feeds.id))
    .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    .leftJoin(itemState, and(
      eq(itemState.itemId, items.id),
      eq(itemState.userId, userId),
    ))
    .where(and(...conditions))
    .orderBy(desc(items.publishedAt))
    .limit(n + 1)

  const hasMore  = rows.length > n
  const page     = rows.slice(0, n)
  const lastItem = page.at(-1)
  const continuation = hasMore && lastItem?.item.publishedAt
    ? encodeContinuation(lastItem.item.publishedAt)
    : undefined

  logger.info('stream/contents', { stream: s, count: page.length, hasMore })

  return c.json({
    id: s,
    items: page.map(r => {
      const categories = ['user/-/state/com.google/reading-list']
      if (r.isRead)    categories.push('user/-/state/com.google/read')
      if (r.isStarred) categories.push('user/-/state/com.google/starred')

      return {
        id:        toGreaderItemId(r.item.id),
        title:     r.item.title ?? '',
        canonical: [{ href: r.item.url ?? '' }],
        summary:   { content: r.item.content ?? '' },
        author:    r.item.author ?? '',
        published: r.item.publishedAt ? Math.floor(r.item.publishedAt / 1000) : 0,
        updated:   r.item.publishedAt ? Math.floor(r.item.publishedAt / 1000) : 0,
        origin: {
          streamId: `feed/${r.feedId}`,
          title:    r.feedTitle ?? '',
          htmlUrl:  r.htmlUrl ?? '',
        },
        categories,
      }
    }),
    ...(continuation ? { continuation } : {}),
  })
})

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/items/ids
// ---------------------------------------------------------------------------

greader.get('/reader/api/0/stream/items/ids', async (c) => {
  const logger = createLogger({ path: '/reader/api/0/stream/items/ids', userId: c.get('userId') })
  const db     = getDb(c.env.DB)
  const userId = c.get('userId')

  const parsed = streamParamsSchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'Bad request' }, 400)

  const { s, n, xt, c: contToken } = parsed.data
  const stream = parseStreamId(s)
  const excludeRead = xt === 'user/-/state/com.google/read'
  const cursor = contToken ? decodeContinuation(contToken) : null

  const conditions = [eq(subscriptions.userId, userId)]

  if (stream.type === 'feed') {
    const feed = await db.select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.id, stream.value!))
      .get()
      ?? await db.select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.feedUrl, stream.value!))
        .get()
    if (feed) conditions.push(eq(items.feedId, feed.id))
  } else if (stream.type === 'folder') {
    conditions.push(eq(subscriptions.folder, stream.value!))
  } else if (stream.type === 'starred') {
    conditions.push(eq(itemState.isStarred, 1))
  }

  if (excludeRead) conditions.push(sql`COALESCE(${itemState.isRead}, 0) = 0`)
  if (cursor !== null) conditions.push(lt(items.publishedAt, cursor))

  const rows = await db
    .select({ id: items.id, publishedAt: items.publishedAt })
    .from(items)
    .innerJoin(feeds, eq(items.feedId, feeds.id))
    .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    .leftJoin(itemState, and(
      eq(itemState.itemId, items.id),
      eq(itemState.userId, userId),
    ))
    .where(and(...conditions))
    .orderBy(desc(items.publishedAt))
    .limit(n + 1)

  const hasMore      = rows.length > n
  const page         = rows.slice(0, n)
  const lastItem     = page.at(-1)
  const continuation = hasMore && lastItem?.publishedAt
    ? encodeContinuation(lastItem.publishedAt)
    : undefined

  logger.info('stream/items/ids', { stream: s, count: page.length })

  return c.json({
    itemRefs: page.map(r => ({
      id:             r.id,
      timestampUsec:  String((r.publishedAt ?? 0) * 1000),
    })),
    ...(continuation ? { continuation } : {}),
  })
})

// ---------------------------------------------------------------------------
// POST /reader/api/0/edit-tag
// ---------------------------------------------------------------------------

const editTagSchema = z.object({
  // `i` may appear multiple times — Hono parseBody returns last value;
  // we handle both string and array in the handler
  a: z.string().optional(),  // add tag
  r: z.string().optional(),  // remove tag
})

greader.post('/reader/api/0/edit-tag', async (c) => {
  const logger = createLogger({ path: '/reader/api/0/edit-tag', userId: c.get('userId') })
  const db     = getDb(c.env.DB)
  const userId = c.get('userId')

  // Parse body and extract all `i` values (multiple items per request)
  const body = await c.req.parseBody({ all: true })

  const parsed = editTagSchema.safeParse(body)
  if (!parsed.success) return c.text('Error', 400)

  const { a, r } = parsed.data

  // Collect item IDs — may be a single string or array
  const rawIds = Array.isArray(body['i']) ? body['i'] as string[] : [body['i'] as string]
  const itemIds = rawIds.filter(Boolean).map(normalizeItemId)

  if (itemIds.length === 0) return c.text('Error', 400)

  // Determine state updates from tag strings
  const updates: { isRead?: number; isStarred?: number } = {}

  const addTag    = a ?? ''
  const removeTag = r ?? ''

  if (addTag === 'user/-/state/com.google/read')       updates.isRead    = 1
  if (removeTag === 'user/-/state/com.google/read')    updates.isRead    = 0
  if (addTag === 'user/-/state/com.google/starred')    updates.isStarred = 1
  if (removeTag === 'user/-/state/com.google/starred') updates.isStarred = 0

  if (Object.keys(updates).length === 0) return c.text('OK')

  // Upsert item_state for each item
  for (const itemId of itemIds) {
    await db.insert(itemState)
      .values({ itemId, userId, isRead: 0, isStarred: 0, ...updates })
      .onConflictDoUpdate({
        target: [itemState.itemId, itemState.userId],
        set: updates,
      })
  }

  logger.info('edit-tag', { count: itemIds.length, addTag, removeTag })
  return c.text('OK')
})

// ---------------------------------------------------------------------------
// POST /reader/api/0/mark-all-as-read
// ---------------------------------------------------------------------------

const markAllReadSchema = z.object({
  s:  z.string().min(1),
  ts: z.coerce.number().optional(), // timestamp microseconds — mark items older than this
})

greader.post('/reader/api/0/mark-all-as-read', async (c) => {
  const logger = createLogger({ path: '/reader/api/0/mark-all-as-read', userId: c.get('userId') })
  const db     = getDb(c.env.DB)
  const userId = c.get('userId')

  const body   = await c.req.parseBody()
  const parsed = markAllReadSchema.safeParse(body)
  if (!parsed.success) return c.text('Error', 400)

  const { s, ts } = parsed.data
  const stream = parseStreamId(s)

  // Timestamp cutoff: ts is in microseconds, convert to ms for comparison
  const cutoffMs = ts ? Math.floor(ts / 1000) : null

  // Build subquery to select matching item IDs
  const itemConditions = []
  if (cutoffMs !== null) itemConditions.push(lt(items.publishedAt, cutoffMs))

  if (stream.type === 'feed') {
    const feed = await db.select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.id, stream.value!))
      .get()
      ?? await db.select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.feedUrl, stream.value!))
        .get()

    if (!feed) return c.text('OK')
    itemConditions.push(eq(items.feedId, feed.id))
  } else if (stream.type === 'folder') {
    // Only mark items in feeds the user subscribes to under this folder
    const subFeeds = await db
      .select({ feedId: subscriptions.feedId })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.folder, stream.value!),
      ))
    const feedIds = subFeeds.map(sf => sf.feedId)
    if (feedIds.length === 0) return c.text('OK')
    itemConditions.push(inArray(items.feedId, feedIds))
  } else if (stream.type === 'all') {
    // Constrain to feeds the user subscribes to
    const subFeeds = await db
      .select({ feedId: subscriptions.feedId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
    const feedIds = subFeeds.map(sf => sf.feedId)
    if (feedIds.length === 0) return c.text('OK')
    itemConditions.push(inArray(items.feedId, feedIds))
  }

  const targetItems = await db
    .select({ id: items.id })
    .from(items)
    .where(itemConditions.length > 0 ? and(...itemConditions) : undefined)

  const ids = targetItems.map(i => i.id)
  if (ids.length === 0) return c.text('OK')

  // Bulk upsert — SQLite doesn't support batch UPDATE with multiple rows,
  // so we insert/update in chunks to stay within D1 batch limits
  const CHUNK = 100
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    for (const itemId of chunk) {
      await db.insert(itemState)
        .values({ itemId, userId, isRead: 1, isStarred: 0 })
        .onConflictDoUpdate({
          target: [itemState.itemId, itemState.userId],
          set: { isRead: 1 },
        })
    }
  }

  logger.info('mark-all-as-read', { stream: s, count: ids.length })
  return c.text('OK')
})

export { greader, deriveItemId }
