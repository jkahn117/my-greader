// Feed attempt pagination limit validation at the authenticated HTTP seam.

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
  feedPollAttempts,
  feeds,
  subscriptions,
  users,
} from "../src/db/schema";

const BASE = "http://localhost";

type AttemptsPage = {
  attempts: { id: string }[];
  nextCursor: string | null;
};

async function attemptsPage(response: Response): Promise<AttemptsPage> {
  // SAFETY: The request targets the in-process route returning this page shape.
  return (await response.json()) as AttemptsPage;
}

// Exercise the dashboard API route in the Worker runtime, including deferred work.
async function fetchApi(path: string): Promise<Response> {
  const req = new Request(`${BASE}${path}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);

  return response;
}

// Create a subscribed Feed with ordered poll attempts for pagination assertions.
async function seedFeedWithAttempts(): Promise<string> {
  const db = getDb(env.DB);
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({
    id: feedId,
    feedUrl: `https://${feedId}.example.com/feed.xml`,
    title: "Test Feed",
  });
  await db.insert(subscriptions).values({
    id: crypto.randomUUID(),
    userId: "dev-user-id",
    feedId,
  });

  for (const [index, id] of ["attempt-3", "attempt-2", "attempt-1"].entries()) {
    const startedAt = 3000 - index * 1000;
    const cycleRunId = `run-${id}`;
    await db.insert(cycleRuns).values({ id: cycleRunId, ranAt: startedAt });
    await db.insert(feedPollAttempts).values({
      id,
      feedId,
      cycleRunId,
      startedAt,
      completedAt: startedAt + 100,
      outcome: "unchanged",
      httpStatus: 200,
      newItems: 0,
    });
  }

  return feedId;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feed_poll_attempts");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM users");
  await getDb(env.DB).insert(users).values({
    id: "dev-user-id",
    email: "dev@localhost",
    createdAt: 1,
  });
});

describe("GET /app/api/feeds/:feedId/attempts limit", () => {
  it.each(["0.5", "1.5", "0", "-1", "Infinity", "NaN", "abc"])(
    "rejects limit=%s with a controlled client error",
    async (limit) => {
      const feedId = await seedFeedWithAttempts();

      const response = await fetchApi(
        `/app/api/feeds/${feedId}/attempts?limit=${encodeURIComponent(limit)}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "limit must be a positive integer",
      });
    },
  );

  it("paginates valid positive integer limits and returns a continuation cursor", async () => {
    const feedId = await seedFeedWithAttempts();

    const firstResponse = await fetchApi(
      `/app/api/feeds/${feedId}/attempts?limit=2`,
    );

    expect(firstResponse.status).toBe(200);
    const firstPage = await attemptsPage(firstResponse);

    expect(firstPage.attempts.map((attempt) => attempt.id)).toEqual([
      "attempt-3",
      "attempt-2",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondResponse = await fetchApi(
      `/app/api/feeds/${feedId}/attempts?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );

    expect(secondResponse.status).toBe(200);
    const secondPage = await attemptsPage(secondResponse);

    expect(secondPage.attempts.map((attempt) => attempt.id)).toEqual([
      "attempt-1",
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
