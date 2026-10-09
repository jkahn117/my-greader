// Dashboard JSON API behavior tests — /app/api/* endpoints backed by D1.
// Asserts response shapes, user scoping, and window boundaries at the
// authenticated Worker request seam.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import {
  feeds,
  items,
  itemState,
  subscriptions,
  users,
} from "../src/db/schema";
import { deriveItemId } from "../src/lib/crypto";
import type { OverviewResponse } from "../src/shared/dashboard-api";

const BASE = "http://localhost";
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedUser(id: string, email: string) {
  const db = getDb(env.DB);
  await db.insert(users).values({ id, email, createdAt: Date.now() });
}

async function seedFeed(opts: {
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
    deactivatedAt: opts.deactivatedAt ?? null,
    consecutiveErrors: opts.consecutiveErrors ?? 0,
  });
  await db.insert(subscriptions).values({
    id: crypto.randomUUID(),
    userId: opts.userId ?? "dev-user-id",
    feedId,
  });
  return feedId;
}

async function seedItem(feedId: string, guid: string, fetchedAt: number) {
  const db = getDb(env.DB);
  const id = await deriveItemId(guid);
  await db.insert(items).values({
    id,
    feedId,
    title: guid,
    url: guid,
    fetchedAt,
    publishedAt: fetchedAt,
  });
  return id;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM users");
  await seedUser("dev-user-id", "dev@localhost");
});

describe("GET /app/api/overview", () => {
  it("returns user-scoped summary totals", async () => {
    const now = Date.now();
    const feedA = await seedFeed({
      feedUrl: "https://a.example.com/feed.xml",
      title: "Feed A",
    });
    const feedB = await seedFeed({
      feedUrl: "https://b.example.com/feed.xml",
      title: "Feed B",
      deactivatedAt: now - DAY_MS,
    });

    await seedItem(feedA, "https://a.example.com/1", now - DAY_MS);
    const recentItem = await seedItem(
      feedB,
      "https://b.example.com/1",
      now - 2 * DAY_MS,
    );
    // outside the 7-day window — must not count
    await seedItem(feedA, "https://a.example.com/old", now - 8 * DAY_MS);

    const db = getDb(env.DB);
    await db.insert(itemState).values([
      {
        itemId: recentItem,
        userId: "dev-user-id",
        isRead: 1,
        readAt: now - 1000,
      },
      {
        itemId: await deriveItemId("https://a.example.com/1"),
        userId: "dev-user-id",
        isRead: 1,
        readAt: now - 9 * DAY_MS, // stale receipt — outside window
      },
    ]);

    const res = await fetch("/app/api/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.feedCount).toBe(2);
    expect(body.activeFeedCount).toBe(1);
    expect(body.deactivatedFeedCount).toBe(1);
    // deactivated subscription still counts toward New Items
    expect(body.newItemsLast7Days).toBe(2);
    expect(body.markedReadLast7Days).toBe(1);
    expect(body.attention.total).toBe(1);
    expect(body.attention.autoDeactivated).toBe(1);
    expect(body.latestCycle.state).toBeDefined();
    expect(body.timezone).toBeTruthy();
  });

  it("excludes other users' feeds and items", async () => {
    const now = Date.now();
    await seedUser("other-user", "other@example.com");
    const otherFeed = await seedFeed({
      userId: "other-user",
      feedUrl: "https://other.example.com/feed.xml",
      title: "Other",
      deactivatedAt: now - DAY_MS,
      consecutiveErrors: 3,
    });
    const itemId = await seedItem(
      otherFeed,
      "https://other.example.com/1",
      now - DAY_MS,
    );
    const db = getDb(env.DB);
    await db.insert(itemState).values({
      itemId,
      userId: "other-user",
      isRead: 1,
      readAt: now - 1000,
    });

    const res = await fetch("/app/api/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewResponse;
    expect(body.feedCount).toBe(0);
    expect(body.newItemsLast7Days).toBe(0);
    expect(body.markedReadLast7Days).toBe(0);
    expect(body.attention.total).toBe(0);
  });

  it("counts feeds with persisted errors as needing attention", async () => {
    await seedFeed({
      feedUrl: "https://err.example.com/feed.xml",
      title: "Err",
      consecutiveErrors: 2,
    });
    const res = await fetch("/app/api/overview");
    const body = (await res.json()) as OverviewResponse;
    expect(body.attention.total).toBe(1);
    expect(body.attention.failing).toBe(1);
  });
});
