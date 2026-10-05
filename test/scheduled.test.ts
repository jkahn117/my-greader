import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import {
  apiTokens,
  cycleRuns,
  feedPollAttempts,
  feeds,
  items,
  itemState,
  subscriptions,
  users,
} from "../src/db/schema";

const NOW = Date.UTC(2026, 3, 6, 3);
const DAY_MS = 24 * 60 * 60 * 1000;

// Seed eligible and protected records together so dispatch mistakes have observable effects.
async function seedCleanupJourney(): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(users).values([
    { id: "reader", email: "reader@example.com", createdAt: NOW },
    { id: "other-reader", email: "other@example.com", createdAt: NOW },
  ]);
  await db.insert(feeds).values({
    id: "feed",
    feedUrl: "https://example.com/feed.xml",
    pollOwnerAttemptId: "old-attempt",
    pollLeaseExpiresAt: NOW - 91 * DAY_MS,
  });
  await db.insert(cycleRuns).values([
    { id: "old-cycle", ranAt: NOW - 91 * DAY_MS },
    { id: "boundary-cycle", ranAt: NOW - 90 * DAY_MS },
    { id: "recent-cycle", ranAt: NOW - DAY_MS },
  ]);
  await db.insert(feedPollAttempts).values([
    {
      id: "old-attempt",
      cycleRunId: "old-cycle",
      feedId: "feed",
      startedAt: NOW - 91 * DAY_MS,
    },
    {
      id: "boundary-attempt",
      cycleRunId: "boundary-cycle",
      feedId: "feed",
      startedAt: NOW - 90 * DAY_MS,
    },
    {
      id: "recent-attempt",
      cycleRunId: "recent-cycle",
      feedId: "feed",
      startedAt: NOW - DAY_MS,
    },
  ]);
  await db.insert(items).values([
    {
      id: "expired-item",
      feedId: "feed",
      fetchedAt: NOW - 31 * DAY_MS,
      firstIngestionAttemptId: "old-attempt",
    },
    {
      id: "recent-item",
      feedId: "feed",
      fetchedAt: NOW - 29 * DAY_MS,
      firstIngestionAttemptId: "recent-attempt",
    },
    {
      id: "shared-starred-item",
      feedId: "feed",
      fetchedAt: NOW - 91 * DAY_MS,
      firstIngestionAttemptId: "old-attempt",
    },
  ]);
  await db.insert(itemState).values([
    { itemId: "expired-item", userId: "reader", isRead: 1 },
    { itemId: "recent-item", userId: "reader", isRead: 1 },
    { itemId: "shared-starred-item", userId: "reader", isRead: 1 },
    { itemId: "shared-starred-item", userId: "other-reader", isStarred: 1 },
  ]);
  await db.insert(apiTokens).values([
    {
      id: "old-token",
      userId: "reader",
      name: "Old",
      tokenHash: "old-hash",
      createdAt: NOW - 20 * DAY_MS,
      revokedAt: NOW - 8 * DAY_MS,
    },
    {
      id: "boundary-token",
      userId: "reader",
      name: "Boundary",
      tokenHash: "boundary-hash",
      createdAt: NOW - 20 * DAY_MS,
      revokedAt: NOW - 7 * DAY_MS,
    },
    {
      id: "recent-token",
      userId: "reader",
      name: "Recent",
      tokenHash: "recent-hash",
      createdAt: NOW - 20 * DAY_MS,
      revokedAt: NOW - 6 * DAY_MS,
    },
    {
      id: "active-token",
      userId: "reader",
      name: "Active",
      tokenHash: "active-hash",
      createdAt: NOW - 20 * DAY_MS,
    },
  ]);
}

// Compare complete persisted state before and after an unknown schedule, without fixed snapshots.
async function persistedCleanupState() {
  const db = getDb(env.DB);
  return {
    tokens: await db.select().from(apiTokens).orderBy(apiTokens.id).all(),
    items: await db.select().from(items).orderBy(items.id).all(),
    states: await db
      .select()
      .from(itemState)
      .orderBy(itemState.itemId, itemState.userId)
      .all(),
    cycles: await db.select().from(cycleRuns).orderBy(cycleRuns.id).all(),
    attempts: await db
      .select()
      .from(feedPollAttempts)
      .orderBy(feedPollAttempts.id)
      .all(),
    feeds: await db.select().from(feeds).orderBy(feeds.id).all(),
    users: await db.select().from(users).orderBy(users.id).all(),
    subscriptions: await db
      .select()
      .from(subscriptions)
      .orderBy(subscriptions.id)
      .all(),
  };
}

