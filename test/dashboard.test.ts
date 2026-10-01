// Management-route behavior tests (import, feed health, metrics).
// Asserts status and persisted state, not HTML layout.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import {
  cycleRuns,
  feeds,
  items,
  itemState,
  subscriptions,
  users,
} from "../src/db/schema";
import { deriveItemId } from "../src/lib/crypto";
import {
  createFeedPoller,
  type FeedToCheck,
  type FeedTransport,
} from "../src/feed/poll";

const BASE = "http://localhost";

async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedUser(id = "dev-user-id", email = "dev@localhost") {
  const db = getDb(env.DB);
  await db.insert(users).values({ id, email, createdAt: Date.now() });
}

async function seedFeedAndSub(opts: {
  userId?: string;
  feedUrl: string;
  title: string;
  deactivatedAt?: number | null;
  consecutiveErrors?: number;
}) {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({
    id: feedId,
    feedUrl: opts.feedUrl,
    title: opts.title,
    htmlUrl: `https://${new URL(opts.feedUrl).hostname}`,
    deactivatedAt: opts.deactivatedAt ?? null,
    consecutiveErrors: opts.consecutiveErrors ?? 0,
    lastError: opts.deactivatedAt ? "HTTP 404 (permanent)" : null,
    checkIntervalMinutes: 240,
  });
  await db.insert(subscriptions).values({
    id: crypto.randomUUID(),
    userId: opts.userId ?? "dev-user-id",
    feedId,
    folder: null,
  });
  return feedId;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feed_poll_attempts");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM users");
  await seedUser();
});

