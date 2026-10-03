import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cycleRuns, feeds, items, users } from "../src/db/schema";
import {
  createFeedPoller,
  type FeedPollResult,
  type FeedToCheck,
} from "../src/feed/poll";
import { createSubscriptionLifecycle } from "../src/feed/subscriptions";
import { deriveItemId } from "../src/lib/crypto";
import { getDb } from "../src/lib/db";
import atomAlternateLinks from "./fixtures/feeds/atom-alternate-links.xml?raw";
import malformedRecoverableRss from "./fixtures/feeds/malformed-recoverable-rss.xml?raw";
import rssNamespaces from "./fixtures/feeds/rss-namespaces.xml?raw";

const POLLED_AT = Date.UTC(2024, 5, 1, 12);

/** Reads the current persisted Feed state expected by the public poller. */
async function loadFeed(feedId: string): Promise<FeedToCheck> {
  const feed = await getDb(env.DB)
    .select()
    .from(feeds)
    .where(eq(feeds.id, feedId))
    .get();
  if (!feed) throw new Error(`Feed ${feedId} was not created`);
  return feed;
}

/** Creates a Feed through the production Subscription lifecycle. */
async function subscribeToFixture(feedUrl: string): Promise<string> {
  const db = getDb(env.DB);
  await db.insert(users).values({
    id: "fixture-user",
    email: "fixture@example.test",
    createdAt: POLLED_AT,
  });
  const lifecycle = createSubscriptionLifecycle(env.DB, { publish() {} });
  return (await lifecycle.subscribe("fixture-user", feedUrl)).feedId;
}

/** Polls one controlled response through the public FeedPoller and real D1. */
async function pollResponse(
  feedId: string,
  cycleNumber: number,
  body: string,
): Promise<FeedPollResult> {
  const cycleRunId = `fixture-cycle-${cycleNumber}`;
  const attemptId = `${cycleRunId}:${feedId}`;
  await getDb(env.DB)
    .insert(cycleRuns)
    .values({
      id: cycleRunId,
      ranAt: POLLED_AT + cycleNumber,
      startedAt: POLLED_AT + cycleNumber,
      triggerReason: "scheduled",
      status: "running",
    });
  const poller = createFeedPoller(
    env.DB,
    { get: async () => new Response(body, { status: 200 }) },
    { publish() {} },
    () => POLLED_AT + cycleNumber,
  );
  return poller.poll(await loadFeed(feedId), { cycleRunId, attemptId });
}

/** Reads normalized Items without exposing parser-specific intermediate values. */
async function storedItems(feedId: string) {
  return getDb(env.DB)
    .select({
      id: items.id,
      title: items.title,
      url: items.url,
      content: items.content,
      author: items.author,
      publishedAt: items.publishedAt,
    })
    .from(items)
    .where(eq(items.feedId, feedId))
    .orderBy(items.title)
    .all();
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
  vi.restoreAllMocks();
});

