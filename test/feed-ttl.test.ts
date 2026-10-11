import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cycleRuns, feeds } from "../src/db/schema";
import { createFeedPoller, type FeedToCheck } from "../src/feed/poll";
import { getDb } from "../src/lib/db";

const POLLED_AT = Date.UTC(2024, 5, 1, 12);

const RSS_WITH_LONG_TTL = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Long TTL Feed</title><link>https://example.com</link><ttl>360</ttl>
</channel></rss>`;

/** Creates the public poll input using the persisted Feed state. */
async function loadFeed(feedId: string): Promise<FeedToCheck> {
  const feed = await getDb(env.DB)
    .select()
    .from(feeds)
    .where(eq(feeds.id, feedId))
    .get();

  if (!feed) throw new Error(`Feed ${feedId} was not created`);

  return feed;
}

/** Seeds a Feed and a durable Cycle Run for one poll attempt. */
async function seedPoll(
  feedId: string,
  cycleRunId: string,
  checkIntervalMinutes = 30,
) {
  await getDb(env.DB)
    .insert(feeds)
    .values({
      id: feedId,
      feedUrl: `https://${feedId}.example/feed.xml`,
      etag: '"known"',
      checkIntervalMinutes,
    });
  await getDb(env.DB).insert(cycleRuns).values({
    id: cycleRunId,
    ranAt: POLLED_AT,
    startedAt: POLLED_AT,
    triggerReason: "scheduled",
    status: "running",
  });
}

/** Starts one Feed poll with a controlled response and completion timestamp. */
async function poll(
  feedId: string,
  cycleRunId: string,
  attemptId: string,
  response: Response,
  completedAt: number,
): Promise<void> {
  const poller = createFeedPoller(
    env.DB,
    { get: async () => response },
    { publish() {} },
    () => completedAt,
  );

  await poller.poll(await loadFeed(feedId), { cycleRunId, attemptId });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feed_poll_attempts");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM cycle_runs");
});

describe("Feed TTL polling intervals", () => {
  it("retains a long parsed TTL interval and schedules the next poll accordingly after 304", async () => {
    await seedPoll("long-ttl", "cycle-long-ttl-first");
    const parsedAt = POLLED_AT;
    const unchangedAt = POLLED_AT + 60 * 60 * 1000;

    await poll(
      "long-ttl",
      "cycle-long-ttl-first",
      "attempt-long-ttl-first",
      new Response(RSS_WITH_LONG_TTL),
      parsedAt,
    );
    await getDb(env.DB).insert(cycleRuns).values({
      id: "cycle-long-ttl-304",
      ranAt: unchangedAt,
      startedAt: unchangedAt,
      triggerReason: "scheduled",
      status: "running",
    });
    await poll(
      "long-ttl",
      "cycle-long-ttl-304",
      "attempt-long-ttl-304",
      new Response(null, { status: 304 }),
      unchangedAt,
    );

    const stored = await getDb(env.DB)
      .select({
        checkIntervalMinutes: feeds.checkIntervalMinutes,
        nextPollAt: feeds.nextPollAt,
      })
      .from(feeds)
      .where(eq(feeds.id, "long-ttl"))
      .get();

    expect(stored).toEqual({
      checkIntervalMinutes: 360,
      nextPollAt: unchangedAt + 360 * 60 * 1000,
    });
  });

  it("continues ordinary Backoff growth after a 304", async () => {
    await seedPoll("ordinary", "cycle-ordinary", 30);

    await poll(
      "ordinary",
      "cycle-ordinary",
      "attempt-ordinary",
      new Response(null, { status: 304 }),
      POLLED_AT,
    );

    const stored = await getDb(env.DB)
      .select({
        checkIntervalMinutes: feeds.checkIntervalMinutes,
        nextPollAt: feeds.nextPollAt,
      })
      .from(feeds)
      .where(eq(feeds.id, "ordinary"))
      .get();

    expect(stored).toEqual({
      checkIntervalMinutes: 60,
      nextPollAt: POLLED_AT + 60 * 60 * 1000,
    });
  });
});
