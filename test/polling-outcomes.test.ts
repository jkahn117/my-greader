import { env, type WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db";
import { cycleRuns, feeds, subscriptions, users } from "../src/db/schema";
import {
  createFeedPoller,
  type FeedToCheck,
  type FeedTransport,
} from "../src/feed/poll";
import { runFeedPollingWorkflow } from "../src/workflows/feed_polling";

const EMPTY_RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Empty Feed</title><link>https://example.com</link>
</channel></rss>`;

const ONE_ITEM_RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>One Item Feed</title><link>https://example.com</link><item>
    <title>One Item</title><link>https://example.com/one</link>
    <guid>https://example.com/one</guid>
  </item>
</channel></rss>`;

/** Builds a large but ordinary RSS document without coupling the test to parser internals. */
function rssWithItems(count: number): string {
  const itemXml = Array.from(
    { length: count },
    (_, index) => `<item>
      <title>Item ${index}</title>
      <link>https://example.com/items/${index}</link>
      <guid>large-item-${index}</guid>
      <description>${"content ".repeat(900)}</description>
    </item>`,
  ).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Large Feed</title><link>https://example.com</link>${itemXml}
  </channel></rss>`;
}

/** Runs Workflow steps immediately while preserving their named execution boundary. */
function immediateStep(): WorkflowStep {
  return {
    do: (_name: string, configOrCallback: unknown, maybeCallback?: unknown) => {
      const callback =
        typeof configOrCallback === "function"
          ? configOrCallback
          : maybeCallback;
      return (callback as () => Promise<unknown>)();
    },
  } as WorkflowStep;
}

/** Creates the public FeedPoller input from a seeded Feed row. */
function feedInput(
  id: string,
  overrides: Partial<FeedToCheck> = {},
): FeedToCheck {
  return {
    id,
    feedUrl: `https://${id}.example/feed.xml`,
    title: `${id} Feed`,
    htmlUrl: null,
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    consecutiveErrors: 0,
    checkIntervalMinutes: 30,
    lastNewItemAt: null,
    ...overrides,
  };
}

/** Seeds a Feed and its Cycle Run so FeedPoller can record a durable attempt. */
async function seedAttempt(feed: FeedToCheck, cycleRunId: string) {
  const db = getDb(env.DB);
  await db.insert(feeds).values({
    id: feed.id,
    feedUrl: feed.feedUrl,
    title: feed.title,
    htmlUrl: feed.htmlUrl,
    etag: feed.etag,
    lastModified: feed.lastModified,
    lastFetchedAt: feed.lastFetchedAt,
    consecutiveErrors: feed.consecutiveErrors,
    checkIntervalMinutes: feed.checkIntervalMinutes,
    lastNewItemAt: feed.lastNewItemAt,
  });
  await db.insert(cycleRuns).values({
    id: cycleRunId,
    ranAt: 1_735_732_800_000,
    startedAt: 1_735_732_800_000,
    triggerReason: "scheduled",
    status: "running",
  });
}

