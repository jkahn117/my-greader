// Cron handler tests.
// Outbound fetch (to feed URLs) is mocked via vi.stubGlobal so we control
// what the parser sees without making real HTTP requests.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAndStoreFeed, purgeOldItems } from '../handlers/cron'
import { getDb } from '../lib/db'
import { feeds, items, itemState, subscriptions, users } from '../db/schema'
import { deriveItemId } from '../lib/crypto'

// ---------------------------------------------------------------------------
// Sample feed XML fixtures
// ---------------------------------------------------------------------------

const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <item>
      <title>Article One</title>
      <link>https://example.com/article-1</link>
      <guid>https://example.com/article-1</guid>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <description>&lt;p&gt;Content of article one.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Article Two</title>
      <link>https://example.com/article-2</link>
      <guid>https://example.com/article-2</guid>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
      <description>&lt;p&gt;Content of article two.&lt;/p&gt;</description>
    </item>
  </channel>
</rss>`

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test Feed</title>
  <link href="https://atom.example.com"/>
  <entry>
    <title>Atom Article</title>
    <link href="https://atom.example.com/article-1"/>
    <id>https://atom.example.com/article-1</id>
    <published>2024-01-03T12:00:00Z</published>
    <summary>Atom article content.</summary>
  </entry>
</feed>`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(xml: string, status = 200, headers: Record<string, string> = {}) {
  // Use a factory so each call gets a fresh Response (bodies are single-use)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(
    () => Promise.resolve(new Response(xml, { status, headers })),
  ))
}

function mockFetch304() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 304 })))
}

async function seedFeed(feedUrl: string, title = 'Test Feed') {
  const db     = getDb(env.DB)
  const feedId = crypto.randomUUID()
  await db.insert(feeds).values({ id: feedId, feedUrl, title, htmlUrl: null })
  return feedId
}

async function seedUser() {
  const db = getDb(env.DB)
  await db.insert(users).values({ id: 'test-user', email: 'test@example.com', createdAt: Date.now() })
}

