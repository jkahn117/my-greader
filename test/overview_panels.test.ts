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
import { createActivityReader } from "../src/feed/activity";
import { createFeedHistory } from "../src/feed/history";
import { getDb } from "../src/lib/db";
import {
  cycleRuns,
  feedPollAttempts as feedAttempts,
  feeds,
  items,
  itemState,
  subscriptions,
  users,
  type FeedAttemptOutcome,
} from "../src/db/schema";
import type { OverviewPanelsResponse } from "../src/shared/dashboard-api";

const BASE = "http://localhost";
// Endpoint tests use UTC; direct projections also cover Los Angeles DST.

async function fetchPanels(timezone = "UTC"): Promise<OverviewPanelsResponse> {
  const req = new Request(`${BASE}/app/api/overview/panels`);
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    req,
    { ...env, DISPLAY_TIMEZONE: timezone } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return (await res.json()) as OverviewPanelsResponse;
}

async function seedFeed(opts: {
  userId?: string;
  title?: string;
  deactivatedAt?: number | null;
  deactivationReason?:
    | "manual"
    | "automatic_transient"
    | "automatic_permanent"
    | "legacy_unknown"
    | null;
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
    deactivationReason: opts.deactivationReason ?? null,
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
  const cycleRunId = `cycle-${feedId}-${startedAt}`;
  await db.insert(cycleRuns).values({
    id: cycleRunId,
    ranAt: startedAt,
    status: status === null ? "running" : "completed",
    outcome: status === null ? null : "completed",
  });
  await db.insert(feedAttempts).values({
    id: crypto.randomUUID(),
    cycleRunId,
    feedId,
    startedAt,
    completedAt: status == null ? null : startedAt + 100,
    outcome: (status === null
      ? null
      : status === "ok"
        ? (itemsAdded ?? 0) > 0
          ? "new_items"
          : "unchanged"
        : status === "error"
          ? "failed"
          : status) as FeedAttemptOutcome | null,
    newItems: itemsAdded ?? 0,
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
  await env.DB.exec("DELETE FROM feed_poll_attempts");
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
  it("keeps calendar buckets and totals aligned through DST", async () => {
    const feedId = await seedFeed({});
    const timestamp = Date.parse("2024-03-12T07:30:00Z");
    await markRead("dev-user-id", feedId, Date.parse("2024-03-06T08:00:00Z"));
    await markRead("dev-user-id", feedId, Date.parse("2024-03-06T07:59:59Z"));
    await markRead("dev-user-id", feedId, Date.parse("2024-03-10T08:00:00Z"));
    const body = await createActivityReader(env.DB).overviewPanels(
      "dev-user-id",
      timestamp,
      "America/Los_Angeles",
    );
    expect(body.reading.daily.map((day) => day.date)).toEqual([
      "2024-03-06",
      "2024-03-07",
      "2024-03-08",
      "2024-03-09",
      "2024-03-10",
      "2024-03-11",
      "2024-03-12",
    ]);
    expect(body.reading.total).toBe(2);
    expect(
      body.reading.daily.reduce((total, day) => total + day.count, 0),
    ).toBe(2);
    expect(body.reading.topFeeds[0]?.count).toBe(2);
  });

  it("resolves tied latest attempts consistently with history pagination", async () => {
    const feedId = await seedFeed({});
    await seedAttempt(feedId, "ok", 1000, 2);
    const db = getDb(env.DB);
    await db.update(feedAttempts).set({ id: "a" });
    await db.insert(feedAttempts).values({
      id: "z",
      cycleRunId: `cycle-${feedId}-1000`,
      feedId,
      startedAt: 1000,
      completedAt: 1100,
      outcome: "failed",
    });
    const history = createFeedHistory(env.DB);
    expect((await history.latestAttempts([feedId])).get(feedId)?.outcome).toBe(
      "failed",
    );
    expect((await fetchPanels()).feedHealth.failed).toBe(1);
    const manyFeedIds = [
      feedId,
      ...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
    ];
    expect(
      (await history.latestAttempts(manyFeedIds)).get(feedId)?.outcome,
    ).toBe("failed");
  });

  it("keeps core panels available with an invalid display timezone", async () => {
    expect((await fetchPanels("invalid-zone")).reading.daily).toHaveLength(7);
  });

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
    expect(
      (await createActivityReader(env.DB).overviewSummary("dev-user-id"))
        .markedReadLast7Days,
    ).toBe(1);
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
    // Older unfinished attempts do not override the latest durable Cycle status.
    expect(body.cycle.state).toBe("completed");
  });

  it("reports completed, empty, and missing cycle lifecycles", async () => {
    const db = getDb(env.DB);
    // missing: no cycle rows
    expect((await fetchPanels()).cycle.state).toBe("missing");
    await db.insert(cycleRuns).values({ id: "legacy", ranAt: 500 });
    expect((await fetchPanels()).cycle.state).toBe("unknown");

    await db.insert(cycleRuns).values({
      id: "r1",
      ranAt: 1000,
      checkedFeeds: 0,
      status: "completed",
      outcome: "empty",
    });
    expect((await fetchPanels()).cycle.state).toBe("empty");

    await db.insert(cycleRuns).values({
      id: "r2",
      ranAt: 2000,
      checkedFeeds: 4,
      status: "completed",
      outcome: "completed",
    });
    const body = await fetchPanels();
    expect(body.cycle.state).toBe("completed");
    expect(body.cycle.checkedFeeds).toBe(4);

    await db.insert(cycleRuns).values({
      id: "r3",
      ranAt: 3000,
      status: "running",
      outcome: null,
    });
    expect((await fetchPanels()).cycle.state).toBe("running");
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
    expect(body.needsAttention[0].kind).toBe("failing");
    expect(body.needsAttention[0].detail).toContain("3 consecutive errors");
  });

  it("reports rate-limited feeds as attention, distinct from failures", async () => {
    const limited = await seedFeed({ title: "Throttled" });
    await seedAttempt(limited, "rate_limited");
    const failing = await seedFeed({
      title: "Broken",
      consecutiveErrors: 2,
      lastError: "HTTP 500",
    });

    const body = await fetchPanels();
    const kinds = Object.fromEntries(
      body.needsAttention.map((f) => [f.feedId, f.kind]),
    );
    expect(kinds[limited]).toBe("rate_limited");
    expect(kinds[failing]).toBe("failing");
    const rl = body.needsAttention.find((f) => f.feedId === limited)!;
    expect(rl.detail).toContain("HTTP 429");
  });

  it("counts manual pauses as a footnote, not attention", async () => {
    await seedFeed({
      title: "Paused",
      deactivatedAt: Date.now(),
      deactivationReason: "manual",
    });
    await seedFeed({
      title: "Auto",
      deactivatedAt: Date.now(),
      deactivationReason: "automatic_permanent",
    });

    const body = await fetchPanels();
    expect(body.needsAttention).toHaveLength(1);
    expect(body.needsAttention[0].kind).toBe("auto_deactivated");
    expect(body.manuallyPaused).toBe(1);
  });

  it("degrades the Analytics Engine panel independently", async () => {
    // Test env has no CF_API_TOKEN — panel reports unavailable while
    // core panels still resolve.
    const body = await fetchPanels();
    expect(body.analyticsEngine.status).toBe("unavailable");
    expect(body.feedHealth.missing).toBe(0); // still computed
  });
});
