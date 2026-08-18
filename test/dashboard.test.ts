// Management-route behavior tests (import, feed health, metrics).
// Asserts status and persisted state, not HTML layout.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
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
    expect(row?.consecutiveErrors).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.checkIntervalMinutes).toBe(30);
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