/** Reads the persisted public outcome of one logical Feed attempt. */
async function readAttempt(id: string) {
  return env.DB.prepare(
    `SELECT outcome, new_items, error_class, http_status, parser_status, diagnostic,
            started_at, completed_at
       FROM feed_poll_attempts WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
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
  vi.unstubAllGlobals();
});

describe("durable Feed attempt outcomes", () => {
  it("commits no-new-Items separately from conditional not-modified", async () => {
    const unchanged = feedInput("unchanged");
    const notModified = feedInput("not-modified", { etag: 'W/"known"' });
    await seedAttempt(unchanged, "cycle-unchanged");
    await seedAttempt(notModified, "cycle-not-modified");

    const unchangedPoller = createFeedPoller(
      env.DB,
      { get: async () => new Response(EMPTY_RSS) },
      { publish() {} },
      () => 1_735_732_800_000,
    );
    const notModifiedPoller = createFeedPoller(
      env.DB,
      { get: async () => new Response(null, { status: 304 }) },
      { publish() {} },
      () => 1_735_732_800_000,
    );

    await unchangedPoller.poll(unchanged, {
      cycleRunId: "cycle-unchanged",
      attemptId: "attempt-unchanged",
    });
    await notModifiedPoller.poll(notModified, {
      cycleRunId: "cycle-not-modified",
      attemptId: "attempt-not-modified",
    });

    expect(await readAttempt("attempt-unchanged")).toMatchObject({
      outcome: "unchanged",
      new_items: 0,
      parser_status: "success",
      error_class: null,
      http_status: 200,
    });
    expect(await readAttempt("attempt-not-modified")).toMatchObject({
      outcome: "not_modified",
      new_items: 0,
      parser_status: "not_attempted",
      error_class: null,
      http_status: 304,
    });
  });

  it("commits rate limiting separately from classified Feed failures", async () => {
    const cases: Array<{
      id: string;
      transport: FeedTransport;
      outcome: string;
      errorClass: string | null;
      httpStatus: number | null;
      parserStatus: string;
    }> = [
      {
        id: "rate-limited",
        transport: {
          get: async () => new Response(null, { status: 429 }),
        },
        outcome: "rate_limited",
        errorClass: null,
        httpStatus: 429,
        parserStatus: "not_attempted",
      },
      {
        id: "network-failure",
        transport: {
          get: async () => {
            throw new Error(
              `request failed for https://user:password@feeds.example/rss?token=${"s".repeat(700)}`,
            );
          },
        },
        outcome: "failed",
        errorClass: "network",
        httpStatus: null,
        parserStatus: "not_attempted",
      },
      {
        id: "http-failure",
        transport: {
          get: async () => new Response(null, { status: 503 }),
        },
        outcome: "failed",
        errorClass: "http",
        httpStatus: 503,
        parserStatus: "not_attempted",
      },
      {
        id: "parse-failure",
        transport: {
          get: async () => new Response("this is not a feed"),
        },
        outcome: "failed",
        errorClass: "parse",
        httpStatus: 200,
        parserStatus: "failure",
      },
    ];

    for (const testCase of cases) {
      const feed = feedInput(testCase.id);
      const cycleRunId = `cycle-${testCase.id}`;
      const attemptId = `attempt-${testCase.id}`;
      await seedAttempt(feed, cycleRunId);
      const poller = createFeedPoller(
        env.DB,
        testCase.transport,
        { publish() {} },
        () => 1_735_732_800_000,
      );

      await poller.poll(feed, { cycleRunId, attemptId });
      const attempt = await readAttempt(attemptId);

      expect(attempt).toMatchObject({
        outcome: testCase.outcome,
        error_class: testCase.errorClass,
        http_status: testCase.httpStatus,
        parser_status: testCase.parserStatus,
      });
      expect(attempt?.completed_at).not.toBeNull();
    }

    const networkAttempt = await readAttempt("attempt-network-failure");
    expect(String(networkAttempt?.diagnostic).length).toBeLessThanOrEqual(500);
    expect(networkAttempt?.diagnostic).not.toContain("token=");
    expect(networkAttempt?.diagnostic).not.toContain("user:password");
    expect(networkAttempt?.diagnostic).not.toContain("s".repeat(100));
  });

  it("classifies response body failures without leaving the attempt running", async () => {
    const feed = feedInput("body-failure");
    await seedAttempt(feed, "cycle-body-failure");
    const response = new Response(EMPTY_RSS);
    vi.spyOn(response, "text").mockRejectedValue(
      new Error("body stream reset"),
    );
    const poller = createFeedPoller(
      env.DB,
      { get: async () => response },
      { publish() {} },
      () => 1_735_732_800_000,
    );

    const result = await poller.poll(feed, {
      cycleRunId: "cycle-body-failure",
      attemptId: "attempt-body-failure",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      errorClass: "network",
    });
    expect(await readAttempt("attempt-body-failure")).toMatchObject({
      outcome: "failed",
      error_class: "network",
      http_status: 200,
      parser_status: "not_attempted",
    });
  });

  it("returns a committed attempt on retry without repeating HTTP or observers", async () => {
    const feed = feedInput("retry");
    await seedAttempt(feed, "cycle-retry");
    const observer = {
      publish: vi.fn(() => {
        throw new Error("AE down");
      }),
    };
    const firstTransport = {
      get: vi.fn(async () => new Response(ONE_ITEM_RSS)),
    };
    const attempt = {
      cycleRunId: "cycle-retry",
      attemptId: "attempt-retry",
    };
    const firstPoller = createFeedPoller(
      env.DB,
      firstTransport,
      observer,
      () => 1_735_732_800_000,
    );

    await expect(firstPoller.poll(feed, attempt)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });

    const retryTransport = {
      get: vi.fn(async () => {
        throw new Error("HTTP must not repeat");
      }),
    };
    const retryObserver = { publish: vi.fn() };
    const retryPoller = createFeedPoller(
      env.DB,
      retryTransport,
      retryObserver,
      () => 1_735_732_800_001,
    );

    await expect(retryPoller.poll(feed, attempt)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    expect(retryTransport.get).not.toHaveBeenCalled();
    expect(retryObserver.publish).not.toHaveBeenCalled();
  });

  it("returns the committed winner when runtime retries repeat HTTP", async () => {
    const feed = feedInput("overlap");
    await seedAttempt(feed, "cycle-overlap");
    let resolveSuccess: (response: Response) => void = () => {};
    let resolveNotModified: (response: Response) => void = () => {};
    const successResponse = new Promise<Response>((resolve) => {
      resolveSuccess = resolve;
    });
    const notModifiedResponse = new Promise<Response>((resolve) => {
      resolveNotModified = resolve;
    });
    const successTransport = { get: vi.fn(() => successResponse) };
    const notModifiedTransport = { get: vi.fn(() => notModifiedResponse) };
    const successObserver = { publish: vi.fn() };
    const notModifiedObserver = { publish: vi.fn() };
    const attempt = {
      cycleRunId: "cycle-overlap",
      attemptId: "attempt-overlap",
    };
    const successPoll = createFeedPoller(
      env.DB,
      successTransport,
      successObserver,
      () => 1_735_732_800_000,
    ).poll(feed, attempt);
    const notModifiedPoll = createFeedPoller(
      env.DB,
      notModifiedTransport,
      notModifiedObserver,
      () => 1_735_732_800_001,
    ).poll(feed, attempt);
    await vi.waitFor(() => {
      expect(successTransport.get).toHaveBeenCalledOnce();
      expect(notModifiedTransport.get).toHaveBeenCalledOnce();
    });

    resolveSuccess(new Response(ONE_ITEM_RSS));
    await expect(successPoll).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    resolveNotModified(new Response(null, { status: 304 }));
    await expect(notModifiedPoll).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });

    expect(await readAttempt(attempt.attemptId)).toMatchObject({
      outcome: "new_items",
      new_items: 1,
    });
    expect(successObserver.publish).toHaveBeenCalledOnce();
    expect(notModifiedObserver.publish).not.toHaveBeenCalled();
  });

  it("rolls back Items, Feed health and completion when the database commit fails", async () => {
    const feed = feedInput("atomic-failure", {
      consecutiveErrors: 2,
      checkIntervalMinutes: 60,
    });
    await seedAttempt(feed, "cycle-atomic-failure");
    await env.DB.prepare(`CREATE TRIGGER fail_feed_completion
      BEFORE UPDATE ON feeds
      WHEN NEW.last_fetched_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected completion failure');
      END`).run();
    const transport = { get: vi.fn(async () => new Response(ONE_ITEM_RSS)) };
    const poller = createFeedPoller(
      env.DB,
      transport,
      { publish() {} },
      () => 1_735_732_800_000,
    );
    const attempt = {
      cycleRunId: "cycle-atomic-failure",
      attemptId: "attempt-atomic-failure",
    };

    await expect(poller.poll(feed, attempt)).rejects.toThrow(
      "injected completion failure",
    );
    await env.DB.exec("DROP TRIGGER fail_feed_completion");

    const itemCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM items",
    ).first<{ count: number }>();
    const persistedFeed = await env.DB.prepare(
      `SELECT last_fetched_at, consecutive_errors, check_interval_minutes
         FROM feeds WHERE id = ?`,
    )
      .bind(feed.id)
      .first();
    expect(itemCount?.count).toBe(0);
    expect(await readAttempt(attempt.attemptId)).toMatchObject({
      outcome: null,
      new_items: 0,
      completed_at: null,
    });
    expect(persistedFeed).toEqual({
      last_fetched_at: null,
      consecutive_errors: 2,
      check_interval_minutes: 60,
    });

    await expect(poller.poll(feed, attempt)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    expect(transport.get).toHaveBeenCalledTimes(2);
  });

  it("atomically completes a large Feed and replays its committed result", async () => {
    const feed = feedInput("large");
    await seedAttempt(feed, "cycle-large");
    const transport = {
      get: vi.fn(async () => new Response(rssWithItems(250))),
    };
    const attempt = {
      cycleRunId: "cycle-large",
      attemptId: "attempt-large",
    };
    const poller = createFeedPoller(
      env.DB,
      transport,
      { publish() {} },
      () => 1_735_732_800_000,
    );

    await expect(poller.poll(feed, attempt)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 250,
    });
    await expect(poller.poll(feed, attempt)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 250,
    });

    const stored = await env.DB.prepare(
      `SELECT count(*) AS count,
              count(DISTINCT first_ingestion_attempt_id) AS attempts
         FROM items`,
    ).first<{ count: number; attempts: number }>();
    expect(stored).toEqual({ count: 250, attempts: 1 });
    expect(transport.get).toHaveBeenCalledTimes(1);
  });
});

