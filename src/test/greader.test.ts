// GReader protocol tests modelled on the FreshRSS GReader test suite.
// Each section mirrors a FreshRSS test group: auth, subscriptions, streams, tagging.
// Tests run against the real Worker + in-memory D1 via @cloudflare/vitest-pool-workers.

import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../index'
import { getDb } from '../lib/db'
import { apiTokens, feeds, items, subscriptions, users } from '../db/schema'
import { deriveItemId, sha256 } from '../lib/crypto'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN  = 'test-hardcoded-token'
const BASE   = 'http://localhost'

async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init)
  const ctx = createExecutionContext()
  const res = await worker.fetch(req, env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

function authHeaders(): HeadersInit {
  return { Authorization: `GoogleLogin auth=${TOKEN}` }
}

function formBody(params: Record<string, string>): BodyInit {
  return new URLSearchParams(params).toString()
}

// Seeds a feed + item directly into D1 for stream tests
async function seedFeed(opts: {
  feedUrl: string
  title: string
  itemGuid: string
  itemTitle: string
  publishedAt?: number
}) {
  const db      = getDb(env.DB)
  const feedId  = crypto.randomUUID()
  const itemId  = await deriveItemId(opts.itemGuid)

  await db.insert(feeds).values({
    id:       feedId,
    feedUrl:  opts.feedUrl,
    title:    opts.title,
    htmlUrl:  `https://${new URL(opts.feedUrl).hostname}`,
  })
  await db.insert(items).values({
    id:          itemId,
    feedId,
    title:       opts.itemTitle,
    url:         opts.itemGuid,
    content:     `<p>${opts.itemTitle}</p>`,
    publishedAt: opts.publishedAt ?? Date.now(),
    fetchedAt:   Date.now(),
  })

  return { feedId, itemId }
}

async function subscribeUser(userId: string, feedId: string, folder?: string) {
  const db = getDb(env.DB)
  await db.insert(subscriptions).values({
    id:     crypto.randomUUID(),
    userId,
    feedId,
    folder: folder ?? null,
  }).onConflictDoNothing()
}

// ---------------------------------------------------------------------------
// Reset DB between tests and seed the hardcoded dev user
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.exec('DELETE FROM item_state')
  await env.DB.exec('DELETE FROM api_tokens')
  await env.DB.exec('DELETE FROM subscriptions')
  await env.DB.exec('DELETE FROM items')
  await env.DB.exec('DELETE FROM feeds')
  await env.DB.exec('DELETE FROM users')

  const db = getDb(env.DB)

  // Seed the test user
  await db.insert(users).values({ id: 'dev-user-id', email: 'dev@localhost', createdAt: Date.now() })

  // Seed a real API token so the DB-backed token middleware can authenticate
  const tokenHash = await sha256(TOKEN)
  await db.insert(apiTokens).values({
    id:        'test-token-id',
    userId:    'dev-user-id',
    name:      'Test Token',
    tokenHash,
    createdAt: Date.now(),
  })
})

// ---------------------------------------------------------------------------
// Auth — /accounts/ClientLogin
// ---------------------------------------------------------------------------