let create: ReturnType<typeof vi.fn<Env["FEED_POLLING_WORKFLOW"]["create"]>>;
let bindings: Env;

// Fail loudly if dispatch expands beyond the agreed creation-only boundary.
async function unsupportedWorkflowOperation(): Promise<never> {
  throw new Error("Only Workflow creation is supported by this recording fake");
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feed_poll_attempts");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM users");
  create = vi.fn(async () => ({ id: "recorded-workflow" }) as WorkflowInstance);
  bindings = {
    ...env,
    // Only creation is used at this boundary; the fake does not execute a Workflow.
    FEED_POLLING_WORKFLOW: {
      create,
      get: unsupportedWorkflowOperation,
      createBatch: unsupportedWorkflowOperation,
    },
  };
});

afterEach(() => vi.restoreAllMocks());

describe("scheduled Worker dispatch", () => {
  it.each(["0 * * * *", "", "*/30 * * * * "])(
    "does not start work or mutate persisted data for unknown schedule %j",
    async (cron) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      await seedCleanupJourney();
      const before = await persistedCleanupState();

      await worker.scheduled({ cron } as ScheduledEvent, bindings);

      expect(create).not.toHaveBeenCalled();
      expect(await persistedCleanupState()).toEqual(before);
    },
  );

  it("runs token, Item, and operational-history cleanup together without losing protected data", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await seedCleanupJourney();

    await worker.scheduled({ cron: "0 3 * * 1" } as ScheduledEvent, bindings);

    const state = await persistedCleanupState();
    expect(state.tokens.map((token) => token.id)).toEqual([
      "active-token",
      "recent-token",
    ]);
    expect(
      state.items.map((item) => ({
        id: item.id,
        attemptId: item.firstIngestionAttemptId,
      })),
    ).toEqual([
      { id: "recent-item", attemptId: "recent-attempt" },
      { id: "shared-starred-item", attemptId: null },
    ]);
    expect(
      state.states.map((item) => ({
        id: item.itemId,
        userId: item.userId,
        read: item.isRead,
        starred: item.isStarred,
      })),
    ).toEqual([
      { id: "recent-item", userId: "reader", read: 1, starred: 0 },
      {
        id: "shared-starred-item",
        userId: "other-reader",
        read: 0,
        starred: 1,
      },
      { id: "shared-starred-item", userId: "reader", read: 1, starred: 0 },
    ]);
    expect(state.cycles.map((cycle) => cycle.id)).toEqual([
      "boundary-cycle",
      "recent-cycle",
    ]);
    expect(state.attempts.map((attempt) => attempt.id)).toEqual([
      "boundary-attempt",
      "recent-attempt",
    ]);
    expect(state.feeds[0]).toMatchObject({
      pollOwnerAttemptId: null,
      pollLeaseExpiresAt: null,
    });
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves forced attribution through the authenticated sync route", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://localhost/app/api/feeds/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      triggered: true,
      forced: true,
    });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      params: { triggerReason: "forced" },
    });
  });

  it("awaits one scheduled Workflow creation before completing", async () => {
    const creation = Promise.withResolvers<WorkflowInstance>();
    create.mockReturnValue(creation.promise);
    let completed = false;
    const dispatch = worker
      .scheduled({ cron: "*/30 * * * *" } as ScheduledEvent, bindings)
      .then(() => {
        completed = true;
      });

    try {
      // Let an incorrectly unawaited dispatch settle without releasing creation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(create).toHaveBeenCalledExactlyOnceWith({
        params: { triggerReason: "scheduled" },
      });
      expect(completed).toBe(false);
    } finally {
      creation.resolve({ id: "recorded-workflow" } as WorkflowInstance);
      await dispatch;
    }
    expect(completed).toBe(true);
  });

  it("propagates Workflow creation failure without logging a successful start", async () => {
    const output = vi.spyOn(console, "log");
    const failure = new Error("Workflow service unavailable");
    create.mockRejectedValue(failure);

    await expect(
      worker.scheduled({ cron: "*/30 * * * *" } as ScheduledEvent, bindings),
    ).rejects.toBe(failure);

    expect(create).toHaveBeenCalledExactlyOnceWith({
      params: { triggerReason: "scheduled" },
    });
    expect(output.mock.calls.flat().join(" ")).not.toContain(
      "feed polling workflow started",
    );
  });
});
