import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { apiTokens, cycleRuns, feeds, items, users } from "../src/db/schema";
import { createFeedPoller, type FeedToCheck } from "../src/feed/poll";
import { createSubscriptionLifecycle } from "../src/feed/subscriptions";
import { deriveItemId, sha256 } from "../src/lib/crypto";
import { getDb } from "../src/lib/db";
import { parseFeedLenient } from "../src/lib/feed-parser-fallback";

const POLLED_AT = Date.UTC(2024, 5, 1, 12);

const FEED_URL = "https://dates.example.test/feed.xml";

const MALFORMED_FEED = `<rss version="2.0"><channel><title>Date recovery</title>
  <item><guid>fallback-invalid-date</guid><title>Recovered Item</title>
    <link>https://dates.example.test/recovered</link><pubDate>not-a-date</pubDate>
    <description>Recovered from malformed XML</description></item>
  <item><guid>fallback-valid-date</guid><title>Valid Item</title>
    <link>https://dates.example.test/valid</link>
    <pubDate>Sat, 01 Jun 2024 10:00:00 GMT</pubDate></item>
  </channel>`;

/** Creates an authenticated User and Subscription for polling and Stream assertions. */
async function createSubscribedFeed() {
  const db = getDb(env.DB);
  await db.insert(users).values({
    id: "fallback-date-user",
    email: "fallback-date@example.test",
    createdAt: POLLED_AT,
  });

  await db.insert(apiTokens).values({
    id: "fallback-date-token-id",
    userId: "fallback-date-user",
    name: "Fallback date test token",
    tokenHash: await sha256("fallback-date-token"),
    createdAt: POLLED_AT,
  });

  const lifecycle = createSubscriptionLifecycle(env.DB, { publish() {} });
  const { feedId } = await lifecycle.subscribe("fallback-date-user", FEED_URL);

  return feedId;
}

/** Polls malformed XML through a durable attempt with a fixed ingestion clock. */
async function poll(feedId: string, cycleNumber: number) {
  const db = getDb(env.DB);
  const cycleRunId = `fallback-date-cycle-${cycleNumber}`;
  const attemptId = `${cycleRunId}:${feedId}`;

  await db.insert(cycleRuns).values({
    id: cycleRunId,
    ranAt: POLLED_AT + cycleNumber,
    startedAt: POLLED_AT + cycleNumber,
    triggerReason: "scheduled",
    status: "running",
  });

  const feed = await db.select().from(feeds).where(eq(feeds.id, feedId)).get();

  if (!feed) throw new Error(`Feed ${feedId} was not created`);

  const poller = createFeedPoller(
    env.DB,
    { get: async () => new Response(MALFORMED_FEED) },
    { publish() {} },
    () => POLLED_AT + cycleNumber,
  );

  // SAFETY: The selected Feed row has every persisted field required by FeedToCheck.
  return poller.poll(feed as FeedToCheck, { cycleRunId, attemptId });
}

/** Exercises GReader endpoints with the fixture User's API Token. */
async function request(path: string) {
  const context = createExecutionContext();

  const response = await worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { Authorization: "GoogleLogin auth=fallback-date-token" },
    }),
    env,
    context,
  );

  await waitOnExecutionContext(context);

  return response;
}

/** Traverses both Stream endpoints to verify recovered Items remain pageable. */
async function readStreams() {
  const contentsResponse = await request(
    "/reader/api/0/stream/contents?s=user/-/state/com.google/reading-list&n=1",
  );

  // SAFETY: This endpoint returns the GReader stream/contents response object.
  const contents = (await contentsResponse.json()) as {
    items: Array<{ id: string; title: string; published: number }>;
    continuation?: string;
  };

  const idsResponse = await request(
    "/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=1",
  );

  // SAFETY: This endpoint returns the GReader stream/items/ids response object.
  const ids = (await idsResponse.json()) as {
    itemRefs: Array<{ id: string; timestampUsec: string }>;
    continuation?: string;
  };

  return { contents, ids };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feed_poll_attempts");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM users");
});

describe("fallback Item dates", () => {
  it("normalizes missing and invalid publication dates while preserving valid dates", () => {
    const parsed = parseFeedLenient(
      `<rss><channel><item><guid>missing</guid></item>
      <item><guid>invalid</guid><pubDate>not-a-date</pubDate></item>
      <item><guid>valid</guid><pubDate>Sat, 01 Jun 2024 10:00:00 GMT</pubDate></item>
      </channel>`,
    );

    expect(parsed?.items.map((item) => item.isoDate)).toEqual([
      null,
      null,
      "Sat, 01 Jun 2024 10:00:00 GMT",
    ]);
  });

  it.each([
    { name: "before initial Backload completion", completeBackload: false },
    { name: "after initial Backload completion", completeBackload: true },
  ])(
    "stores and paginates the recovered Item $name",
    async ({ completeBackload }) => {
      const feedId = await createSubscribedFeed();

      if (completeBackload) {
        await getDb(env.DB)
          .update(feeds)
          .set({ initialBackloadCompletedAt: POLLED_AT })
          .where(eq(feeds.id, feedId));
      }

      await expect(poll(feedId, 1)).resolves.toMatchObject({
        outcome: "new_items",
        newItems: 2,
      });

      const stored = await getDb(env.DB)
        .select({
          id: items.id,
          title: items.title,
          publishedAt: items.publishedAt,
        })
        .from(items)
        .where(eq(items.feedId, feedId))
        .all();

      const recoveredId = await deriveItemId("fallback-invalid-date");
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: recoveredId,
            title: "Recovered Item",
            publishedAt: POLLED_AT + 1,
          }),
          expect.objectContaining({
            id: await deriveItemId("fallback-valid-date"),
            title: "Valid Item",
            publishedAt: Date.parse("2024-06-01T10:00:00Z"),
          }),
        ]),
      );
      expect(stored.every((item) => Number.isFinite(item.publishedAt))).toBe(
        true,
      );

      const firstPage = await readStreams();
      expect(firstPage.contents.items).toHaveLength(1);
      expect(firstPage.ids.itemRefs).toHaveLength(1);
      expect(firstPage.contents.continuation).toBeTruthy();
      expect(firstPage.ids.continuation).toBeTruthy();

      const contentsNext = await request(
        `/reader/api/0/stream/contents?s=user/-/state/com.google/reading-list&n=1&c=${encodeURIComponent(firstPage.contents.continuation!)}`,
      );

      // SAFETY: This continuation endpoint returns the same stream/contents shape.
      const contentsPage = (await contentsNext.json()) as {
        items: Array<{ id: string; title: string }>;
      };

      const idsNext = await request(
        `/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=1&c=${encodeURIComponent(firstPage.ids.continuation!)}`,
      );

      // SAFETY: This continuation endpoint returns the same stream/items/ids shape.
      const idsPage = (await idsNext.json()) as {
        itemRefs: Array<{ id: string }>;
      };

      const allContentIds = [
        ...firstPage.contents.items.map((item) => item.id),
        ...contentsPage.items.map((item) => item.id),
      ];

      const allIds = [
        ...firstPage.ids.itemRefs.map((item) => item.id),
        ...idsPage.itemRefs.map((item) => item.id),
      ];

      expect(allContentIds).toContain(
        `tag:google.com,2005:reader/item/${recoveredId}`,
      );
      expect(allIds).toContain(
        `tag:google.com,2005:reader/item/${recoveredId}`,
      );
      expect(contentsPage.items).toHaveLength(1);
      expect(idsPage.itemRefs).toHaveLength(1);
    },
  );
});
