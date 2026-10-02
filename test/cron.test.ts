// Feed polling tests.
// Uses the real D1 from the Cloudflare vitest pool and faked FetchTransport
// so we exercise the full poll policy without real HTTP requests.

import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFeedPoller,
  type FeedPoller,
  type FeedToCheck,
  type FeedTransport,
  type PollAttemptContext,
  type PollObserver,
} from "../src/feed/poll";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import { cycleRuns, feeds, items, itemState, users } from "../src/db/schema";
import { deriveItemId } from "../src/lib/crypto";

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

let attemptNumber = 0;

/** Supplies a distinct logical attempt for existing FeedPoller behavior tests. */
function attemptContext(): PollAttemptContext {
  attemptNumber += 1;
  return {
    cycleRunId: "test-cycle",
    attemptId: `test-attempt-${attemptNumber}`,
  };
}

/** Keeps each test call on the public FeedPoller interface with execution context. */
function pollWithAttempt(
  poller: FeedPoller,
  feed: FeedToCheck,
  attempt = attemptContext(),
) {
  return poller.poll(feed, attempt);
}

async function seedFeed(feedUrl: string, title = "Test Feed") {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({ id: feedId, feedUrl, title, htmlUrl: null });
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

/** Runs the public weekly cleanup entry point with the requested Item policy. */
async function runWeeklyRetention(itemRetentionDays = "30"): Promise<void> {
  await worker.scheduled(
    { cron: "0 3 * * 1" } as ScheduledEvent,
    {
      ...env,
      ITEM_RETENTION_DAYS: itemRetentionDays,
    } as unknown as Env,
  );
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feed_poll_attempts");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM users");
  await getDb(env.DB).insert(cycleRuns).values({
    id: "test-cycle",
    ranAt: Date.now(),
  });
  attemptNumber = 0;
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
    lastSuccessfulPollAt: null,
    lastNewItemDiscoveredAt: null,
    initialBackloadCompletedAt: null,
    nextPollAt: null,
    consecutiveErrors: 0,
    checkIntervalMinutes: 30,
    ...overrides,
  });

  it("parses RSS and stores items", async () => {
    const transport = mockTransport(RSS_FEED);
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await pollWithAttempt(poller, feedRow({ id: feedId }));

    const db = getDb(env.DB);
    const stored = await db.select().from(items).all();

    expect(stored).toHaveLength(2);
    expect(stored.map((i) => i.title)).toContain("Article One");
    expect(stored.map((i) => i.title)).toContain("Article Two");
  });

  it("attributes new items to the first successful logical attempt", async () => {
    const now = 1_735_732_800_000;
    const transport: FeedTransport = {
      get: vi
        .fn()
        .mockImplementation(
          async () => new Response(RSS_FEED, { status: 200 }),
        ),
    };
    const poller = createFeedPoller(
      env.DB,
      transport,
      noopObserver(),
      () => now,
    );
    const feedId = await seedFeed("https://example.com/feed.xml");
    const db = getDb(env.DB);

    await db.insert(cycleRuns).values([
      {
        id: "cycle-first",
        ranAt: now,
        activeFeeds: 1,
        dueFeeds: 1,
        startedAt: now - 1,
        triggerReason: "scheduled",
        status: "running",
      },
      {
        id: "cycle-rediscovery",
        ranAt: now + 1,
        activeFeeds: 1,
        dueFeeds: 1,
        startedAt: now,
        triggerReason: "manual",
        status: "running",
      },
    ]);

    await pollWithAttempt(poller, feedRow({ id: feedId }), {
      cycleRunId: "cycle-first",
      attemptId: "attempt-first",
    });
    await pollWithAttempt(poller, feedRow({ id: feedId }), {
      cycleRunId: "cycle-rediscovery",
      attemptId: "attempt-rediscovery",
    });

    const attributedItems = await env.DB.prepare(
      "SELECT first_ingestion_attempt_id FROM items ORDER BY id",
    ).all();
    const attempts = await env.DB.prepare(
      `SELECT id, cycle_run_id, started_at, completed_at, outcome, new_items
       FROM feed_poll_attempts ORDER BY id`,
    ).all();

    expect(attributedItems.results).toEqual([
      { first_ingestion_attempt_id: "attempt-first" },
      { first_ingestion_attempt_id: "attempt-first" },
    ]);
    expect(attempts.results).toEqual([
      {
        id: "attempt-first",
        cycle_run_id: "cycle-first",
        started_at: now,
        completed_at: now,
        outcome: "new_items",
        new_items: 2,
      },
      {
        id: "attempt-rediscovery",
        cycle_run_id: "cycle-rediscovery",
        started_at: now,
        completed_at: now,
        outcome: "unchanged",
        new_items: 0,
      },
    ]);
  });

  it("parses Atom feeds", async () => {
    const transport = mockTransport(ATOM_FEED);
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://atom.example.com/feed.xml");

    await pollWithAttempt(
      poller,
      feedRow({ id: feedId, feedUrl: "https://atom.example.com/feed.xml" }),
    );

    const db = getDb(env.DB);
    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Atom Article");
  });

  it("skips parsing on 304 and records a successful check", async () => {
    const transport = mockTransport304();
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    const before = Date.now();
    await pollWithAttempt(poller, feedRow({ id: feedId, etag: "abc123" }));

    const db = getDb(env.DB);
    const row = await db
      .select({ lastSuccessfulPollAt: feeds.lastSuccessfulPollAt })
      .from(feeds)
      .get();

    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(0);

    expect(row?.lastSuccessfulPollAt).toBeGreaterThanOrEqual(before);
  });

  it("sends If-None-Match header when etag is stored", async () => {
    const getFn = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 304 }));
    const transport: FeedTransport = { get: getFn };
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");
    await getDb(env.DB)
      .update(feeds)
      .set({ etag: 'W/"abc123"' })
      .where(eq(feeds.id, feedId));

    await pollWithAttempt(poller, feedRow({ id: feedId, etag: 'W/"abc123"' }));

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
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await pollWithAttempt(poller, feedRow({ id: feedId }));

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
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");
    const row = feedRow({ id: feedId });

    await pollWithAttempt(poller, row);
    await pollWithAttempt(poller, row);

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
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await pollWithAttempt(poller, feedRow({ id: feedId }));

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
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    const result = await pollWithAttempt(poller, feedRow({ id: feedId }));
    expect(result.outcome).toBe("failed");

    const db = getDb(env.DB);
    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(0);
  });

  it("gates inserts after initial backload to prevent re-backloading purged items", async () => {
    const db = getDb(env.DB);

    // Old feed that was first polled 31 days ago (beyond retention)
    const lastPoll = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const feedId = await seedFeed("https://example.com/old-feed.xml");
    // Record a prior completed initial backload without inventing new-Item activity.
    await db
      .update(feeds)
      .set({ initialBackloadCompletedAt: lastPoll })
      .where(eq(feeds.id, feedId));

    // Transport returns the standard feed (two items from Jan 2024)
    const transport = mockTransport(RSS_FEED);
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );

    const result = await pollWithAttempt(
      poller,
      feedRow({
        id: feedId,
        feedUrl: "https://example.com/old-feed.xml",
        initialBackloadCompletedAt: lastPoll,
      }),
    );

    // The RSS items are from Jan 2024, before the backload window.
    // They should be filtered out by the backload gate.
    expect(result.outcome).toBe("unchanged");
    if (result.outcome === "unchanged") expect(result.newItems).toBe(0);

    const stored = await db.select().from(items).all();
    expect(stored).toHaveLength(0);
  });

  it("backs off on 429 without incrementing consecutive errors", async () => {
    const transport: FeedTransport = {
      get: vi.fn().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "180" },
        }),
      ),
    };
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    const result = await pollWithAttempt(poller, feedRow({ id: feedId }));
    expect(result.outcome).toBe("rate_limited");

    const db = getDb(env.DB);
    const row = await db
      .select({
        consecutiveErrors: feeds.consecutiveErrors,
        checkIntervalMinutes: feeds.checkIntervalMinutes,
        lastError: feeds.lastError,
        deactivatedAt: feeds.deactivatedAt,
      })
      .from(feeds)
      .get();

    expect(row?.consecutiveErrors).toBe(0);
    expect(row?.deactivatedAt).toBeNull();
    expect(row?.checkIntervalMinutes).toBe(60);
    expect(row?.lastError).toContain("429");
  });

  it("resets check interval when new items arrive", async () => {
    const transport = mockTransport(RSS_FEED);
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://example.com/feed.xml");

    await pollWithAttempt(
      poller,
      feedRow({ id: feedId, checkIntervalMinutes: 120 }),
    );

    const db = getDb(env.DB);
    const row = await db
      .select({ checkIntervalMinutes: feeds.checkIntervalMinutes })
      .from(feeds)
      .get();
    expect(row?.checkIntervalMinutes).toBe(30);
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
    lastSuccessfulPollAt: null,
    lastNewItemDiscoveredAt: null,
    initialBackloadCompletedAt: null,
    nextPollAt: null,
    consecutiveErrors: 0,
    checkIntervalMinutes: 30,
    ...overrides,
  });

  it("returns error result on network error", async () => {
    const transport: FeedTransport = {
      get: vi.fn().mockRejectedValueOnce(new Error("Network error")),
    };
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed(
      "https://bad.example.com/feed.xml",
      "Bad Feed",
    );

    const result = await pollWithAttempt(
      poller,
      feedRow({ id: feedId, feedUrl: "https://bad.example.com/feed.xml" }),
    );
    expect(result.outcome).toBe("failed");
  });

  it("deactivates after 5 transient errors", async () => {
    const transport = mockTransport("", 500);
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://bad.example.com/feed.xml");
    await getDb(env.DB)
      .update(feeds)
      .set({ consecutiveErrors: 4 })
      .where(eq(feeds.id, feedId));

    const result = await pollWithAttempt(
      poller,
      feedRow({
        id: feedId,
        feedUrl: "https://bad.example.com/feed.xml",
        consecutiveErrors: 4,
      }),
    );
    expect(result.outcome).toBe("failed");

    const db = getDb(env.DB);
    const row = await db
      .select({
        consecutiveErrors: feeds.consecutiveErrors,
        deactivatedAt: feeds.deactivatedAt,
        deactivationReason: feeds.deactivationReason,
        lastError: feeds.lastError,
      })
      .from(feeds)
      .get();
    expect(row?.consecutiveErrors).toBe(5);
    expect(row?.deactivatedAt).not.toBeNull();
    expect(row?.lastError).toContain("HTTP 500");
    expect(row?.deactivationReason).toBe("automatic_transient");
  });

  it("deactivates after 2 permanent errors", async () => {
    const transport = mockTransport("", 404);
    const poller = createFeedPoller(env.DB, transport, noopObserver(), () =>
      Date.now(),
    );
    const feedId = await seedFeed("https://gone.example.com/feed.xml");
    await getDb(env.DB)
      .update(feeds)
      .set({ consecutiveErrors: 1 })
      .where(eq(feeds.id, feedId));

    const result = await pollWithAttempt(
      poller,
      feedRow({
        id: feedId,
        feedUrl: "https://gone.example.com/feed.xml",
        consecutiveErrors: 1,
      }),
    );
    expect(result.outcome).toBe("failed");

    const db = getDb(env.DB);
    const row = await db
      .select({
        consecutiveErrors: feeds.consecutiveErrors,
        deactivatedAt: feeds.deactivatedAt,
        deactivationReason: feeds.deactivationReason,
        lastError: feeds.lastError,
      })
      .from(feeds)
      .get();
    expect(row?.consecutiveErrors).toBe(2);
    expect(row?.deactivatedAt).not.toBeNull();
    expect(row?.lastError).toContain("permanent");
    expect(row?.deactivationReason).toBe("automatic_permanent");
  });
});

