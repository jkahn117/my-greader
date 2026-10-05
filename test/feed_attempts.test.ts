// Feed attempt history tests — pagination, ordering, streaks, problem
// groups, attribution, and honest history states through the request seam.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import {
  feedAttempts,
  feeds,
  items,
  subscriptions,
  users,
} from "../src/db/schema";
import type { FeedAttemptsResponse } from "../src/shared/dashboard-api";

const BASE = "http://localhost";

async function fetchApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const req = new Request(`${BASE}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedFeed(opts: {
  userId?: string;
  lastFetchedAt?: number | null;
}) {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({
    id: feedId,
    feedUrl: `https://${feedId}.example.com/feed.xml`,
    title: "Test Feed",
    lastFetchedAt: opts.lastFetchedAt ?? null,
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
  opts: {
    id?: string;
    startedAt: number;
    finishedAt?: number | null;
    status?: string | null;
    httpStatus?: number | null;
    errorKind?: string | null;
    errorMessage?: string | null;
    parserState?: string | null;
    itemsAdded?: number | null;
    cycleRunId?: string | null;
  },
) {
  const db = getDb(env.DB);
  const id = opts.id ?? crypto.randomUUID();
  await db.insert(feedAttempts).values({
    id,
    feedId,
    cycleRunId: opts.cycleRunId ?? "run-1",
    startedAt: opts.startedAt,
    finishedAt:
      opts.finishedAt === undefined ? opts.startedAt + 500 : opts.finishedAt,
    status: opts.status === undefined ? "ok" : opts.status,
    httpStatus: opts.httpStatus ?? 200,
    errorKind: opts.errorKind ?? null,
    errorMessage: opts.errorMessage ?? null,
    parserState: opts.parserState ?? "success",
    itemsAdded: opts.itemsAdded ?? null,
    durationMs: 500,
  });
  return id;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feed_attempts");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM users");
  const db = getDb(env.DB);
  await db
    .insert(users)
    .values({ id: "dev-user-id", email: "dev@localhost", createdAt: 1 });
});

