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
    lastSuccessfulPollAt: null,
    lastNewItemDiscoveredAt: null,
    initialBackloadCompletedAt: null,
    nextPollAt: null,
    consecutiveErrors: 0,
    checkIntervalMinutes: 30,
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
    lastSuccessfulPollAt: feed.lastSuccessfulPollAt,
    lastNewItemDiscoveredAt: feed.lastNewItemDiscoveredAt,
    initialBackloadCompletedAt: feed.initialBackloadCompletedAt,
    nextPollAt: feed.nextPollAt,
    consecutiveErrors: feed.consecutiveErrors,
    checkIntervalMinutes: feed.checkIntervalMinutes,
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
  it("completes an empty initial backload without claiming a new Item", async () => {
    const checkedAt = 1_735_732_800_000;
    const feed = feedInput("empty-initial");
    await seedAttempt(feed, "cycle-empty-initial");
    const poller = createFeedPoller(
      env.DB,
      { get: async () => new Response(EMPTY_RSS) },
      { publish() {} },
      () => checkedAt,
    );

    await expect(
      poller.poll(feed, {
        cycleRunId: "cycle-empty-initial",
        attemptId: "attempt-empty-initial",
      }),
    ).resolves.toMatchObject({ outcome: "unchanged", newItems: 0 });

    const stored = await env.DB.prepare(
      `SELECT last_successful_poll_at, last_new_item_discovered_at,
              initial_backload_completed_at, next_poll_at
         FROM feeds WHERE id = ?`,
    )
      .bind(feed.id)
      .first();
    expect(stored).toEqual({
      last_successful_poll_at: checkedAt,
      last_new_item_discovered_at: null,
      initial_backload_completed_at: checkedAt,
      next_poll_at: checkedAt + 60 * 60 * 1000,
    });
  });

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

  it("lets only one Cycle Run own a Feed while its lease is active", async () => {
    const feed = feedInput("contended");
    await seedAttempt(feed, "cycle-owner");
    await getDb(env.DB).insert(cycleRuns).values({
      id: "cycle-contender",
      ranAt: 1_735_732_800_001,
      startedAt: 1_735_732_800_001,
      triggerReason: "forced",
      status: "running",
    });
    let releaseOwner: (response: Response) => void = () => {};
    const ownerResponse = new Promise<Response>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerTransport = { get: vi.fn(() => ownerResponse) };
    const contenderTransport = {
      get: vi.fn(async () => new Response(null, { status: 304 })),
    };
    const ownerPoll = createFeedPoller(
      env.DB,
      ownerTransport,
      { publish() {} },
      () => 1_735_732_800_000,
    ).poll(feed, {
      cycleRunId: "cycle-owner",
      attemptId: "attempt-owner",
    });
    await vi.waitFor(() => expect(ownerTransport.get).toHaveBeenCalledOnce());

    const contenderResult = await createFeedPoller(
      env.DB,
      contenderTransport,
      { publish() {} },
      () => 1_735_732_800_001,
    ).poll(feed, {
      cycleRunId: "cycle-contender",
      attemptId: "attempt-contender",
    });
    releaseOwner(new Response(ONE_ITEM_RSS));

    await expect(ownerPoll).resolves.toMatchObject({ outcome: "new_items" });
    expect(contenderResult).toEqual({
      feedId: feed.id,
      feedTitle: feed.title,
      outcome: "skipped",
    });
    expect(contenderTransport.get).not.toHaveBeenCalled();
  });

  it("does not skip an attempt acquired by a concurrent retry", async () => {
    const feed = feedInput("skip-race");
    await seedAttempt(feed, "cycle-current-owner");
    await getDb(env.DB).insert(cycleRuns).values({
      id: "cycle-racing-attempt",
      ranAt: 1_735_732_800_001,
      startedAt: 1_735_732_800_001,
      triggerReason: "forced",
      status: "running",
    });
    let releaseOwner: (response: Response) => void = () => {};
    const ownerResponse = new Promise<Response>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerTransport = { get: vi.fn(() => ownerResponse) };
    const ownerPoll = createFeedPoller(
      env.DB,
      ownerTransport,
      { publish() {} },
      () => 1_735_732_800_000,
    ).poll(feed, {
      cycleRunId: "cycle-current-owner",
      attemptId: "attempt-current-owner",
    });
    await vi.waitFor(() => expect(ownerTransport.get).toHaveBeenCalledOnce());

    let claimFinished: () => void = () => {};
    let returnClaim: () => void = () => {};
    const claimFinishedPromise = new Promise<void>((resolve) => {
      claimFinished = resolve;
    });
    const returnClaimPromise = new Promise<void>((resolve) => {
      returnClaim = resolve;
    });
    let pauseFirstBatch = true;
    const pausingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (pauseFirstBatch) {
              pauseFirstBatch = false;
              claimFinished();
              await returnClaimPromise;
            }
            return results;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racingAttempt = {
      cycleRunId: "cycle-racing-attempt",
      attemptId: "attempt-racing",
    };
    const firstRuntime = createFeedPoller(
      pausingDb,
      { get: vi.fn() },
      { publish() {} },
      () => 1_735_732_800_001,
    ).poll(feed, racingAttempt);
    await claimFinishedPromise;

    releaseOwner(new Response(EMPTY_RSS));
    await ownerPoll;
    let releaseRetry: (response: Response) => void = () => {};
    const retryResponse = new Promise<Response>((resolve) => {
      releaseRetry = resolve;
    });
    const retryTransport = { get: vi.fn(() => retryResponse) };
    const retryPoll = createFeedPoller(
      env.DB,
      retryTransport,
      { publish() {} },
      () => 1_735_732_800_002,
    ).poll(feed, racingAttempt);
    await vi.waitFor(() => expect(retryTransport.get).toHaveBeenCalledOnce());
    returnClaim();

    await expect(firstRuntime).rejects.toThrow("lost ownership");
    releaseRetry(new Response(ONE_ITEM_RSS));
    await expect(retryPoll).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    expect(await readAttempt(racingAttempt.attemptId)).toMatchObject({
      outcome: "new_items",
      new_items: 1,
    });
  });

  it("rejects a stale owner after an expired lease is claimed", async () => {
    const feed = feedInput("expired-owner");
    await seedAttempt(feed, "cycle-stale");
    await getDb(env.DB).insert(cycleRuns).values({
      id: "cycle-recovery",
      ranAt: 1_735_733_100_001,
      startedAt: 1_735_733_100_001,
      triggerReason: "scheduled",
      status: "running",
    });
    let releaseStaleOwner: (response: Response) => void = () => {};
    const staleResponse = new Promise<Response>((resolve) => {
      releaseStaleOwner = resolve;
    });
    const stalePoll = createFeedPoller(
      env.DB,
      { get: vi.fn(() => staleResponse) },
      { publish() {} },
      () => 1_735_732_800_000,
    ).poll(feed, {
      cycleRunId: "cycle-stale",
      attemptId: "attempt-stale",
    });
    await vi.waitFor(async () => {
      expect(await readAttempt("attempt-stale")).not.toBeNull();
    });

    const recoveryResult = await createFeedPoller(
      env.DB,
      { get: vi.fn(async () => new Response(null, { status: 304 })) },
      { publish() {} },
      () => 1_735_733_100_001,
    ).poll(feed, {
      cycleRunId: "cycle-recovery",
      attemptId: "attempt-recovery",
    });
    releaseStaleOwner(new Response(ONE_ITEM_RSS));

    expect(recoveryResult).toMatchObject({ outcome: "not_modified" });
    await expect(stalePoll).rejects.toThrow("lost ownership");
    expect(await readAttempt("attempt-stale")).toMatchObject({ outcome: null });
    const stored = await env.DB.prepare(
      "SELECT count(*) AS count FROM items",
    ).first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it("uses current Feed policy after a delayed contender acquires ownership", async () => {
    const selectedFeed = feedInput("delayed-contender");
    await seedAttempt(selectedFeed, "cycle-first-failure");
    await getDb(env.DB).insert(cycleRuns).values({
      id: "cycle-second-failure",
      ranAt: 1_735_732_800_001,
      startedAt: 1_735_732_800_001,
      triggerReason: "scheduled",
      status: "running",
    });
    const failedTransport = {
      get: vi.fn(async () => new Response(null, { status: 503 })),
    };

    await createFeedPoller(
      env.DB,
      failedTransport,
      { publish() {} },
      () => 1_735_732_800_000,
    ).poll(selectedFeed, {
      cycleRunId: "cycle-first-failure",
      attemptId: "attempt-first-failure",
    });
    await createFeedPoller(
      env.DB,
      failedTransport,
      { publish() {} },
      () => 1_735_732_800_001,
    ).poll(selectedFeed, {
      cycleRunId: "cycle-second-failure",
      attemptId: "attempt-second-failure",
    });

    const persistedFeed = await env.DB.prepare(
      "SELECT consecutive_errors FROM feeds WHERE id = ?",
    )
      .bind(selectedFeed.id)
      .first();
    expect(persistedFeed).toEqual({ consecutive_errors: 2 });
  });

  it("resumes an unfinished attempt after expiry and fences its old runtime", async () => {
    const feed = feedInput("resumed");
    await seedAttempt(feed, "cycle-resumed");
    let releaseOldRuntime: (response: Response) => void = () => {};
    let releaseRetry: (response: Response) => void = () => {};
    const oldResponse = new Promise<Response>((resolve) => {
      releaseOldRuntime = resolve;
    });
    const retryResponse = new Promise<Response>((resolve) => {
      releaseRetry = resolve;
    });
    const attempt = {
      cycleRunId: "cycle-resumed",
      attemptId: "attempt-resumed",
    };
    const oldTransport = { get: vi.fn(() => oldResponse) };
    const retryTransport = { get: vi.fn(() => retryResponse) };
    const oldPoll = createFeedPoller(
      env.DB,
      oldTransport,
      { publish() {} },
      () => 1_735_732_800_000,
    ).poll(feed, attempt);
    await vi.waitFor(() => expect(oldTransport.get).toHaveBeenCalledOnce());

    const retryPoll = createFeedPoller(
      env.DB,
      retryTransport,
      { publish() {} },
      () => 1_735_733_100_001,
    ).poll(feed, attempt);
    await vi.waitFor(() => expect(retryTransport.get).toHaveBeenCalledOnce());

    releaseOldRuntime(new Response(null, { status: 304 }));
    const oldResult = await oldPoll.then(
      () => "committed",
      () => "rejected",
    );
    releaseRetry(new Response(ONE_ITEM_RSS));

    expect(oldResult).toBe("rejected");
    await expect(retryPoll).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    const stored = await env.DB.prepare(
      `SELECT count(*) AS count,
              count(DISTINCT first_ingestion_attempt_id) AS attempts
         FROM items`,
    ).first();
    expect(stored).toEqual({ count: 1, attempts: 1 });
  });

  it("rolls back Items, Feed health and completion when the database commit fails", async () => {
    const feed = feedInput("atomic-failure", {
      consecutiveErrors: 2,
      checkIntervalMinutes: 60,
    });
    await seedAttempt(feed, "cycle-atomic-failure");
    await env.DB.prepare(`CREATE TRIGGER fail_feed_completion
      BEFORE UPDATE ON feeds
      WHEN NEW.last_successful_poll_at IS NOT NULL
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
      `SELECT last_successful_poll_at, consecutive_errors, check_interval_minutes
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
      last_successful_poll_at: null,
      consecutive_errors: 2,
      check_interval_minutes: 60,
    });

    await expect(poller.poll(feed, attempt)).resolves.toMatchObject({
      outcome: "new_items",
      newItems: 1,
    });
    expect(transport.get).toHaveBeenCalledTimes(2);
  });

  it("uses explicit backload completion to admit late Items and reject purged old Items", async () => {
    const firstCheck = 1_735_732_800_000;
    let currentTime = firstCheck;
    const feed = feedInput("backload-policy");
    await seedAttempt(feed, "cycle-empty-backload");
    const transport = { get: vi.fn(async () => new Response(EMPTY_RSS)) };
    const poller = createFeedPoller(
      env.DB,
      transport,
      { publish() {} },
      () => currentTime,
    );

    await poller.poll(feed, {
      cycleRunId: "cycle-empty-backload",
      attemptId: "attempt-empty-backload",
    });

    currentTime += 2 * 60 * 60 * 1000;
    await getDb(env.DB).insert(cycleRuns).values({
      id: "cycle-late-items",
      ranAt: currentTime,
      startedAt: currentTime,
      triggerReason: "forced",
      status: "running",
    });
    transport.get.mockResolvedValueOnce(
      new Response(`<?xml version="1.0"?><rss version="2.0"><channel>
        <title>Late Feed</title><link>https://example.com</link>
        <item><title>Late Item</title><link>https://example.com/late</link>
          <guid>late-item</guid><pubDate>${new Date(firstCheck - 60 * 60 * 1000).toUTCString()}</pubDate></item>
        <item><title>Purged Old Item</title><link>https://example.com/old</link>
          <guid>purged-old-item</guid><pubDate>${new Date(firstCheck - 25 * 60 * 60 * 1000).toUTCString()}</pubDate></item>
      </channel></rss>`),
    );
    const refreshedFeed = await getDb(env.DB)
      .select()
      .from(feeds)
      .where(eq(feeds.id, feed.id))
      .get();

    await expect(
      poller.poll(refreshedFeed as FeedToCheck, {
        cycleRunId: "cycle-late-items",
        attemptId: "attempt-late-items",
      }),
    ).resolves.toMatchObject({ outcome: "new_items", newItems: 1 });

    const stored = await env.DB.prepare(
      `SELECT title FROM items WHERE feed_id = ? ORDER BY title`,
    )
      .bind(feed.id)
      .all();
    expect(stored.results).toEqual([{ title: "Late Item" }]);
    const state = await env.DB.prepare(
      `SELECT last_successful_poll_at, last_new_item_discovered_at,
              initial_backload_completed_at, next_poll_at
         FROM feeds WHERE id = ?`,
    )
      .bind(feed.id)
      .first();
    expect(state).toEqual({
      last_successful_poll_at: currentTime,
      last_new_item_discovered_at: currentTime,
      initial_backload_completed_at: firstCheck,
      next_poll_at: currentTime + 30 * 60 * 1000,
    });
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
        nextPollAt: null,
      },
      {
        id: "not-due-feed",
        feedUrl: "https://not-due.example/feed.xml",
        title: "Not Due Feed",
        nextPollAt: now + 240 * 60_000,
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

  it("applies the same ownership rule to scheduled and forced Cycle Runs", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await db.insert(users).values({
      id: "overlap-user",
      email: "overlap@example.com",
      createdAt: now,
    });
    await db.insert(feeds).values({
      id: "overlap-feed",
      feedUrl: "https://overlap.example/feed.xml",
      title: "Overlap Feed",
    });
    await db.insert(subscriptions).values({
      id: "overlap-subscription",
      userId: "overlap-user",
      feedId: "overlap-feed",
    });
    let releaseScheduled: (response: Response) => void = () => {};
    const scheduledResponse = new Promise<Response>((resolve) => {
      releaseScheduled = resolve;
    });
    const fetchMock = vi.fn(() => scheduledResponse);
    vi.stubGlobal("fetch", fetchMock);

    const scheduledRun = runWorkflow("scheduled-owner", "scheduled");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await runWorkflow("forced-contender", "forced");
    releaseScheduled(new Response(EMPTY_RSS));
    await scheduledRun;

    const cycles = await env.DB.prepare(
      `SELECT id, checked_feeds, skipped_feeds, status
         FROM cycle_runs ORDER BY id`,
    ).all();
    expect(cycles.results).toEqual([
      {
        id: "forced-contender",
        checked_feeds: 0,
        skipped_feeds: 1,
        status: "completed",
      },
      {
        id: "scheduled-owner",
        checked_feeds: 1,
        skipped_feeds: 0,
        status: "completed",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