describe("Cycle Run outcomes", () => {
  /** Runs the actual Workflow entrypoint with local D1 and a deterministic transport. */
  async function runWorkflow(
    instanceId: string,
    triggerReason: "scheduled" | "manual" | "forced",
  ) {
    await runFeedPollingWorkflow(
      {
        ...env,
        ANALYTICS_ENABLED: "false",
      } as unknown as Env,
      {
        instanceId,
        timestamp: new Date(1_735_732_800_000),
        payload: { triggerReason },
      },
      immediateStep(),
    );
  }

  it("persists a completed empty run without manufacturing Feed attempts", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await runWorkflow("empty-cycle", "scheduled");

    const cycle = await env.DB.prepare(
      `SELECT status, outcome, active_feeds, selected_feeds, checked_feeds,
              failed_feeds, skipped_feeds, new_items, completed_at
         FROM cycle_runs WHERE id = ?`,
    )
      .bind("empty-cycle")
      .first();
    const attempts = await env.DB.prepare(
      "SELECT count(*) AS count FROM feed_poll_attempts",
    ).first<{ count: number }>();

    expect(cycle).toMatchObject({
      status: "completed",
      outcome: "empty",
      active_feeds: 0,
      selected_feeds: 0,
      checked_feeds: 0,
      failed_feeds: 0,
      skipped_feeds: 0,
      new_items: 0,
    });
    expect(cycle?.completed_at).not.toBeNull();
    expect(attempts?.count).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("selects distinct due Feeds and forced runs bypass only due time", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await db.insert(users).values([
      { id: "user-a", email: "a@example.com", createdAt: now },
      { id: "user-b", email: "b@example.com", createdAt: now },
    ]);
    await db.insert(feeds).values([
      {
        id: "due-feed",
        feedUrl: "https://due.example/feed.xml",
        title: "Due Feed",
        lastFetchedAt: null,
      },
      {
        id: "not-due-feed",
        feedUrl: "https://not-due.example/feed.xml",
        title: "Not Due Feed",
        lastFetchedAt: now,
        checkIntervalMinutes: 240,
      },
      {
        id: "inactive-feed",
        feedUrl: "https://inactive.example/feed.xml",
        title: "Inactive Feed",
        deactivatedAt: now,
      },
    ]);
    await db.insert(subscriptions).values([
      { id: "sub-a-due", userId: "user-a", feedId: "due-feed" },
      { id: "sub-b-due", userId: "user-b", feedId: "due-feed" },
      { id: "sub-not-due", userId: "user-a", feedId: "not-due-feed" },
      { id: "sub-inactive", userId: "user-a", feedId: "inactive-feed" },
    ]);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () => new Response(EMPTY_RSS, { status: 200 }),
        ),
    );

    await runWorkflow("scheduled-cycle", "scheduled");
    await runWorkflow("forced-cycle", "forced");

    const cycles = await env.DB.prepare(
      `SELECT id, active_feeds, selected_feeds, checked_feeds, failed_feeds,
              skipped_feeds, status, outcome
         FROM cycle_runs ORDER BY id`,
    ).all();
    expect(cycles.results).toEqual([
      {
        id: "forced-cycle",
        active_feeds: 2,
        selected_feeds: 2,
        checked_feeds: 2,
        failed_feeds: 0,
        skipped_feeds: 0,
        status: "completed",
        outcome: "completed",
      },
      {
        id: "scheduled-cycle",
        active_feeds: 2,
        selected_feeds: 1,
        checked_feeds: 1,
        failed_feeds: 0,
        skipped_feeds: 0,
        status: "completed",
        outcome: "completed",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reconciles skipped selections without counting them as checked", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await db.insert(users).values({
      id: "user-a",
      email: "a@example.com",
      createdAt: now,
    });
    await db.insert(feeds).values({
      id: "busy-feed",
      feedUrl: "https://busy.example/feed.xml",
      title: "Busy Feed",
    });
    await db.insert(subscriptions).values({
      id: "sub-busy",
      userId: "user-a",
      feedId: "busy-feed",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const step = {
      do: async (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: unknown,
      ) => {
        const callback =
          typeof configOrCallback === "function"
            ? configOrCallback
            : maybeCallback;
        if (name.startsWith("fetch-batch-")) {
          await db
            .update(feeds)
            .set({ deactivatedAt: now })
            .where(eq(feeds.id, "busy-feed"));
        }
        return (callback as () => Promise<unknown>)();
      },
    } as WorkflowStep;

    await runFeedPollingWorkflow(
      { ...env, ANALYTICS_ENABLED: "false" } as unknown as Env,
      {
        instanceId: "skipped-cycle",
        timestamp: new Date(now),
        payload: { triggerReason: "scheduled" },
      },
      step,
    );

    const cycle = await env.DB.prepare(
      `SELECT selected_feeds, checked_feeds, failed_feeds, skipped_feeds,
              status, outcome
         FROM cycle_runs WHERE id = ?`,
    )
      .bind("skipped-cycle")
      .first();
    expect(cycle).toEqual({
      selected_feeds: 1,
      checked_feeds: 0,
      failed_feeds: 0,
      skipped_feeds: 1,
      status: "completed",
      outcome: "completed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers when Feed completion commits before the Workflow acknowledges it", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await db.insert(users).values({
      id: "retry-user",
      email: "retry@example.com",
      createdAt: now,
    });
    await db.insert(feeds).values({
      id: "retry-feed",
      feedUrl: "https://retry.example/feed.xml",
      title: "Retry Feed",
    });
    await db.insert(subscriptions).values({
      id: "retry-subscription",
      userId: "retry-user",
      feedId: "retry-feed",
    });
    const fetchMock = vi.fn(async () => new Response(ONE_ITEM_RSS));
    vi.stubGlobal("fetch", fetchMock);
    const completedSteps = new Map<string, unknown>();
    let loseFetchAcknowledgment = true;
    // Caches acknowledged Workflow steps while replaying the unacknowledged Feed step.
    const retryingStep = {
      do: async (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: unknown,
      ) => {
        if (completedSteps.has(name)) return completedSteps.get(name);
        const callback =
          typeof configOrCallback === "function"
            ? configOrCallback
            : maybeCallback;
        const result = await (callback as () => Promise<unknown>)();
        if (name.startsWith("fetch-batch-") && loseFetchAcknowledgment) {
          loseFetchAcknowledgment = false;
          throw new Error("acknowledgment lost after commit");
        }
        completedSteps.set(name, result);
        return result;
      },
    } as WorkflowStep;
    const event = {
      instanceId: "retry-cycle",
      timestamp: new Date(now),
      payload: { triggerReason: "scheduled" as const },
    };
    const workflowEnv = {
      ...env,
      ANALYTICS_ENABLED: "false",
    } as unknown as Env;

    await expect(
      runFeedPollingWorkflow(workflowEnv, event, retryingStep),
    ).rejects.toThrow("acknowledgment lost after commit");
    await expect(
      runFeedPollingWorkflow(workflowEnv, event, retryingStep),
    ).resolves.toBeUndefined();

    const cycle = await env.DB.prepare(
      `SELECT status, selected_feeds, checked_feeds, failed_feeds, new_items
         FROM cycle_runs WHERE id = ?`,
    )
      .bind("retry-cycle")
      .first();
    const stored = await env.DB.prepare(
      `SELECT count(*) AS count,
              min(first_ingestion_attempt_id) AS attempt_id
         FROM items`,
    ).first();
    expect(cycle).toEqual({
      status: "completed",
      selected_feeds: 1,
      checked_feeds: 1,
      failed_feeds: 0,
      new_items: 1,
    });
    expect(stored).toEqual({
      count: 1,
      attempt_id: "retry-cycle:retry-feed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves interrupted work running instead of completing it as success", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await db.insert(users).values({
      id: "user-a",
      email: "a@example.com",
      createdAt: now,
    });
    await db.insert(feeds).values({
      id: "interrupted-feed",
      feedUrl: "https://interrupted.example/feed.xml",
      title: "Interrupted Feed",
    });
    await db.insert(subscriptions).values({
      id: "sub-interrupted",
      userId: "user-a",
      feedId: "interrupted-feed",
    });
    const interruptedStep = {
      do: async (
        name: string,
        configOrCallback: unknown,
        maybeCallback?: unknown,
      ) => {
        const callback =
          typeof configOrCallback === "function"
            ? configOrCallback
            : maybeCallback;
        if (name.startsWith("fetch-batch-")) {
          await env.DB.prepare(
            `INSERT INTO feed_poll_attempts
              (id, cycle_run_id, feed_id, started_at, new_items)
             VALUES (?, ?, ?, ?, 0)`,
          )
            .bind(
              "interrupted-cycle:interrupted-feed",
              "interrupted-cycle",
              "interrupted-feed",
              now,
            )
            .run();
          throw new Error("runtime stopped");
        }
        return (callback as () => Promise<unknown>)();
      },
    } as WorkflowStep;

    await expect(
      runFeedPollingWorkflow(
        { ...env, ANALYTICS_ENABLED: "false" } as unknown as Env,
        {
          instanceId: "interrupted-cycle",
          timestamp: new Date(now),
          payload: { triggerReason: "scheduled" },
        },
        interruptedStep,
      ),
    ).rejects.toThrow("runtime stopped");

    const cycle = await env.DB.prepare(
      `SELECT status, outcome, selected_feeds, checked_feeds, completed_at
         FROM cycle_runs WHERE id = ?`,
    )
      .bind("interrupted-cycle")
      .first();
    const attempt = await env.DB.prepare(
      `SELECT outcome, completed_at FROM feed_poll_attempts WHERE cycle_run_id = ?`,
    )
      .bind("interrupted-cycle")
      .first();

    expect(cycle).toEqual({
      status: "running",
      outcome: null,
      selected_feeds: 1,
      checked_feeds: 0,
      completed_at: null,
    });
    expect(attempt).toEqual({ outcome: null, completed_at: null });
  });
});