describe('ClientLogin', () => {
  it('returns Auth token on valid credentials', async () => {
    const res = await fetch('/accounts/ClientLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ Email: 'user@example.com', Passwd: TOKEN }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain(`Auth=${TOKEN}`)
    expect(text).toContain('SID=none')
    expect(text).toContain('LSID=none')
  })

  it('rejects wrong password with 403', async () => {
    const res = await fetch('/accounts/ClientLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ Email: 'user@example.com', Passwd: 'wrong-token' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects missing password with 400', async () => {
    const res = await fetch('/accounts/ClientLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ Email: 'user@example.com', Passwd: '' }),
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Auth middleware — protected routes
// ---------------------------------------------------------------------------

describe('Token middleware', () => {
  it('rejects requests without Authorization header', async () => {
    const res = await fetch('/reader/api/0/user-info')
    expect(res.status).toBe(401)
  })

  it('rejects wrong token', async () => {
    const res = await fetch('/reader/api/0/user-info', {
      headers: { Authorization: 'GoogleLogin auth=bad-token' },
    })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// user-info
// ---------------------------------------------------------------------------

describe('user-info', () => {
  it('returns userId and email', async () => {
    const res  = await fetch('/reader/api/0/user-info', { headers: authHeaders() })
    const body = await res.json() as Record<string, string>

    expect(res.status).toBe(200)
    expect(body).toHaveProperty('userId')
    expect(body).toHaveProperty('userEmail')
    expect(body.userId).toBe(body.userProfileId)
  })
})

// ---------------------------------------------------------------------------
// subscription/list
// ---------------------------------------------------------------------------

describe('subscription/list', () => {
  it('returns empty array when no subscriptions', async () => {
    const res  = await fetch('/reader/api/0/subscription/list', { headers: authHeaders() })
    const body = await res.json() as { subscriptions: unknown[] }

    expect(res.status).toBe(200)
    expect(body.subscriptions).toEqual([])
  })

  it('returns subscription with correct shape', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example Feed',
      itemGuid: 'https://example.com/article-1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId, 'Tech')

    const res  = await fetch('/reader/api/0/subscription/list', { headers: authHeaders() })
    const body = await res.json() as { subscriptions: Array<Record<string, unknown>> }

    expect(res.status).toBe(200)
    expect(body.subscriptions).toHaveLength(1)

    const sub = body.subscriptions[0]
    expect(sub.id).toBe(`feed/${feedId}`)
    expect(sub.title).toBe('Example Feed')
    expect(sub.url).toBe('https://example.com/feed.xml')
    expect(sub.categories).toEqual([{ id: 'user/-/label/Tech', label: 'Tech' }])
  })
})

// ---------------------------------------------------------------------------
// subscription/edit
// ---------------------------------------------------------------------------

describe('subscription/edit', () => {
  it('subscribes to a new feed', async () => {
    const res = await fetch('/reader/api/0/subscription/edit', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ ac: 'subscribe', s: 'feed/https://example.com/feed.xml' }),
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('OK')

    // Verify subscription was created
    const list = await fetch('/reader/api/0/subscription/list', { headers: authHeaders() })
    const body = await list.json() as { subscriptions: unknown[] }
    expect(body.subscriptions).toHaveLength(1)
  })

  it('unsubscribes from a feed', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'A1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res = await fetch('/reader/api/0/subscription/edit', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ ac: 'unsubscribe', s: `feed/${feedId}` }),
    })
    expect(res.status).toBe(200)

    const list = await fetch('/reader/api/0/subscription/list', { headers: authHeaders() })
    const body = await list.json() as { subscriptions: unknown[] }
    expect(body.subscriptions).toHaveLength(0)
  })

  it('edits subscription title and folder', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'A1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res = await fetch('/reader/api/0/subscription/edit', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ ac: 'edit', s: `feed/${feedId}`, t: 'My Custom Title', a: 'user/-/label/News' }),
    })
    expect(res.status).toBe(200)

    const list = await fetch('/reader/api/0/subscription/list', { headers: authHeaders() })
    const body = await list.json() as { subscriptions: Array<Record<string, unknown>> }
    expect(body.subscriptions[0].title).toBe('My Custom Title')
    expect(body.subscriptions[0].categories).toEqual([{ id: 'user/-/label/News', label: 'News' }])
  })
})

// ---------------------------------------------------------------------------
// stream/contents
// ---------------------------------------------------------------------------

describe('stream/contents', () => {
  it('returns items for reading-list stream', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res  = await fetch(
      '/reader/api/0/stream/contents?s=user/-/state/com.google/reading-list',
      { headers: authHeaders() },
    )
    const body = await res.json() as { items: Array<Record<string, unknown>> }

    expect(res.status).toBe(200)
    expect(body.items).toHaveLength(1)

    const item = body.items[0]
    expect(item.id).toMatch(/^tag:google\.com,2005:reader\/item\//)
    expect(item.title).toBe('Article 1')
    expect(item).toHaveProperty('summary')
    expect(item).toHaveProperty('origin')
    expect(item).toHaveProperty('categories')
    expect((item.categories as string[])).toContain('user/-/state/com.google/reading-list')
  })

  it('excludes read items when xt=com.google/read', async () => {
    const { feedId, itemId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    // Mark as read
    await fetch('/reader/api/0/edit-tag', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ i: `tag:google.com,2005:reader/item/${itemId}`, a: 'user/-/state/com.google/read' }),
    })

    const res  = await fetch(
      '/reader/api/0/stream/contents?s=user/-/state/com.google/reading-list&xt=user/-/state/com.google/read',
      { headers: authHeaders() },
    )
    const body = await res.json() as { items: unknown[] }
    expect(body.items).toHaveLength(0)
  })

  it('returns continuation token when more items exist', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
      publishedAt: Date.now() - 1000,
    })
    await subscribeUser('dev-user-id', feedId)

    // Seed a second item
    const db = getDb(env.DB)
    const itemId2 = await deriveItemId('https://example.com/a2')
    await db.insert(items).values({
      id: itemId2, feedId, title: 'Article 2',
      url: 'https://example.com/a2', content: '<p>2</p>',
      publishedAt: Date.now() - 2000, fetchedAt: Date.now(),
    })

    const res  = await fetch(
      '/reader/api/0/stream/contents?s=user/-/state/com.google/reading-list&n=1',
      { headers: authHeaders() },
    )
    const body = await res.json() as { items: unknown[]; continuation?: string }

    expect(body.items).toHaveLength(1)
    expect(body.continuation).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// stream/items/ids
// ---------------------------------------------------------------------------

describe('stream/items/ids', () => {
  it('returns itemRefs with id and timestampUsec', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res  = await fetch(
      '/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list',
      { headers: authHeaders() },
    )
    const body = await res.json() as { itemRefs: Array<{ id: string; timestampUsec: string }> }

    expect(res.status).toBe(200)
    expect(body.itemRefs).toHaveLength(1)
    expect(body.itemRefs[0]).toHaveProperty('id')
    expect(body.itemRefs[0]).toHaveProperty('timestampUsec')
    // timestampUsec must be a string representation of a number
    expect(Number(body.itemRefs[0].timestampUsec)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// edit-tag
// ---------------------------------------------------------------------------

describe('edit-tag', () => {
  it('marks an item as read', async () => {
    const { feedId, itemId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res = await fetch('/reader/api/0/edit-tag', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ i: `tag:google.com,2005:reader/item/${itemId}`, a: 'user/-/state/com.google/read' }),
    })
    expect(res.status).toBe(200)

    // Item should now be excluded from unread stream
    const stream = await fetch(
      '/reader/api/0/stream/contents?xt=user/-/state/com.google/read',
      { headers: authHeaders() },
    )
    const body = await stream.json() as { items: unknown[] }
    expect(body.items).toHaveLength(0)
  })

  it('marks an item as starred', async () => {
    const { feedId, itemId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    await fetch('/reader/api/0/edit-tag', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ i: `tag:google.com,2005:reader/item/${itemId}`, a: 'user/-/state/com.google/starred' }),
    })

    // Starred stream should contain the item
    const stream = await fetch(
      '/reader/api/0/stream/contents?s=user/-/state/com.google/starred',
      { headers: authHeaders() },
    )
    const body = await stream.json() as { items: Array<Record<string, unknown>> }
    expect(body.items).toHaveLength(1)
    expect((body.items[0].categories as string[])).toContain('user/-/state/com.google/starred')
  })

  it('accepts short item ID form (without tag prefix)', async () => {
    const { feedId, itemId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res = await fetch('/reader/api/0/edit-tag', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ i: itemId, a: 'user/-/state/com.google/read' }),
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// mark-all-as-read
// ---------------------------------------------------------------------------

describe('mark-all-as-read', () => {
  it('marks all items in reading-list as read', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res = await fetch('/reader/api/0/mark-all-as-read', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ s: 'user/-/state/com.google/reading-list' }),
    })
    expect(res.status).toBe(200)

    const stream = await fetch(
      '/reader/api/0/stream/contents?xt=user/-/state/com.google/read',
      { headers: authHeaders() },
    )
    const body = await stream.json() as { items: unknown[] }
    expect(body.items).toHaveLength(0)
  })

  it('marks all items in a specific feed as read', async () => {
    const { feedId } = await seedFeed({
      feedUrl: 'https://example.com/feed.xml',
      title: 'Feed',
      itemGuid: 'https://example.com/a1',
      itemTitle: 'Article 1',
    })
    await subscribeUser('dev-user-id', feedId)

    const res = await fetch('/reader/api/0/mark-all-as-read', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ s: `feed/${feedId}` }),
    })
    expect(res.status).toBe(200)
  })
})
