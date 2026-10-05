// Reading metrics behavior tests — GET /app/api/reading backed by D1.
// Exercises the marked-read projection at the authenticated Worker request
// seam, including the GReader edit-tag writes that maintain read_at.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { zonedDays } from "../src/feed/reading";
import { getDb } from "../src/lib/db";
import {
  apiTokens,
  feeds,
  items,
  itemState,
  subscriptions,
  users,
} from "../src/db/schema";
import { deriveItemId, sha256 } from "../src/lib/crypto";
import { eq } from "drizzle-orm";
import type { ReadingResponse } from "../src/shared/dashboard-api";

const BASE = "http://localhost";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const TOKEN = "reading-test-token";
const USER = "dev-user-id";

async function fetch(
  path: string,
  init: RequestInit = {},
  vars: Record<string, string> = {},
): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...vars } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function reading(query = "", timezone = "UTC"): Promise<ReadingResponse> {
  const res = await fetch(
    `/app/api/reading${query}`,
    {},
    { DISPLAY_TIMEZONE: timezone },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ReadingResponse;
}

async function editTag(itemId: string, op: "a" | "r", tag: string) {
  const res = await fetch("/reader/api/0/edit-tag", {
    method: "POST",
    headers: {
      Authorization: `GoogleLogin auth=${TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ i: itemId, [op]: tag }).toString(),
  });
  expect(res.status).toBe(200);
}

const READ_TAG = "user/-/state/com.google/read";

async function seedFeed(opts: {
  title: string;
  userId?: string | null;
  deactivatedAt?: number;
}) {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({
    id: feedId,
    feedUrl: `https://${feedId}.example.com/feed.xml`,
    title: opts.title,
    deactivatedAt: opts.deactivatedAt ?? null,
  });
  if (opts.userId !== null) {
    await db.insert(subscriptions).values({
      id: crypto.randomUUID(),
      userId: opts.userId ?? USER,
      feedId,
    });
  }
  return feedId;
}

async function seedItem(feedId: string, fetchedAt = Date.now()) {
  const id = await deriveItemId(crypto.randomUUID());
  await getDb(env.DB).insert(items).values({
    id,
    feedId,
    title: id,
    url: id,
    fetchedAt,
    publishedAt: fetchedAt,
  });
  return id;
}

async function seedState(
  itemId: string,
  state: {
    readAt?: number | null;
    isRead?: number;
    isStarred?: number;
    userId?: string;
  },
) {
  await getDb(env.DB)
    .insert(itemState)
    .values({
      itemId,
      userId: state.userId ?? USER,
      isRead: state.isRead ?? (state.readAt != null ? 1 : 0),
      isStarred: state.isStarred ?? 0,
      readAt: state.readAt ?? null,
    });
}

function utcMidnight(ms: number) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

beforeEach(async () => {
  for (const table of [
    "item_state",
    "api_tokens",
    "subscriptions",
    "items",
    "feeds",
    "users",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  const db = getDb(env.DB);
  await db.insert(users).values([
    { id: USER, email: "dev@localhost", createdAt: 0 },
    { id: "other-user", email: "other@example.com", createdAt: 0 },
  ]);
  await db.insert(apiTokens).values({
    id: "reading-token",
    userId: USER,
    name: "Reading",
    tokenHash: await sha256(TOKEN),
    createdAt: 0,
  });
});

describe("GET /app/api/reading", () => {
  it("starts a midnight-gap date at its first existing local instant", () => {
    const days = zonedDays(
      Date.parse("2026-09-06T12:00:00Z"),
      2,
      "America/Santiago",
    );
    expect(days[1].start).toBe(Date.parse("2026-09-06T04:00:00Z"));
    expect(days[0].end).toBe(days[1].start);
    expect(days[1].end - days[1].start).toBe(23 * HOUR_MS);
  });

  it("validates the window and defaults to 7 days", async () => {
    const empty = await reading();
    expect(empty.days).toBe(7);
    expect(empty.daily).toHaveLength(7);
    expect(empty.markedRead).toBe(0);
    expect(empty.byFeed).toEqual([]);
    expect(empty.subscriptionCount).toBe(0);

    expect((await reading("?days=30")).daily).toHaveLength(30);
    for (const bad of ["10", "abc", "-7"]) {
      const res = await fetch(`/app/api/reading?days=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it("fills sparse dates with zero and keeps totals consistent", async () => {
    const now = Date.now();
    const today = utcMidnight(now);
    const feedA = await seedFeed({ title: "A" });
    const feedB = await seedFeed({ title: "B" });

    await seedState(await seedItem(feedA), { readAt: today });
    await seedState(await seedItem(feedA), {
      readAt: today - 3 * DAY_MS + HOUR_MS,
    });
    await seedState(await seedItem(feedB), {
      readAt: today - 3 * DAY_MS + 2 * HOUR_MS,
    });
    // first-day boundary is inclusive, the instant before it is outside
    await seedState(await seedItem(feedB), { readAt: today - 6 * DAY_MS });
    await seedState(await seedItem(feedB), { readAt: today - 6 * DAY_MS - 1 });

    const body = await reading("?days=7");
    expect(body.timezone).toBe("UTC");
    expect(body.windowStart).toBe(today - 6 * DAY_MS);
    expect(body.windowEnd).toBe(today + DAY_MS);
    expect(body.daily.map((d) => d.count)).toEqual([1, 0, 0, 2, 0, 0, 1]);
    expect(body.daily.map((d) => d.partial)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(body.daily[6].date).toBe(new Date(now).toISOString().slice(0, 10));
    expect(body.markedRead).toBe(4);
    // equal counts tie-break by title
    expect(body.byFeed.map((f) => [f.title, f.count])).toEqual([
      ["A", 2],
      ["B", 2],
    ]);
    expect(body.byFeed.reduce((s, f) => s + f.count, 0)).toBe(body.markedRead);

    // widening the window picks up the earlier receipt
    expect((await reading("?days=14")).markedRead).toBe(5);
  });

  it("buckets days by the configured display timezone", async () => {
    const now = Date.now();
    // Tokyo is UTC+9 with no DST: local midnight is 15:00 UTC.
    const tokyoMidnight = utcMidnight(now + 9 * HOUR_MS) - 9 * HOUR_MS;
    const feed = await seedFeed({ title: "Tz" });
    await seedState(await seedItem(feed), { readAt: tokyoMidnight - 1000 });
    await seedState(await seedItem(feed), {
      readAt: Math.min(now, tokyoMidnight + 1000),
    });

    const tokyo = await reading("?days=7", "Asia/Tokyo");
    expect(tokyo.timezone).toBe("Asia/Tokyo");
    expect(tokyo.windowEnd).toBe(tokyoMidnight + DAY_MS);
    expect(tokyo.daily.slice(-2).map((d) => d.count)).toEqual([1, 1]);
    expect(tokyo.daily[6].date).toBe(
      new Date(now + 9 * HOUR_MS).toISOString().slice(0, 10),
    );

    // in UTC both receipts fall on the same calendar day
    const utc = await reading("?days=7", "UTC");
    expect(utc.daily.filter((d) => d.count > 0).map((d) => d.count)).toEqual([
      2,
    ]);

    // an invalid configured zone falls back to UTC rather than failing
    const fallback = await reading("?days=7", "Not/AZone");
    expect(fallback.timezone).toBe("UTC");
  });

  it("uses the latest mark-read receipt and drops unread items", async () => {
    const feed = await seedFeed({ title: "Edits" });
    const reread = await seedItem(feed);
    const unread = await seedItem(feed);

    // stale earlier receipt outside the window, then a fresh mark-read
    await seedState(reread, { readAt: Date.now() - 20 * DAY_MS });
    expect((await reading()).markedRead).toBe(0);
    await editTag(reread, "a", READ_TAG);
    await editTag(reread, "a", READ_TAG);

    await editTag(unread, "a", READ_TAG);
    expect((await reading()).markedRead).toBe(2);
    await editTag(unread, "r", READ_TAG);

    const body = await reading();
    expect(body.markedRead).toBe(1);
    expect(body.daily[6].count).toBe(1);

    const [row] = await getDb(env.DB)
      .select()
      .from(itemState)
      .where(eq(itemState.itemId, unread));
    expect(row.isRead).toBe(0);
    expect(row.readAt).toBeNull();
  });

  it("stamps receipts for mark-all-as-read", async () => {
    const feed = await seedFeed({ title: "Bulk" });
    await seedItem(feed);
    await seedItem(feed);
    const res = await fetch("/reader/api/0/mark-all-as-read", {
      method: "POST",
      headers: {
        Authorization: `GoogleLogin auth=${TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        s: "user/-/state/com.google/reading-list",
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await reading()).markedRead).toBe(2);
  });

  it("scopes to the user's current subscriptions", async () => {
    const now = Date.now();
    const shared = await seedFeed({ title: "Shared" });
    await getDb(env.DB).insert(subscriptions).values({
      id: crypto.randomUUID(),
      userId: "other-user",
      feedId: shared,
    });
    const othersOnly = await seedFeed({
      title: "Others",
      userId: "other-user",
    });
    const unsubscribed = await seedFeed({ title: "Gone", userId: null });
    const dead = await seedFeed({ title: "Dead", deactivatedAt: now - DAY_MS });

    const sharedItem = await seedItem(shared);
    await seedState(sharedItem, {
      readAt: now - HOUR_MS,
      userId: "other-user",
    });
    await seedState(await seedItem(othersOnly), {
      readAt: now - HOUR_MS,
      userId: "other-user",
      isStarred: 1,
    });
    await seedState(await seedItem(unsubscribed), {
      readAt: now - HOUR_MS,
      isStarred: 1,
    });
    await seedState(await seedItem(dead), { readAt: now - HOUR_MS });

    const body = await reading();
    expect(body.subscriptionCount).toBe(2);
    expect(body.markedRead).toBe(1);
    expect(body.starredCount).toBe(0);
    expect(body.byFeed).toEqual([
      expect.objectContaining({ title: "Dead", deactivated: true, count: 1 }),
    ]);
  });

  it("counts retained starred items and reports starred separately", async () => {
    const now = Date.now();
    const feed = await seedFeed({ title: "Stars" });
    // fetched long before the retention cutoff but kept because it is starred
    const retained = await seedItem(feed, now - 120 * DAY_MS);
    await seedState(retained, { readAt: now - HOUR_MS, isStarred: 1 });
    // starred but unread: supporting metric only, never a marked-read count
    await seedState(await seedItem(feed), { isStarred: 1 });

    const body = await reading();
    expect(body.markedRead).toBe(1);
    expect(body.starredCount).toBe(2);
    expect(body.retentionDays).toBeGreaterThan(0);
  });
});