// ---------------------------------------------------------------------------
// Weekly retention
// ---------------------------------------------------------------------------

describe("weekly retention", () => {
  it("preserves every User's Item State when any User starred an old Item", async () => {
    const now = Date.UTC(2026, 3, 6, 3);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await seedUser();
      const db = getDb(env.DB);
      await db.insert(users).values({
        id: "other-user",
        email: "other@example.com",
        createdAt: now,
      });
      const feedId = await seedFeed("https://example.com/shared-retained.xml");
      await db.insert(items).values({
        id: "shared-starred-item",
        feedId,
        title: "Shared saved Item",
        fetchedAt: now - 31 * 24 * 60 * 60 * 1000,
      });
      await db.insert(itemState).values([
        {
          itemId: "shared-starred-item",
          userId: "test-user",
          isRead: 1,
          isStarred: 0,
          readAt: now - 1,
        },
        {
          itemId: "shared-starred-item",
          userId: "other-user",
          isStarred: 1,
        },
      ]);

      await runWeeklyRetention();

      const stateRows = await db
        .select({
          userId: itemState.userId,
          isRead: itemState.isRead,
          isStarred: itemState.isStarred,
        })
        .from(itemState)
        .all();
      expect(stateRows).toEqual(
        expect.arrayContaining([
          { userId: "test-user", isRead: 1, isStarred: 0 },
          { userId: "other-user", isRead: 0, isStarred: 1 },
        ]),
      );
      expect(stateRows).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires operational history older than 90 days without deleting a starred Item", async () => {
    const now = Date.UTC(2026, 3, 6, 3);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await seedUser();
      const feedId = await seedFeed("https://example.com/retained.xml");
      const db = getDb(env.DB);
      const oldCycleRunAt = now - 91 * 24 * 60 * 60 * 1000;
      const boundaryCycleRunAt = now - 90 * 24 * 60 * 60 * 1000;
      await db.insert(cycleRuns).values([
        { id: "expired-cycle-run", ranAt: oldCycleRunAt },
        { id: "boundary-cycle-run", ranAt: boundaryCycleRunAt },
      ]);
      await env.DB.prepare(
        `INSERT INTO feed_poll_attempts
          (id, cycle_run_id, feed_id, started_at, completed_at, outcome, new_items)
         VALUES
          ('expired-attempt', 'expired-cycle-run', ?, ?, ?, 'new_items', 1),
          ('boundary-attempt', 'boundary-cycle-run', ?, ?, ?, 'unchanged', 0)`,
      )
        .bind(
          feedId,
          oldCycleRunAt,
          oldCycleRunAt,
          feedId,
          boundaryCycleRunAt,
          boundaryCycleRunAt,
        )
        .run();
      await db
        .update(feeds)
        .set({
          pollOwnerAttemptId: "expired-attempt",
          pollLeaseExpiresAt: oldCycleRunAt,
        })
        .where(eq(feeds.id, feedId));
      await db.insert(items).values({
        id: "retained-starred-item",
        feedId,
        title: "Retained",
        fetchedAt: oldCycleRunAt,
        firstIngestionAttemptId: "expired-attempt",
      });
      await db.insert(itemState).values({
        itemId: "retained-starred-item",
        userId: "test-user",
        isStarred: 1,
      });

      await runWeeklyRetention();

      const cycleRunRows = await db
        .select({ id: cycleRuns.id })
        .from(cycleRuns)
        .all();
      const retainedItem = await db
        .select({ attemptId: items.firstIngestionAttemptId })
        .from(items)
        .get();
      const retainedFeed = await db
        .select({
          ownerAttemptId: feeds.pollOwnerAttemptId,
          leaseExpiresAt: feeds.pollLeaseExpiresAt,
        })
        .from(feeds)
        .where(eq(feeds.id, feedId))
        .get();
      expect(cycleRunRows.map(({ id }) => id)).toContain("boundary-cycle-run");
      expect(cycleRunRows.map(({ id }) => id)).not.toContain(
        "expired-cycle-run",
      );
      expect(retainedItem?.attemptId).toBeNull();
      expect(retainedFeed).toEqual({
        ownerAttemptId: null,
        leaseExpiresAt: null,
      });
      const foreignKeyViolations = await env.DB.prepare(
        "PRAGMA foreign_key_check",
      ).all();
      expect(foreignKeyViolations.results).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Weekly Item retention
// ---------------------------------------------------------------------------

describe("weekly Item retention", () => {
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

    await runWeeklyRetention();

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

    await runWeeklyRetention();

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

    await runWeeklyRetention("7");

    const remaining = await db.select().from(items).all();
    expect(remaining).toHaveLength(0);
  });

  it("preserves starred items during purge", async () => {
    await seedUser();
    const feedId = await seedFeed("https://example.com/feed.xml");
    const db = getDb(env.DB);

    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;

    const starredId = await deriveItemId("https://example.com/starred");
    await db.insert(items).values({
      id: starredId,
      feedId,
      title: "Starred Old Article",
      url: "https://example.com/starred",
      content: "starred",
      fetchedAt: oldTime,
      publishedAt: oldTime,
    });
    await db.insert(itemState).values({
      itemId: starredId,
      userId: "test-user",
      isStarred: 1,
    });

    const unstarredId = await deriveItemId("https://example.com/unstarred");
    await db.insert(items).values({
      id: unstarredId,
      feedId,
      title: "Unstarred Old Article",
      url: "https://example.com/unstarred",
      content: "unstarred",
      fetchedAt: oldTime,
      publishedAt: oldTime,
    });
    await db.insert(itemState).values({
      itemId: unstarredId,
      userId: "test-user",
      isStarred: 0,
    });

    await runWeeklyRetention();

    const remaining = await db.select({ id: items.id }).from(items).all();
    const itemIds = remaining.map((r) => r.id);

    expect(itemIds).toContain(starredId);
    expect(itemIds).not.toContain(unstarredId);
  });
});