describe("GET /app/api/feeds/:feedId/attempts", () => {
  it("returns attempts newest-first with diagnostics and items", async () => {
    const feedId = await seedFeed({ lastFetchedAt: 2000 });
    const a1 = await seedAttempt(feedId, {
      startedAt: 1000,
      itemsAdded: 2,
    });
    const a2 = await seedAttempt(feedId, {
      startedAt: 2000,
      status: "error",
      httpStatus: 500,
      errorKind: "http",
      errorMessage: "HTTP 500",
      parserState: "not_attempted",
    });
    const db = getDb(env.DB);
    await db.insert(items).values({
      id: "item-1",
      feedId,
      title: "Hello",
      url: "https://x.example/1",
      attemptId: a1,
    });

    const res = await fetchApi(`/app/api/feeds/${feedId}/attempts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FeedAttemptsResponse;

    expect(body.attempts.map((a) => a.id)).toEqual([a2, a1]);
    expect(body.attempts[0].status).toBe("error");
    expect(body.attempts[0].errorKind).toBe("http");
    expect(body.attempts[0].errorMessage).toBe("HTTP 500");
    expect(body.attempts[0].parserState).toBe("not_attempted");
    expect(body.attempts[1].items).toEqual([
      { id: "item-1", title: "Hello", url: "https://x.example/1" },
    ]);
    expect(body.historyState).toBe("ok");
    expect(body.nextCursor).toBeNull();
  });

  it("rejects attempts reads for feeds the user doesn't own", async () => {
    const db = getDb(env.DB);
    await db
      .insert(users)
      .values({ id: "someone-else", email: "x@x", createdAt: 1 });
    const otherFeed = await seedFeed({ userId: "someone-else" });
    const res = await fetchApi(`/app/api/feeds/${otherFeed}/attempts`);
    expect(res.status).toBe(404);
  });

  it("paginates with a stable order over tied timestamps", async () => {
    const feedId = await seedFeed({ lastFetchedAt: 10 });
    // Three attempts sharing one timestamp — id desc breaks the tie.
    await seedAttempt(feedId, { id: "a-1", startedAt: 1000 });
    await seedAttempt(feedId, { id: "a-3", startedAt: 1000 });
    await seedAttempt(feedId, { id: "a-2", startedAt: 1000 });

    const page1res = await fetchApi(
      `/app/api/feeds/${feedId}/attempts?limit=2`,
    );
    const page1 = (await page1res.json()) as FeedAttemptsResponse;
    expect(page1.attempts.map((a) => a.id)).toEqual(["a-3", "a-2"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2res = await fetchApi(
      `/app/api/feeds/${feedId}/attempts?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    const page2 = (await page2res.json()) as FeedAttemptsResponse;
    expect(page2.attempts.map((a) => a.id)).toEqual(["a-1"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("rejects an invalid cursor", async () => {
    const feedId = await seedFeed({});
    const res = await fetchApi(
      `/app/api/feeds/${feedId}/attempts?cursor=not-a-cursor`,
    );
    expect(res.status).toBe(400);
  });

  it("derives problem and rate-limit streaks from terminal checks", async () => {
    const feedId = await seedFeed({ lastFetchedAt: 10 });
    const t = 1000000;
    // Newest first: error, error, skipped (ignored), error? no — streak ends
    // at the first non-error terminal check.
    await seedAttempt(feedId, { startedAt: t, status: "error" });
    await seedAttempt(feedId, { startedAt: t - 1, status: "error" });
    await seedAttempt(feedId, { startedAt: t - 2, status: "skipped" });
    await seedAttempt(feedId, { startedAt: t - 3, status: "ok" });
    await seedAttempt(feedId, {
      startedAt: t - 4,
      status: null,
      finishedAt: null,
    });

    const res = await fetchApi(`/app/api/feeds/${feedId}/attempts`);
    const body = (await res.json()) as FeedAttemptsResponse;
    expect(body.streaks.problem.count).toBe(2);
    expect(body.streaks.problem.lowerBound).toBe(false);
    expect(body.streaks.rateLimited.count).toBe(0);
    // In-progress attempt is listed, not counted.
    expect(body.attempts.some((a) => a.status === "in_progress")).toBe(true);
  });

  it("recovery resets the streak; successive 429s form a rate-limit streak", async () => {
    const feedId = await seedFeed({ lastFetchedAt: 10 });
    const t = 1000000;
    await seedAttempt(feedId, {
      startedAt: t,
      status: "rate_limited",
      httpStatus: 429,
    });
    await seedAttempt(feedId, {
      startedAt: t - 1,
      status: "rate_limited",
      httpStatus: 429,
    });

    const res = await fetchApi(`/app/api/feeds/${feedId}/attempts`);
    const body = (await res.json()) as FeedAttemptsResponse;
    expect(body.streaks.rateLimited.count).toBe(2);
    expect(body.streaks.problem.count).toBe(0);
  });

  it("groups problems by kind over the labeled window", async () => {
    const feedId = await seedFeed({ lastFetchedAt: 10 });
    const now = Date.now();
    await seedAttempt(feedId, {
      startedAt: now - 1000,
      status: "error",
      errorKind: "http",
      errorMessage: "HTTP 500",
    });
    await seedAttempt(feedId, {
      startedAt: now - 2000,
      status: "error",
      errorKind: "http",
      errorMessage: "HTTP 503",
    });
    await seedAttempt(feedId, {
      startedAt: now - 3000,
      status: "error",
      errorKind: "network",
      errorMessage: "socket hangup",
    });
    // Outside the 30-day window — excluded.
    await seedAttempt(feedId, {
      startedAt: now - 40 * 24 * 60 * 60 * 1000,
      status: "error",
      errorKind: "parse",
      errorMessage: "old",
    });

    const res = await fetchApi(`/app/api/feeds/${feedId}/attempts`);
    const body = (await res.json()) as FeedAttemptsResponse;
    expect(body.problemGroups.windowDays).toBe(30);
    const byKind = Object.fromEntries(
      body.problemGroups.groups.map((g) => [g.kind, g]),
    );
    expect(byKind.http.count).toBe(2);
    expect(byKind.http.lastMessage).toBe("HTTP 500");
    expect(byKind.network.count).toBe(1);
    expect(byKind.parse).toBeUndefined();
  });

  it("distinguishes legacy and empty history from zero activity", async () => {
    const legacyFeed = await seedFeed({ lastFetchedAt: 12345 });
    const res1 = await fetchApi(`/app/api/feeds/${legacyFeed}/attempts`);
    expect(((await res1.json()) as FeedAttemptsResponse).historyState).toBe(
      "legacy",
    );

    const neverChecked = await seedFeed({});
    const res2 = await fetchApi(`/app/api/feeds/${neverChecked}/attempts`);
    const body = (await res2.json()) as FeedAttemptsResponse;
    expect(body.historyState).toBe("empty");
    expect(body.attempts).toEqual([]);
  });
});
