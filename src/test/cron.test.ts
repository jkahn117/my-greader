// Feed polling tests.
// Uses the real D1 from the Cloudflare vitest pool and faked FetchTransport
// so we exercise the full poll policy without real HTTP requests.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFeedPoller,
  type FeedTransport,
  type PollObserver,
} from "../feed/poll";
import { purgeOldItems } from "../handlers/cron";
import { getDb } from "../lib/db";
import { feeds, items, itemState, users } from "../db/schema";
import { deriveItemId } from "../lib/crypto";

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
</rss>`;

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
</feed>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTransport(
  xml: string,
  status = 200,
  responseHeaders: Record<string, string> = {},
): FeedTransport {
  return {
    get: vi
      .fn()
      .mockResolvedValue(
        new Response(xml, { status, headers: responseHeaders }),
      ),
  };
}

function mockTransport304(): FeedTransport {
  return {
    get: vi.fn().mockResolvedValue(new Response(null, { status: 304 })),
  };
}

function noopObserver(): PollObserver {
  return { publish: vi.fn() };
}

async function seedFeed(feedUrl: string, title = "Test Feed") {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db
    .insert(feeds)
    .values({ id: feedId, feedUrl, title, htmlUrl: null });
  return feedId;
}

async function seedUser() {
  const db = getDb(env.DB);
  await db.insert(users).values({
    id: "test-user",
    email: "test@example.com",
    createdAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM users");
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// FeedPoller
// ---------------------------------------------------------------------------

describe("FeedPoller", () => {
  const feedRow = (overrides: Record<string, unknown> = {}) => ({
    id: "",
    feedUrl: "https://example.com/feed.xml",
    title: null,
    htmlUrl: null,
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    consecutiveErrors: 0,
    checkIntervalMinutes: 30,
    lastNewItemAt: null,
    ...overrides,
  });

  it("parses RSS and stores items", async () => {
    const transport = mockTransport(RSS_FEED);
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await poller.poll(feedRow({ id: feedId }));

    const db = getDb(env.DB);
    const stored = await db.select().from(items).all();

    expect(stored).toHaveLength(2);
    expect(stored.map((i) => i.title)).toContain("Article One");
    expect(stored.map((i) => i.title)).toContain("Article Two");
  });

  it("parses Atom feeds", async () => {
    const transport = mockTransport(ATOM_FEED);
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://atom.example.com/feed.xml");

    await poller.poll(
      feedRow({ id: feedId, feedUrl: "https://atom.example.com/feed.xml" }),
    );

    const db = getDb(env.DB);
    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Atom Article");
  });

  it("skips parsing on 304 and updates lastFetchedAt", async () => {
    const transport = mockTransport304();
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    const before = Date.now();
    await poller.poll(feedRow({ id: feedId, etag: "abc123" }));

    const db = getDb(env.DB);
    const row = await db
      .select({ lastFetchedAt: feeds.lastFetchedAt })
      .from(feeds)
      .get();

    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(0);

    expect(row?.lastFetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("sends If-None-Match header when etag is stored", async () => {
    const getFn = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 304 }));
    const transport: FeedTransport = { get: getFn };
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await poller.poll(feedRow({ id: feedId, etag: 'W/"abc123"' }));

    expect(getFn).toHaveBeenCalledWith(
      "https://example.com/feed.xml",
      expect.objectContaining({ "If-None-Match": 'W/"abc123"' }),
    );
  });

  it("stores ETag and Last-Modified from response", async () => {
    const transport = mockTransport(RSS_FEED, 200, {
      ETag: 'W/"new-etag"',
      "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT",
    });
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await poller.poll(feedRow({ id: feedId }));

    const db = getDb(env.DB);
    const row = await db
      .select({ etag: feeds.etag, lastModified: feeds.lastModified })
      .from(feeds)
      .get();

    expect(row?.etag).toBe('W/"new-etag"');
    expect(row?.lastModified).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
  });

  it("does not insert duplicate items on second fetch", async () => {
    const transport: FeedTransport = {
      get: vi
        .fn()
        .mockResolvedValueOnce(new Response(RSS_FEED, { status: 200 }))
        .mockResolvedValueOnce(new Response(RSS_FEED, { status: 200 })),
    };
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");
    const row = feedRow({ id: feedId });

    await poller.poll(row);
    await poller.poll(row);

    const db = getDb(env.DB);
    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(2);
  });

  it("trims content exceeding 50KB", async () => {
    const bigContent = "x".repeat(60 * 1024);
    const bigFeed = `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Big Feed</title><link>https://example.com</link>
      <item>
        <title>Big Article</title>
        <link>https://example.com/big</link>
        <guid>https://example.com/big</guid>
        <description>${bigContent}</description>
      </item>
    </channel></rss>`;

    const transport = mockTransport(bigFeed);
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await poller.poll(feedRow({ id: feedId }));

    const db = getDb(env.DB);
    const stored = await db
      .select({ content: items.content })
      .from(items)
      .get();
    const bytes = new TextEncoder().encode(stored?.content ?? "").length;
    expect(bytes).toBeLessThanOrEqual(50 * 1024);
  });

  it("handles non-OK HTTP status gracefully without throwing", async () => {
    const transport = mockTransport("", 500);
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    const result = await poller.poll(feedRow({ id: feedId }));
    expect(result.status).toBe("error");

    const db = getDb(env.DB);
    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FeedPoller error handling
// ---------------------------------------------------------------------------

describe("FeedPoller error handling", () => {
  const feedRow = (overrides: Record<string, unknown> = {}) => ({
    id: "",
    feedUrl: "https://bad.example.com/feed.xml",
    title: null,
    htmlUrl: null,
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    consecutiveErrors: 0,
    checkIntervalMinutes: 30,
    lastNewItemAt: null,
    ...overrides,
  });

  it("returns error result on network error", async () => {
    const transport: FeedTransport = {
      get: vi.fn().mockRejectedValueOnce(new Error("Network error")),
    };
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => Date.now(),
    );
    const feedId = await seedFeed(
      "https://bad.example.com/feed.xml",
      "Bad Feed",
    );

    const result = await poller.poll(
      feedRow({ id: feedId, feedUrl: "https://bad.example.com/feed.xml" }),
    );
    expect(result.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// purgeOldItems
// ---------------------------------------------------------------------------

describe("purgeOldItems", () => {
  it("deletes items older than ITEM_RETENTION_DAYS", async () => {
    await seedUser();
    const feedId = await seedFeed("https://example.com/feed.xml");
    const db = getDb(env.DB);

    const oldItemId = await deriveItemId("https://example.com/old");
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await db.insert(items).values({
      id: oldItemId,
      feedId,
      title: "Old Article",
      url: "https://example.com/old",
      content: "old",
      fetchedAt: oldTime,
      publishedAt: oldTime,
    });

    const newItemId = await deriveItemId("https://example.com/new");
    await db.insert(items).values({
      id: newItemId,
      feedId,
      title: "New Article",
      url: "https://example.com/new",
      content: "new",
      fetchedAt: Date.now() - 86_400_000,
      publishedAt: Date.now(),
    });

    await purgeOldItems({
      ...env,
      ITEM_RETENTION_DAYS: "30",
    } as unknown as Env);

    const remaining = await db.select({ id: items.id }).from(items).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(newItemId);
  });

  it("deletes orphaned item_state rows before deleting items", async () => {
    await seedUser();
    const feedId = await seedFeed("https://example.com/feed.xml");
    const db = getDb(env.DB);

    const oldItemId = await deriveItemId("https://example.com/old2");
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await db.insert(items).values({
      id: oldItemId,
      feedId,
      title: "Old",
      url: "https://example.com/old2",
      content: "",
      fetchedAt: oldTime,
      publishedAt: oldTime,
    });
    await db
      .insert(itemState)
      .values({ itemId: oldItemId, userId: "test-user", isRead: 1 });

    await purgeOldItems({
      ...env,
      ITEM_RETENTION_DAYS: "30",
    } as unknown as Env);

    const stateRows = await db.select().from(itemState).all();
    const itemRows = await db.select().from(items).all();
    expect(stateRows).toHaveLength(0);
    expect(itemRows).toHaveLength(0);
  });

  it("respects ITEM_RETENTION_DAYS env var", async () => {
    await seedUser();
    const feedId = await seedFeed("https://example.com/feed.xml");
    const db = getDb(env.DB);

    const itemId = await deriveItemId("https://example.com/week-old");
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await db.insert(items).values({
      id: itemId,
      feedId,
      title: "Week Old",
      url: "https://example.com/week-old",
      content: "",
      fetchedAt: weekAgo,
      publishedAt: weekAgo,
    });

    await purgeOldItems({
      ...env,
      ITEM_RETENTION_DAYS: "7",
    } as unknown as Env);

    const remaining = await db.select().from(items).all();
    expect(remaining).toHaveLength(0);
  });
});
