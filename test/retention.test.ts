import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createRetentionManager } from "../src/feed/retention";

const NOW = Date.UTC(2026, 3, 6, 3);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seeds Items in D1 without moving a large fixture through the Worker. */
async function seedItems(count: number, prefix: string, fetchedAt: number) {
  for (let start = 0; start < count; start += 1000) {
    const end = Math.min(count, start + 1000);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (
         SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?
       )
       INSERT INTO items (id, feed_id, fetched_at)
       SELECT ? || i, 'feed', ? FROM n`,
    )
      .bind(start, end, prefix, fetchedAt)
      .run();
  }
}

/** Seeds enough Cycle Runs to model the 30-minute polling schedule. */
async function seedCycleRuns(
  count: number,
  ranAt: number,
  prefix = "expired-",
) {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (
       SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?
     )
     INSERT INTO cycle_runs (id, ran_at)
     SELECT ? || i, ? FROM n`,
  )
    .bind(count, prefix, ranAt)
    .run();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feed_poll_attempts");
  await env.DB.exec("DELETE FROM cycle_runs");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM users");
  await env.DB.prepare(
    "INSERT INTO feeds (id, feed_url) VALUES ('feed', 'https://example.com/rss')",
  ).run();
});

describe("createRetentionManager", () => {
  it("drains a weekly backlog within the target across bounded runs", async () => {
    await seedItems(6_000, "first-", NOW - 31 * DAY_MS);
    await seedCycleRuns(336, NOW - 91 * DAY_MS, "first-");
    const retention = createRetentionManager(env.DB, () => NOW);

    expect(await retention.purge(30)).toEqual({
      itemsDeleted: 6_000,
      statesDeleted: 0,
      cycleRunsDeleted: 336,
      itemsBacklogRemaining: false,
      cycleRunsBacklogRemaining: false,
    });

    await seedItems(4_000, "second-", NOW - 31 * DAY_MS);
    await seedCycleRuns(336, NOW - 91 * DAY_MS, "second-");
    expect(await retention.purge(30)).toEqual({
      itemsDeleted: 4_000,
      statesDeleted: 0,
      cycleRunsDeleted: 336,
      itemsBacklogRemaining: false,
      cycleRunsBacklogRemaining: false,
    });
  });

  it("reports remaining eligible backlog after the per-run caps, then drains it", async () => {
    await seedItems(10_001, "old-", NOW - 31 * DAY_MS);
    await seedCycleRuns(401, NOW - 91 * DAY_MS);
    const retention = createRetentionManager(env.DB, () => NOW);

    expect(await retention.purge(30)).toEqual({
      itemsDeleted: 10_000,
      statesDeleted: 0,
      cycleRunsDeleted: 400,
      itemsBacklogRemaining: true,
      cycleRunsBacklogRemaining: true,
    });
    expect(await retention.purge(30)).toEqual({
      itemsDeleted: 1,
      statesDeleted: 0,
      cycleRunsDeleted: 1,
      itemsBacklogRemaining: false,
      cycleRunsBacklogRemaining: false,
    });
  });

  it("keeps a shared starred Item and its states, and detaches retained attribution before history deletion", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, email, created_at) VALUES ('reader', 'reader@example.com', ?)",
      ).bind(NOW),
      env.DB.prepare(
        "INSERT INTO users (id, email, created_at) VALUES ('saver', 'saver@example.com', ?)",
      ).bind(NOW),
    ]);
    await env.DB.prepare(
      "INSERT INTO cycle_runs (id, ran_at) VALUES ('old-run', ?)",
    )
      .bind(NOW - 91 * DAY_MS)
      .run();
    await env.DB.prepare(
      "INSERT INTO feed_poll_attempts (id, cycle_run_id, feed_id, started_at) VALUES ('old-attempt', 'old-run', 'feed', ?)",
    )
      .bind(NOW - 91 * DAY_MS)
      .run();
    await env.DB.prepare(
      "INSERT INTO items (id, feed_id, fetched_at, first_ingestion_attempt_id) VALUES ('saved', 'feed', ?, 'old-attempt')",
    )
      .bind(NOW - 31 * DAY_MS)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO item_state (item_id, user_id, is_read) VALUES ('saved', 'reader', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO item_state (item_id, user_id, is_starred) VALUES ('saved', 'saver', 1)",
      ),
    ]);
    const result = await createRetentionManager(env.DB, () => NOW).purge(30);

    expect(result).toEqual({
      itemsDeleted: 0,
      statesDeleted: 0,
      cycleRunsDeleted: 1,
      itemsBacklogRemaining: false,
      cycleRunsBacklogRemaining: false,
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT id, first_ingestion_attempt_id FROM items",
        ).all()
      ).results,
    ).toEqual([{ id: "saved", first_ingestion_attempt_id: null }]);
    expect(
      (
        await env.DB.prepare(
          "SELECT user_id, is_read, is_starred FROM item_state ORDER BY user_id",
        ).all()
      ).results,
    ).toEqual([
      { user_id: "reader", is_read: 1, is_starred: 0 },
      { user_id: "saver", is_read: 0, is_starred: 1 },
    ]);
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});
