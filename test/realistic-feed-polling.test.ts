import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cycleRuns, feeds, items, users } from "../src/db/schema";
import {
  createFeedPoller,
  createFeedHealth,
  type FeedPollResult,
  type FeedToCheck,
  type FeedTransport,
} from "../src/feed/poll";
import { createSubscriptionLifecycle } from "../src/feed/subscriptions";
import { deriveItemId } from "../src/lib/crypto";
import { getDb } from "../src/lib/db";
import atomAlternateLinks from "./fixtures/feeds/atom-alternate-links.xml?raw";
import malformedRecoverableRss from "./fixtures/feeds/malformed-recoverable-rss.xml?raw";
import rssNamespaces from "./fixtures/feeds/rss-namespaces.xml?raw";
import htmlBlockPage from "./fixtures/feeds/html-block-page.html?raw";
import unrecoverableXml from "./fixtures/feeds/unrecoverable.xml?raw";

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
    id: "dev-user-id",
    email: "fixture@example.test",
    createdAt: POLLED_AT,
  });
  const lifecycle = createSubscriptionLifecycle(env.DB, { publish() {} });
  return (await lifecycle.subscribe("dev-user-id", feedUrl)).feedId;
}

/** Polls one controlled response through the public FeedPoller and real D1. */
async function pollResponse(
  feedId: string,
  cycleNumber: number,
  bodyOrTransport: string | FeedTransport,
  responseInit: ResponseInit = { status: 200 },
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
    typeof bodyOrTransport === "string"
      ? { get: async () => new Response(bodyOrTransport, responseInit) }
      : bodyOrTransport,
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

/** Exercises the existing Feed tab to prove diagnostics are discoverable. */
async function feedDashboard(): Promise<string> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("http://localhost/app/api/feeds"),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  return response.text();
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
  it.each([
    {
      name: "absent Content-Type",
      contentType: undefined,
      body: htmlBlockPage,
    },
    {
      name: "HTML Content-Type",
      contentType: "text/html",
      body: htmlBlockPage,
    },
    {
      name: "misleading RSS Content-Type",
      contentType: "application/rss+xml",
      body: htmlBlockPage,
    },
    {
      name: "omitted optional document tags",
      contentType: "text/html",
      body: `<?xml version="1.0"?><!-- Synthetic block page -->
        <!DOCTYPE HTML><div>Access denied<rss><channel><item>
        <guid>spurious-id</guid></item></channel></rss></div>`,
    },
  ])(
    "rejects an HTML challenge with embedded Item markup and $name",
    async ({ contentType, body }) => {
      const feedId = await subscribeToFixture(
        "https://blocked.example.test/rss",
      );
      await pollResponse(feedId, 1, rssNamespaces);
      const existing = await storedItems(feedId);
      await expect(
        pollResponse(feedId, 2, body, {
          status: 200,
          headers: contentType ? { "Content-Type": contentType } : {},
        }),
      ).resolves.toMatchObject({
        outcome: "failed",
        errorClass: "parse",
        error: "HTTP 200: HTML document instead of RSS or Atom",
      });
      expect(await storedItems(feedId)).toEqual(existing);
      const attempt = await env.DB.prepare(
        "SELECT outcome, error_class, http_status, parser_status, new_items FROM feed_poll_attempts WHERE cycle_run_id = ?",
      )
        .bind("fixture-cycle-2")
        .first();
      expect(attempt).toEqual({
        outcome: "failed",
        error_class: "parse",
        http_status: 200,
        parser_status: "failure",
        new_items: 0,
      });
      expect(await feedDashboard()).toContain(
        "HTTP 200: HTML document instead of RSS or Atom",
      );
      expect(await loadFeed(feedId)).toMatchObject({
        consecutiveErrors: 1,
        lastSuccessfulPollAt: POLLED_AT + 1,
        lastError: "HTTP 200: HTML document instead of RSS or Atom",
        deactivatedAt: null,
      });
      await expect(
        pollResponse(feedId, 3, rssNamespaces),
      ).resolves.toMatchObject({
        outcome: "unchanged",
        newItems: 0,
      });
      expect(await storedItems(feedId)).toEqual(existing);
      expect(await loadFeed(feedId)).toMatchObject({
        consecutiveErrors: 0,
        lastError: null,
      });
    },
  );
  it.each([403, 503])(
    "retains HTTP %i and HTML evidence without exposing page content",
    async (status) => {
      const feedId = await subscribeToFixture(
        "https://denied.example.test/rss",
      );
      await pollResponse(feedId, 1, rssNamespaces);
      const existing = await storedItems(feedId);
      const body = htmlBlockPage.replace(
        "Verify access",
        "token=synthetic-sensitive-value",
      );
      const diagnostic = `HTTP ${status}${status === 403 ? " (permanent)" : ""}: HTML response instead of Feed content`;
      await expect(
        pollResponse(feedId, 2, body, {
          status,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      ).resolves.toMatchObject({
        outcome: "failed",
        errorClass: "http",
        error: diagnostic,
      });
      expect(await loadFeed(feedId)).toMatchObject({
        consecutiveErrors: 1,
        lastError: diagnostic,
        deactivatedAt: null,
        lastSuccessfulPollAt: POLLED_AT + 1,
        checkIntervalMinutes: 30,
        nextPollAt: POLLED_AT + 2 + 30 * 60_000,
      });
      expect(await storedItems(feedId)).toEqual(existing);
      const dashboard = await feedDashboard();
      expect(dashboard).toContain(diagnostic);
      expect(dashboard).not.toContain("synthetic-sensitive-value");
      expect(dashboard).not.toContain("Cloudflare-IP");
      const attempt = await env.DB.prepare(
        "SELECT http_status, diagnostic, new_items FROM feed_poll_attempts WHERE cycle_run_id = ?",
      )
        .bind("fixture-cycle-2")
        .first();
      expect(attempt).toEqual({
        http_status: status,
        diagnostic,
        new_items: 0,
      });
      await pollResponse(feedId, 3, rssNamespaces);
      expect(await storedItems(feedId)).toEqual(existing);
      expect(await loadFeed(feedId)).toMatchObject({
        consecutiveErrors: 0,
        lastError: null,
      });
    },
  );

  it("trims oversized multibyte Item content without exceeding 50 KiB or splitting characters", async () => {
    const feedId = await subscribeToFixture("https://large.example.test/rss");
    const body = `<rss version="2.0"><channel><title>Large content</title>
      <item><guid>large-content</guid><description>${"€".repeat(18_000)}</description></item>
      </channel></rss>`;
    await expect(pollResponse(feedId, 1, body)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    const stored = await storedItems(feedId);
    expect(stored[0]?.content).toContain("€".repeat(100));
    expect(stored[0]?.content).not.toContain("\uFFFD");
    expect(
      new TextEncoder().encode(stored[0]?.content ?? "").length,
    ).toBeLessThanOrEqual(51_200);
    await pollResponse(feedId, 2, body);
    expect(await storedItems(feedId)).toEqual(stored);
  });

  it("accepts a large body and more than 250 Items without partial writes or duplicates", async () => {
    const feedId = await subscribeToFixture("https://large.example.test/rss");
    const body = `<rss version="2.0"><channel><title>Large Feed</title>${Array.from(
      { length: 320 },
      (_, index) =>
        `<item><guid>large-${index}</guid><title>Item ${String(index).padStart(3, "0")}</title><description>${"z".repeat(8_000)}</description></item>`,
    ).join("")}</channel></rss>`;
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(2_500_000);
    await expect(pollResponse(feedId, 1, body)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 320,
    });
    const stored = await storedItems(feedId);
    expect(stored).toHaveLength(320);
    expect(new Set(stored.map((item) => item.id)).size).toBe(320);
    expect(stored[0]?.title).toBe("Item 000");
    expect(stored[319]?.title).toBe("Item 319");
    expect(
      stored.every((item) => item.content?.includes("z".repeat(8_000))),
    ).toBe(true);
    await expect(pollResponse(feedId, 2, body)).resolves.toMatchObject({
      outcome: "unchanged",
      newItems: 0,
    });
    expect(await storedItems(feedId)).toEqual(stored);
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 0,
      lastError: null,
    });
  });

  it("preserves Items through unrecoverable XML and deduplicates after recovery", async () => {
    const feedId = await subscribeToFixture("https://broken.example.test/rss");
    await pollResponse(feedId, 1, rssNamespaces);
    const stored = await storedItems(feedId);
    await expect(
      pollResponse(feedId, 2, unrecoverableXml),
    ).resolves.toMatchObject({ outcome: "failed", errorClass: "parse" });
    expect(await storedItems(feedId)).toEqual(stored);
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 1,
      lastSuccessfulPollAt: POLLED_AT + 1,
    });
    expect(await feedDashboard()).toContain("Unclosed");
    const recovered = rssNamespaces.replace(
      "</channel>",
      `<item><guid>after-recovery</guid><title>Discovered after recovery</title></item></channel>`,
    );
    await expect(pollResponse(feedId, 3, recovered)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    expect(await storedItems(feedId)).toEqual(expect.arrayContaining(stored));
    expect(await storedItems(feedId)).toHaveLength(3);
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 0,
      lastError: null,
      checkIntervalMinutes: 30,
    });
    await expect(pollResponse(feedId, 4, recovered)).resolves.toMatchObject({
      outcome: "unchanged",
      newItems: 0,
    });
    expect(await storedItems(feedId)).toHaveLength(3);
  });

  it.each([
    { retryAfter: "10800", interval: 180 },
    { retryAfter: "Sat, 01 Jun 2024 15:00:00 GMT", interval: 180 },
    { retryAfter: "invalid", interval: 60 },
    { retryAfter: "Sat, 01 Jun 2024 10:00:00 GMT", interval: 60 },
  ])(
    "honors Retry-After $retryAfter without turning 429 into a Feed error",
    async ({ retryAfter, interval }) => {
      const feedId = await subscribeToFixture(
        "https://limited.example.test/rss",
      );
      await pollResponse(feedId, 1, rssNamespaces);
      const existing = await storedItems(feedId);
      await expect(
        pollResponse(feedId, 2, htmlBlockPage, {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
      ).resolves.toMatchObject({ outcome: "rate_limited" });
      expect(await loadFeed(feedId)).toMatchObject({
        consecutiveErrors: 0,
        deactivatedAt: null,
        checkIntervalMinutes: interval,
        nextPollAt: POLLED_AT + 2 + interval * 60_000,
        lastSuccessfulPollAt: POLLED_AT + 1,
        lastError: "HTTP 429 (rate limited)",
      });
      expect(await storedItems(feedId)).toEqual(existing);
      expect(await feedDashboard()).toContain("HTTP 429 (rate limited)");
      await expect(
        pollResponse(feedId, 3, rssNamespaces),
      ).resolves.toMatchObject({ outcome: "unchanged", newItems: 0 });
      expect(await storedItems(feedId)).toEqual(existing);
      expect(await loadFeed(feedId)).toMatchObject({
        consecutiveErrors: 0,
        lastError: null,
      });
    },
  );

  it("keeps 403 permanent Deactivation and requires intentional reactivation before recovery", async () => {
    const feedId = await subscribeToFixture("https://denied.example.test/rss");
    await pollResponse(feedId, 1, rssNamespaces);
    const existing = await storedItems(feedId);
    await pollResponse(feedId, 2, "Access denied", { status: 403 });
    await pollResponse(feedId, 3, "Access denied", { status: 403 });
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 2,
      deactivatedAt: POLLED_AT + 3,
      deactivationReason: "automatic_permanent",
      lastError: "HTTP 403 (permanent)",
    });
    await expect(pollResponse(feedId, 4, rssNamespaces)).resolves.toMatchObject(
      { outcome: "skipped" },
    );
    expect(await storedItems(feedId)).toEqual(existing);
    await expect(
      createFeedHealth(env.DB, () => POLLED_AT + 5).reactivate(
        "dev-user-id",
        feedId,
      ),
    ).resolves.toBe(true);
    await expect(pollResponse(feedId, 6, rssNamespaces)).resolves.toMatchObject(
      { outcome: "unchanged", newItems: 0 },
    );
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 0,
      lastError: null,
      deactivatedAt: null,
    });
    expect(await storedItems(feedId)).toEqual(existing);
  });

  it.each(["network", "transport-abort", "body-abort"])(
    "preserves Items and recovers after %s without leaking diagnostics",
    async (failure) => {
      const feedId = await subscribeToFixture(
        "https://unavailable.example.test/rss",
      );
      await pollResponse(feedId, 1, rssNamespaces);
      const existing = await storedItems(feedId);
      const transport: FeedTransport = {
        async get() {
          if (failure === "network") {
            throw new Error(
              `Request failed for https://fixture:synthetic-password@unavailable.example.test/rss#synthetic-fragment https://unavailable.example.test/rss?token=synthetic-query Bearer synthetic-bearer auth=synthetic-auth ${"x".repeat(700)}`,
            );
          }
          if (failure === "transport-abort")
            throw new DOMException("Request aborted", "AbortError");
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new DOMException("Response body aborted", "AbortError"),
                );
              },
            }),
          );
        },
      };
      await expect(pollResponse(feedId, 2, transport)).resolves.toMatchObject({
        outcome: "failed",
        errorClass: "network",
      });
      expect(await storedItems(feedId)).toEqual(existing);
      const health = await loadFeed(feedId);
      expect(health).toMatchObject({
        consecutiveErrors: 1,
        lastSuccessfulPollAt: POLLED_AT + 1,
      });
      const attempt = await env.DB.prepare(
        "SELECT http_status, diagnostic, new_items, error_class FROM feed_poll_attempts WHERE cycle_run_id = ?",
      )
        .bind("fixture-cycle-2")
        .first<{
          http_status: number | null;
          diagnostic: string;
          new_items: number;
          error_class: string;
        }>();
      expect(attempt).toMatchObject({
        http_status: failure === "body-abort" ? 200 : null,
        new_items: 0,
        error_class: "network",
      });
      expect(attempt?.diagnostic.length).toBeLessThanOrEqual(500);
      const dashboard = await feedDashboard();
      for (const value of [
        "synthetic-password",
        "synthetic-fragment",
        "synthetic-query",
        "synthetic-bearer",
        "synthetic-auth",
      ]) {
        expect(attempt?.diagnostic).not.toContain(value);
        expect(dashboard).not.toContain(value);
      }
      await expect(
        pollResponse(feedId, 3, rssNamespaces),
      ).resolves.toMatchObject({ outcome: "unchanged", newItems: 0 });
      expect(await storedItems(feedId)).toEqual(existing);
      expect(await loadFeed(feedId)).toMatchObject({
        consecutiveErrors: 0,
        lastError: null,
      });
    },
  );

  it("accepts valid RSS mislabeled as HTML instead of diagnosing a block from headers alone", async () => {
    const feedId = await subscribeToFixture(
      "https://mislabeled.example.test/rss",
    );
    await expect(
      pollResponse(feedId, 1, rssNamespaces, {
        headers: { "Content-Type": "text/html" },
      }),
    ).resolves.toMatchObject({ outcome: "new_items", newItems: 2 });
    expect(await loadFeed(feedId)).toMatchObject({
      consecutiveErrors: 0,
      lastError: null,
    });
  });

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
          "https://journal.example.test/entries/42?from=feed&lang=en",
        ),
        title: "Fish & Chips",
        url: "https://journal.example.test/entries/42?from=feed&lang=en",
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
    expect(String(failedAttempt?.diagnostic).trim()).toMatch(
      /^Non-whitespace before first tag/,
    );
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