describe("realistic Feed Polling", () => {
  it("normalizes RSS namespaces, identities, dates, entities, and relative links", async () => {
    const feedId = await subscribeToFixture(
      "https://feeds.example.test/notes/feed.xml",
    );

    await expect(pollResponse(feedId, 1, rssNamespaces)).resolves.toMatchObject(
      {
        outcome: "new_items",
        newItems: 2,
      },
    );

    const expectedLinkId = await deriveItemId(
      "https://feeds.example.test/articles/link-identity",
    );
    const expectedGuidId = await deriveItemId("observed-alpha-id");
    expect(await storedItems(feedId)).toEqual([
      {
        id: expectedLinkId,
        title: "Link identity with an invalid date",
        url: "https://feeds.example.test/articles/link-identity",
        content: "Café & tea",
        author: null,
        publishedAt: POLLED_AT + 1,
      },
      {
        id: expectedGuidId,
        title: "Research & Development",
        url: "https://feeds.example.test/articles/alpha",
        content: "<p>Full &amp; rich story.</p>",
        author: "Ava Example",
        publishedAt: Date.parse("2024-04-02T10:30:00Z"),
      },
    ]);

    await expect(pollResponse(feedId, 2, rssNamespaces)).resolves.toMatchObject(
      {
        outcome: "unchanged",
        newItems: 0,
      },
    );
    expect(await storedItems(feedId)).toHaveLength(2);
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 0,
      lastSuccessfulPollAt: POLLED_AT + 2,
    });
  });

  it("normalizes Atom alternate links, encoded content, and missing fields", async () => {
    const feedId = await subscribeToFixture(
      "https://journal.example.test/feeds/main.atom",
    );

    await expect(
      pollResponse(feedId, 1, atomAlternateLinks),
    ).resolves.toMatchObject({ outcome: "new_items", newItems: 2 });

    expect(await storedItems(feedId)).toEqual([
      {
        id: await deriveItemId(
          "https://journal.example.test/entries/link-only",
        ),
        title: null,
        url: "https://journal.example.test/entries/link-only",
        content: "Entry without a title, identifier, or date.",
        author: null,
        publishedAt: POLLED_AT + 1,
      },
      {
        id: await deriveItemId(
          "https://journal.example.test/feeds/entries/42?from=feed&lang=en",
        ),
        title: "Fish & Chips",
        url: "https://journal.example.test/feeds/entries/42?from=feed&lang=en",
        content: "<p>Complete entry with é and &amp;.</p>",
        author: "Sam Example",
        publishedAt: Date.parse("2024-05-06T07:08:09Z"),
      },
    ]);

    await expect(
      pollResponse(feedId, 2, atomAlternateLinks),
    ).resolves.toMatchObject({ outcome: "unchanged", newItems: 0 });
    expect(await storedItems(feedId)).toHaveLength(2);
  });

  it("recovers a truncated RSS document with the production fallback parser", async () => {
    const feedId = await subscribeToFixture(
      "https://broken.example.test/feed.xml",
    );

    await expect(
      pollResponse(feedId, 1, malformedRecoverableRss),
    ).resolves.toMatchObject({ outcome: "new_items", newItems: 1 });

    expect(await storedItems(feedId)).toEqual([
      {
        id: await deriveItemId("recovered-item-id"),
        title: "Recovered Item",
        url: "https://broken.example.test/notes/recovered",
        content:
          "<p>Recovered full content with the complete body from the source.</p>",
        author: null,
        publishedAt: Date.parse("2024-04-03T12:00:00Z"),
      },
    ]);
    const attempt = await env.DB.prepare(
      `SELECT outcome, parser_status, diagnostic
         FROM feed_poll_attempts WHERE cycle_run_id = ?`,
    )
      .bind("fixture-cycle-1")
      .first();
    expect(attempt).toEqual({
      outcome: "new_items",
      parser_status: "fallback",
      diagnostic: null,
    });

    await expect(
      pollResponse(feedId, 2, malformedRecoverableRss),
    ).resolves.toMatchObject({ outcome: "unchanged", newItems: 0 });
    expect(await storedItems(feedId)).toHaveLength(1);
  });

  it("records a useful parse failure and clears Feed health after recovery", async () => {
    const feedId = await subscribeToFixture(
      "https://recovery.example.test/feed.xml",
    );

    await expect(
      pollResponse(feedId, 1, "This response is not RSS or Atom."),
    ).resolves.toMatchObject({ outcome: "failed", errorClass: "parse" });

    const failedAttempt = await env.DB.prepare(
      `SELECT outcome, error_class, parser_status, diagnostic
         FROM feed_poll_attempts WHERE cycle_run_id = ?`,
    )
      .bind("fixture-cycle-1")
      .first<Record<string, unknown>>();
    expect(failedAttempt).toMatchObject({
      outcome: "failed",
      error_class: "parse",
      parser_status: "failure",
    });
    expect(String(failedAttempt?.diagnostic).length).toBeGreaterThan(0);
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 1,
      lastSuccessfulPollAt: null,
    });

    await expect(pollResponse(feedId, 2, rssNamespaces)).resolves.toMatchObject(
      {
        outcome: "new_items",
        newItems: 2,
      },
    );
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 0,
      lastSuccessfulPollAt: POLLED_AT + 2,
    });
    const recoveredHealth = await env.DB.prepare(
      "SELECT last_error, deactivated_at FROM feeds WHERE id = ?",
    )
      .bind(feedId)
      .first();
    expect(recoveredHealth).toEqual({ last_error: null, deactivated_at: null });

    await expect(pollResponse(feedId, 3, rssNamespaces)).resolves.toMatchObject(
      {
        outcome: "unchanged",
        newItems: 0,
      },
    );
    expect(await storedItems(feedId)).toHaveLength(2);
  });
});