async function seedSubscription(feedId: string) {
  const db = getDb(env.DB)
  await db.insert(subscriptions).values({
    id: crypto.randomUUID(), userId: 'test-user', feedId, folder: null,
  })
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.exec('DELETE FROM item_state')
  await env.DB.exec('DELETE FROM subscriptions')
  await env.DB.exec('DELETE FROM items')
  await env.DB.exec('DELETE FROM feeds')
  await env.DB.exec('DELETE FROM users')
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// fetchAndStoreFeed
// ---------------------------------------------------------------------------

describe('fetchAndStoreFeed', () => {
  it('parses RSS and stores items', async () => {
    mockFetch(RSS_FEED)
    const feedId = await seedFeed('https://example.com/feed.xml')

    await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://example.com/feed.xml', title: null,
        htmlUrl: null, etag: null, lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )

    const db     = getDb(env.DB)
    const stored = await db.select().from(items).all()

    expect(stored).toHaveLength(2)
    expect(stored.map(i => i.title)).toContain('Article One')
    expect(stored.map(i => i.title)).toContain('Article Two')
  })

  it('parses Atom feeds', async () => {
    mockFetch(ATOM_FEED)
    const feedId = await seedFeed('https://atom.example.com/feed.xml')

    await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://atom.example.com/feed.xml', title: null,
        htmlUrl: null, etag: null, lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )

    const db     = getDb(env.DB)
    const stored = await db.select().from(items).all()
    expect(stored).toHaveLength(1)
    expect(stored[0].title).toBe('Atom Article')
  })

  it('skips parsing on 304 and updates lastFetchedAt', async () => {
    mockFetch304()
    const feedId = await seedFeed('https://example.com/feed.xml')

    const before = Date.now()
    await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://example.com/feed.xml', title: null,
        htmlUrl: null, etag: 'abc123', lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )

    const db  = getDb(env.DB)
    const row = await db.select({ lastFetchedAt: feeds.lastFetchedAt })
      .from(feeds)
      .get()

    // No items stored
    const stored = await db.select().from(items).all()
    expect(stored).toHaveLength(0)

    // But lastFetchedAt was updated
    expect(row?.lastFetchedAt).toBeGreaterThanOrEqual(before)
  })

  it('sends If-None-Match header when etag is stored', async () => {
    const mockFetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', mockFetchFn)
    const feedId = await seedFeed('https://example.com/feed.xml')

    await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://example.com/feed.xml', title: null,
        htmlUrl: null, etag: 'W/"abc123"', lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )

    const [, init] = mockFetchFn.mock.calls[0]
    expect(init.headers['If-None-Match']).toBe('W/"abc123"')
  })

  it('stores ETag and Last-Modified from response', async () => {
    mockFetch(RSS_FEED, 200, {
      'ETag':          'W/"new-etag"',
      'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    })
    const feedId = await seedFeed('https://example.com/feed.xml')

    await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://example.com/feed.xml', title: null,
        htmlUrl: null, etag: null, lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )

    const db  = getDb(env.DB)
    const row = await db.select({ etag: feeds.etag, lastModified: feeds.lastModified })
      .from(feeds)
      .get()

    expect(row?.etag).toBe('W/"new-etag"')
    expect(row?.lastModified).toBe('Wed, 01 Jan 2025 00:00:00 GMT')
  })

  it('does not insert duplicate items on second fetch', async () => {
    // Each call gets a fresh Response — bodies are single-use
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(RSS_FEED, { status: 200 }))
      .mockResolvedValueOnce(new Response(RSS_FEED, { status: 200 })),
    )
    const feedId  = await seedFeed('https://example.com/feed.xml')
    const feedRow = { id: feedId, feedUrl: 'https://example.com/feed.xml', title: null,
      htmlUrl: null, etag: null, lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null }

    await fetchAndStoreFeed(feedRow, env)
    await fetchAndStoreFeed(feedRow, env)

    const db     = getDb(env.DB)
    const stored = await db.select().from(items).all()
    expect(stored).toHaveLength(2) // not 4
  })

  it('trims content exceeding 50KB', async () => {
    const bigContent = 'x'.repeat(60 * 1024) // 60KB
    const bigFeed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Big Feed</title><link>https://example.com</link>
      <item>
        <title>Big Article</title>
        <link>https://example.com/big</link>
        <guid>https://example.com/big</guid>
        <description>${bigContent}</description>
      </item>
    </channel></rss>`

    mockFetch(bigFeed)
    const feedId = await seedFeed('https://example.com/feed.xml')

    await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://example.com/feed.xml', title: null,
        htmlUrl: null, etag: null, lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )

    const db     = getDb(env.DB)
    const stored = await db.select({ content: items.content }).from(items).get()
    const bytes  = new TextEncoder().encode(stored?.content ?? '').length
    expect(bytes).toBeLessThanOrEqual(50 * 1024)
  })

  it('handles non-OK HTTP status gracefully without throwing', async () => {
    mockFetch('', 500)
    const feedId = await seedFeed('https://example.com/feed.xml')

    const result = await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://example.com/feed.xml', title: null,
        htmlUrl: null, etag: null, lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )
    expect(result.status).toBe('error')

    const db     = getDb(env.DB)
    const stored = await db.select().from(items).all()
    expect(stored).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// fetchAndStoreFeed — error propagation (network-level throw)
// ---------------------------------------------------------------------------

describe('fetchAndStoreFeed error handling', () => {
  it('returns error result on network error', async () => {
    // Network errors (including timeouts) are caught and returned as a
    // FeedResult with status "error" so the Workflow can continue.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')))
    const feedId = await seedFeed('https://bad.example.com/feed.xml', 'Bad Feed')

    const result = await fetchAndStoreFeed(
      { id: feedId, feedUrl: 'https://bad.example.com/feed.xml', title: null,
        htmlUrl: null, etag: null, lastModified: null, lastFetchedAt: null, consecutiveErrors: 0, checkIntervalMinutes: 30, lastNewItemAt: null },
      env,
    )
    expect(result.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// purgeOldItems
// ---------------------------------------------------------------------------

describe('purgeOldItems', () => {
  it('deletes items older than ITEM_RETENTION_DAYS', async () => {
    await seedUser()
    const feedId = await seedFeed('https://example.com/feed.xml')
    const db     = getDb(env.DB)

    // Old item (31 days ago)
    const oldItemId = await deriveItemId('https://example.com/old')
    const oldTime   = Date.now() - 31 * 24 * 60 * 60 * 1000
    await db.insert(items).values({
      id: oldItemId, feedId, title: 'Old Article', url: 'https://example.com/old',
      content: 'old', fetchedAt: oldTime, publishedAt: oldTime,
    })

    // Recent item (1 day ago)
    const newItemId = await deriveItemId('https://example.com/new')
    await db.insert(items).values({
      id: newItemId, feedId, title: 'New Article', url: 'https://example.com/new',
      content: 'new', fetchedAt: Date.now() - 86_400_000, publishedAt: Date.now(),
    })

    await purgeOldItems({ ...env, ITEM_RETENTION_DAYS: '30' } as unknown as Env)

    const remaining = await db.select({ id: items.id }).from(items).all()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(newItemId)
  })

  it('deletes orphaned item_state rows before deleting items', async () => {
    await seedUser()
    const feedId = await seedFeed('https://example.com/feed.xml')
    const db     = getDb(env.DB)

    const oldItemId = await deriveItemId('https://example.com/old2')
    const oldTime   = Date.now() - 31 * 24 * 60 * 60 * 1000
    await db.insert(items).values({
      id: oldItemId, feedId, title: 'Old', url: 'https://example.com/old2',
      content: '', fetchedAt: oldTime, publishedAt: oldTime,
    })
    await db.insert(itemState).values({ itemId: oldItemId, userId: 'test-user', isRead: 1 })

    await purgeOldItems({ ...env, ITEM_RETENTION_DAYS: '30' } as unknown as Env)

    const stateRows = await db.select().from(itemState).all()
    const itemRows  = await db.select().from(items).all()
    expect(stateRows).toHaveLength(0)
    expect(itemRows).toHaveLength(0)
  })

  it('respects ITEM_RETENTION_DAYS env var', async () => {
    await seedUser()
    const feedId = await seedFeed('https://example.com/feed.xml')
    const db     = getDb(env.DB)

    // Item 8 days old
    const itemId  = await deriveItemId('https://example.com/week-old')
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    await db.insert(items).values({
      id: itemId, feedId, title: 'Week Old', url: 'https://example.com/week-old',
      content: '', fetchedAt: weekAgo, publishedAt: weekAgo,
    })

    // With 7-day retention, it should be deleted
    await purgeOldItems({ ...env, ITEM_RETENTION_DAYS: '7' } as unknown as Env)

    const remaining = await db.select().from(items).all()
    expect(remaining).toHaveLength(0)
  })
})