describe("POST /import", () => {
  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test</title></head>
  <body>
    <outline text="Tech">
      <outline type="rss" text="Tech Blog" xmlUrl="https://tech.example.com/feed.xml"/>
    </outline>
    <outline type="rss" text="Unfiled" xmlUrl="https://unfiled.example.com/feed.xml"/>
  </body>
</opml>`;

  it("creates subscriptions and folders from OPML", async () => {
    const form = new FormData();
    form.set("opml", new File([opml], "feeds.opml", { type: "text/xml" }));

    const res = await fetch("/import", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("feeds imported");
    expect(html).toContain(">2</span>");

    const db = getDb(env.DB);
    const subs = await db.select().from(subscriptions).all();
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.folder).sort()).toEqual(["Tech", null].sort());
  });

  it("counts already-subscribed feeds as duplicates", async () => {
    await seedFeedAndSub({
      feedUrl: "https://tech.example.com/feed.xml",
      title: "Tech Blog",
    });

    const form = new FormData();
    form.set("opml", new File([opml], "feeds.opml", { type: "text/xml" }));

    const res = await fetch("/import", { method: "POST", body: form });
    const html = await res.text();
    expect(html).toContain("feed imported");
    expect(html).toContain("duplicate skipped");
  });

  it("rejects an empty upload", async () => {
    const form = new FormData();
    form.set(
      "opml",
      new File(
        [`<?xml version="1.0"?><opml version="2.0"><body/></opml>`],
        "empty.opml",
        { type: "text/xml" },
      ),
    );

    const res = await fetch("/import", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No feeds found");
  });
});

describe("feed deactivate / reactivate", () => {
  it("deactivates a subscribed feed", async () => {
    const feedId = await seedFeedAndSub({
      feedUrl: "https://example.com/feed.xml",
      title: "Example",
    });

    const res = await fetch(`/feeds/${feedId}/deactivate`, { method: "POST" });
    expect(res.status).toBe(200);

    const db = getDb(env.DB);
    const row = await db.select().from(feeds).where(eq(feeds.id, feedId)).get();
    expect(row?.deactivatedAt).not.toBeNull();
    expect(row?.deactivationReason).toBe("manual");
  });

  it("reactivates and clears error state", async () => {
    const feedId = await seedFeedAndSub({
      feedUrl: "https://example.com/feed.xml",
      title: "Example",
      deactivatedAt: Date.now(),
      consecutiveErrors: 5,
    });

    const res = await fetch(`/feeds/${feedId}/reactivate`, { method: "POST" });
    expect(res.status).toBe(200);

    const db = getDb(env.DB);
    const row = await db.select().from(feeds).where(eq(feeds.id, feedId)).get();
    expect(row?.deactivatedAt).toBeNull();
    expect(row?.deactivationReason).toBeNull();
    expect(row?.consecutiveErrors).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.checkIntervalMinutes).toBe(30);
  });

  it("shows explicit and uncertain legacy Feed state without conflating events", async () => {
    const now = 1_735_732_800_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const explicitFeedId = await seedFeedAndSub({
      feedUrl: "https://state.example/feed.xml",
      title: "Explicit State Feed",
      deactivatedAt: now,
    });
    const legacyFeedId = await seedFeedAndSub({
      feedUrl: "https://legacy-state.example/feed.xml",
      title: "Uncertain Legacy Feed",
      deactivatedAt: now - 10_000,
    });
    const db = getDb(env.DB);
    await db
      .update(feeds)
      .set({
        lastSuccessfulPollAt: now - 2 * 60_000,
        lastNewItemDiscoveredAt: now - 60_000,
        initialBackloadCompletedAt: now - 2 * 60_000,
        nextPollAt: now + 60_000,
        deactivationReason: "automatic_permanent",
      })
      .where(eq(feeds.id, explicitFeedId));
    await db
      .update(feeds)
      .set({
        pollStateOrigin: "legacy_uncertain",
        lastSuccessfulPollAt: null,
        lastNewItemDiscoveredAt: null,
        initialBackloadCompletedAt: null,
        deactivationReason: "legacy_unknown",
      })
      .where(eq(feeds.id, legacyFeedId));

    const res = await fetch("/app/feeds");
    const html = await res.text();

    expect(html).toContain("Last successful check");
    expect(html).toContain("1m ago");
    expect(html).toContain("No new Items recorded");
    expect(html).toContain("Initial backload complete");
    expect(html).toContain("Initial backload unknown");
    expect(html).not.toContain("Initial backload pending");
    expect(html).toContain("Next eligible");
    expect(html).toContain("Permanent polling errors");
    expect(html).toContain("Legacy reason unknown");
  });

  it("returns 404 for a feed the user does not own", async () => {
    await seedUser("other-user", "other@example.com");
    const feedId = await seedFeedAndSub({
      userId: "other-user",
      feedUrl: "https://other.example.com/feed.xml",
      title: "Other",
    });

    const res = await fetch(`/feeds/${feedId}/deactivate`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("GET /app/timeline", () => {
  it("shows empty, interrupted, and failed durable outcomes without Analytics Engine", async () => {
    const feedId = await seedFeedAndSub({
      feedUrl: "https://failed.example/feed.xml",
      title: "Failed Feed",
    });
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cycle_runs
          (id, ran_at, active_feeds, due_feeds, selected_feeds, checked_feeds,
           new_items, failed_feeds, skipped_feeds, started_at, completed_at,
           trigger_reason, status, outcome)
         VALUES (?, ?, 1, 0, 0, 0, 0, 0, 0, ?, ?, 'scheduled', 'completed', 'empty')`,
      ).bind("empty-cycle", now - 2, now - 2, now - 2),
      env.DB.prepare(
        `INSERT INTO cycle_runs
          (id, ran_at, active_feeds, due_feeds, selected_feeds, checked_feeds,
           new_items, failed_feeds, skipped_feeds, started_at, trigger_reason, status)
         VALUES (?, ?, 1, 1, 1, 0, 0, 0, 0, ?, 'forced', 'running')`,
      ).bind("interrupted-cycle", now, now),
      env.DB.prepare(
        `INSERT INTO feed_poll_attempts
          (id, cycle_run_id, feed_id, started_at, completed_at, outcome,
           new_items, error_class, http_status, parser_status, diagnostic)
         VALUES (?, ?, ?, ?, ?, 'failed', 0, 'http', 503, 'not_attempted', ?)`,
      ).bind(
        "failed-attempt",
        "interrupted-cycle",
        feedId,
        now,
        now + 1,
        "HTTP 503",
      ),
    ]);

    const res = await fetch("/app/timeline");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No eligible Feeds");
    expect(html).toContain("In progress");
    expect(html).toContain("Failed Feed");
    expect(html).toContain("HTTP failure");
    expect(html).toContain("HTTP 503");
    expect(html).toContain("1 selected");
  });

  it("links attributed Items through attempts while preserving User visibility", async () => {
    const visibleFeedId = await seedFeedAndSub({
      feedUrl: "https://visible.example/feed.xml",
      title: "Visible Feed",
    });
    await seedUser("other-user", "other@example.com");
    const otherFeedId = await seedFeedAndSub({
      userId: "other-user",
      feedUrl: "https://other.example/feed.xml",
      title: "Other Feed",
    });
    const db = getDb(env.DB);
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cycle_runs
          (id, ran_at, active_feeds, due_feeds, checked_feeds, new_items,
           failed_feeds, started_at, completed_at, trigger_reason, status)
         VALUES (?, ?, 2, 2, 2, 2, 0, ?, ?, 'scheduled', 'completed')`,
      ).bind("workflow-cycle", now, now - 5_000, now),
      env.DB.prepare(
        `INSERT INTO cycle_runs
          (id, ran_at, active_feeds, due_feeds, checked_feeds, new_items,
           failed_feeds)
         VALUES (?, ?, 1, 1, 1, 1, 0)`,
      ).bind("legacy-cycle", now - 1),
    ]);

    const transport: FeedTransport = {
      async get(url) {
        const visible = url.includes("visible.example");
        const title = visible
          ? "Visible attributed Item"
          : "Other User private Item";
        const itemUrl = visible
          ? "https://visible.example/attributed"
          : "https://other.example/private";
        return new Response(`<?xml version="1.0"?><rss version="2.0"><channel>
          <title>Test Feed</title><link>${url}</link><item>
          <title>${title}</title><link>${itemUrl}</link><guid>${itemUrl}</guid>
          <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
          </item></channel></rss>`);
      },
    };
    const poller = createFeedPoller(
      env.DB,
      transport,
      { publish() {} },
      () => now,
    );
    const [visibleFeed, otherFeed] = await Promise.all([
      db.select().from(feeds).where(eq(feeds.id, visibleFeedId)).get(),
      db.select().from(feeds).where(eq(feeds.id, otherFeedId)).get(),
    ]);
    expect(visibleFeed).toBeDefined();
    expect(otherFeed).toBeDefined();

    await poller.poll(visibleFeed as FeedToCheck, {
      cycleRunId: "workflow-cycle",
      attemptId: "visible-attempt",
    });
    await poller.poll(otherFeed as FeedToCheck, {
      cycleRunId: "workflow-cycle",
      attemptId: "other-attempt",
    });

    await db.insert(items).values({
      id: await deriveItemId("https://visible.example/legacy"),
      feedId: visibleFeedId,
      title: "Legacy timestamp match",
      url: "https://visible.example/legacy",
      fetchedAt: now,
      publishedAt: now,
    });

    const res = await fetch("/app/timeline");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Visible attributed Item");
    expect(html).toContain("scheduled");
    expect(html).toContain("workflow-cycle");
    expect(html).toContain("+2 articles");
    expect(html).toContain("Historical Items remain unattributed.");
    expect(html).not.toContain("Legacy timestamp match");
    expect(html).not.toContain("Other User private Item");
  });
});

describe("GET /app/metrics", () => {
  it("renders D1-backed counts from seeded cycle and read data", async () => {
    const feedId = await seedFeedAndSub({
      feedUrl: "https://example.com/feed.xml",
      title: "Example Feed",
    });
    const db = getDb(env.DB);
    const now = Date.now();

    await db.insert(cycleRuns).values({
      id: String(now),
      ranAt: now,
      activeFeeds: 4,
      dueFeeds: 3,
      checkedFeeds: 3,
      newItems: 12,
      failedFeeds: 1,
    });

    const recentId = await deriveItemId("https://example.com/recent");
    const oldId = await deriveItemId("https://example.com/old");
    await db.insert(items).values([
      {
        id: recentId,
        feedId,
        title: "Recent",
        url: "https://example.com/recent",
        content: "r",
        fetchedAt: now - 86_400_000,
        publishedAt: now,
      },
      {
        id: oldId,
        feedId,
        title: "Old",
        url: "https://example.com/old",
        content: "o",
        fetchedAt: now - 14 * 86_400_000,
        publishedAt: now - 14 * 86_400_000,
      },
    ]);
    await db.insert(itemState).values({
      itemId: recentId,
      userId: "dev-user-id",
      isRead: 1,
      readAt: now - 3_600_000,
    });

    const res = await fetch("/app/metrics");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Total articles");
    expect(html).toContain("2");
    expect(html).toContain("New this week");
    expect(html).toContain("1");
    expect(html).toContain("Reads (7d)");
    expect(html).toContain("+12");
    expect(html).toContain("Example Feed");
  });
});
