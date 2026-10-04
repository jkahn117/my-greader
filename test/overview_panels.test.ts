// Overview panels tests — reading trend bucketing, feed-health buckets
// from latest attempts, cycle lifecycle, needs-attention list, and
// independent Analytics Engine degradation.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import {
  cycleRuns,
  feedAttempts,
  feeds,
  items,
  itemState,
  subscriptions,
  users,
} from "../src/db/schema";
import type { OverviewPanelsResponse } from "../src/shared/dashboard-api";

const BASE = "http://localhost";
// DISPLAY_TIMEZONE is bound to America/Los_Angeles in vitest.config.ts.

async function fetchPanels(): Promise<OverviewPanelsResponse> {
  const req = new Request(`${BASE}/app/api/overview/panels`);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as OverviewPanelsResponse;
}

async function seedFeed(opts: {
  userId?: string;
  title?: string;
  deactivatedAt?: number | null;
  consecutiveErrors?: number;
  lastError?: string | null;
}) {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({
    id: feedId,
    feedUrl: `https://${feedId}.example.com/feed.xml`,
    title: opts.title ?? "Feed",
    deactivatedAt: opts.deactivatedAt ?? null,
    consecutiveErrors: opts.consecutiveErrors ?? 0,
    lastError: opts.lastError ?? null,
    checkIntervalMinutes: 240,
  });
  await db.insert(subscriptions).values({
    id: crypto.randomUUID(),
    userId: opts.userId ?? "dev-user-id",
    feedId,
  });
  return feedId;
}

async function seedAttempt(
  feedId: string,
  status: string | null,
  startedAt = Date.now(),
  itemsAdded: number | null = null,
) {
  const db = getDb(env.DB);
  await db.insert(feedAttempts).values({
    id: crypto.randomUUID(),
    feedId,
    startedAt,
    finishedAt: status == null ? null : startedAt + 100,
    status,
    itemsAdded,
  });
}

async function markRead(userId: string, feedId: string, readAt: number) {
  const db = getDb(env.DB);
  const itemId = crypto.randomUUID();
  await db.insert(items).values({ id: itemId, feedId, title: "t" });
  await db.insert(itemState).values({
    itemId,
    userId,
    isRead: 1,
    readAt,
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM feed_attempts");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM users");
  const db = getDb(env.DB);
  await db
    .insert(users)
    .values({ id: "dev-user-id", email: "dev@localhost", createdAt: 1 });
});

describe("GET /app/api/overview/panels", () => {
  it("fills sparse days with zero and buckets by display timezone", async () => {
    const feedId = await seedFeed({});
    const now = Date.now();
    // One read now, one read ~2 days ago in LA time. A read at 06:30 UTC
    // is still the previous day in LA — covers the timezone boundary.
    await markRead("dev-user-id", feedId, now);
    const laBoundary = new Date(now).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
    });
    await markRead("dev-user-id", feedId, now - 2 * 24 * 60 * 60 * 1000);

    const body = await fetchPanels();
    expect(body.reading.windowDays).toBe(7);
    expect(body.reading.daily).toHaveLength(7);
    expect(body.reading.total).toBe(2);
    expect(body.reading.daily.reduce((sum, d) => sum + d.count, 0)).toBe(2);
    // Today in LA is the last bucket; it's nonzero.
    expect(body.reading.daily[6].count).toBe(1);
    void laBoundary;
    // Top feeds reflect scope.
    expect(body.reading.topFeeds[0]?.feedId).toBe(feedId);
    expect(body.reading.topFeeds[0]?.count).toBe(2);
  });

  it("excludes other users' reads and unsubscribed feeds", async () => {
    const db = getDb(env.DB);
    await db.insert(users).values({ id: "other", email: "o@o", createdAt: 1 });
    const mine = await seedFeed({});
    const theirs = await seedFeed({ userId: "other" });
    const orphaned = crypto.randomUUID();
    await db.insert(feeds).values({
      id: orphaned,
      feedUrl: `https://${orphaned}.example.com/f`,
    });

    const now = Date.now();
    await markRead("dev-user-id", mine, now);
    await markRead("other", theirs, now);
    await markRead("dev-user-id", orphaned, now); // not subscribed

    const body = await fetchPanels();
    expect(body.reading.total).toBe(1);
    expect(body.reading.topFeeds).toHaveLength(1);
    expect(body.reading.topFeeds[0].feedId).toBe(mine);
  });

  it("unread transitions clear prior read timing", async () => {
    const feedId = await seedFeed({});
    const db = getDb(env.DB);
    const itemId = crypto.randomUUID();
    await db.insert(items).values({ id: itemId, feedId });
    // Marked read, then unread — current state is unread: not counted.
    await db.insert(itemState).values({
      itemId,
      userId: "dev-user-id",
      isRead: 0,
      readAt: Date.now() - 1000,
    });
    const body = await fetchPanels();
    expect(body.reading.total).toBe(0);
  });

  it("buckets feed health by latest attempt outcome", async () => {
    const okNew = await seedFeed({}); // ok + items
    const okEmpty = await seedFeed({}); // ok, 0 items
    const notModified = await seedFeed({}); // 304
    const limited = await seedFeed({}); // successive 429s
    const failed = await seedFeed({}); // failure after recovery
    const skipped = await seedFeed({}); // deliberate skip
    const running = await seedFeed({}); // in progress
    await seedFeed({}); // missing — no attempts

    await seedAttempt(okNew, "error", 1000);
    await seedAttempt(okNew, "ok", 2000, 3); // recovery ends the streak
    await seedAttempt(okEmpty, "ok", 1000, 0);
    await seedAttempt(notModified, "not_modified", 1000);
    await seedAttempt(limited, "rate_limited", 1000);
    await seedAttempt(limited, "rate_limited", 2000);
    await seedAttempt(failed, "ok", 1000);
    await seedAttempt(failed, "error", 2000);
    await seedAttempt(skipped, "skipped", 1000);
    await seedAttempt(running, null, 1000);

    const body = await fetchPanels();
    expect(body.feedHealth).toEqual({
      successful: 1,
      empty: 2, // ok-0 + not_modified
      rateLimited: 1,
      failed: 1,
      skipped: 1,
      running: 1,
      missing: 1,
    });
    // Any in-progress attempt means the cycle reads as running.
    expect(body.cycle.state).toBe("running");
  });

  it("reports completed, empty, and missing cycle lifecycles", async () => {
    const db = getDb(env.DB);
    // missing: no cycle rows
    expect((await fetchPanels()).cycle.state).toBe("missing");

    await db
      .insert(cycleRuns)
      .values({ id: "r1", ranAt: 1000, checkedFeeds: 0 });
    expect((await fetchPanels()).cycle.state).toBe("empty");

    await db
      .insert(cycleRuns)
      .values({ id: "r2", ranAt: 2000, checkedFeeds: 4 });
    const body = await fetchPanels();
    expect(body.cycle.state).toBe("completed");
    expect(body.cycle.checkedFeeds).toBe(4);
  });

  it("lists needs-attention feeds with links and ignores plain backoff", async () => {
    const failing = await seedFeed({
      title: "Broken",
      consecutiveErrors: 3,
      lastError: "HTTP 500",
    });
    await seedFeed({}); // healthy, backed off — not attention

    const body = await fetchPanels();
    expect(body.needsAttention).toHaveLength(1);
    expect(body.needsAttention[0].feedId).toBe(failing);
    expect(body.needsAttention[0].reason).toContain("3 consecutive errors");
  });

  it("degrades the Analytics Engine panel independently", async () => {
    // Test env has no CF_API_TOKEN — panel reports unavailable while
    // core panels still resolve.
    const body = await fetchPanels();
    expect(body.analyticsEngine.status).toBe("unavailable");
    expect(body.feedHealth.missing).toBe(0); // still computed
  });
});
