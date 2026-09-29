import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import {
  LEGACY_MIGRATION,
  legacyExpectedState,
  readLegacyState,
  seedLegacyData,
} from "./fixtures/legacy-data";

/** Rebuilds this test file's isolated D1 database at the recorded legacy boundary. */
async function rebuildLegacyDatabase(migrations: D1Migration[]) {
  await env.DB.exec(`
    DROP TABLE IF EXISTS item_state;
    DROP TABLE IF EXISTS api_tokens;
    DROP TABLE IF EXISTS subscriptions;
    DROP TABLE IF EXISTS items;
    DROP TABLE IF EXISTS feed_poll_attempts;
    DROP TABLE IF EXISTS cycle_runs;
    DROP TABLE IF EXISTS feeds;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS d1_migrations;
    DROP TABLE IF EXISTS migration_baseline;
    DROP TABLE IF EXISTS additive_migrations;
  `);

  const baselineIndex = migrations.findIndex(
    (migration) => migration.name === LEGACY_MIGRATION,
  );
  expect(baselineIndex).toBeGreaterThanOrEqual(0);

  const baselineMigrations = migrations.slice(0, baselineIndex + 1);
  const additiveMigrations = migrations.slice(baselineIndex + 1);
  await applyD1Migrations(env.DB, baselineMigrations, "migration_baseline");

  return additiveMigrations;
}

describe("legacy data migration", () => {
  it("preserves legacy identifiers, relationships, feed health, and token hashes", async () => {
    const migrations = JSON.parse(
      (env as unknown as Record<string, string>).TEST_MIGRATIONS,
    ) as D1Migration[];
    const additiveMigrations = await rebuildLegacyDatabase(migrations);

    await seedLegacyData(env.DB);
    expect(await readLegacyState(env.DB)).toEqual(legacyExpectedState);

    await applyD1Migrations(env.DB, additiveMigrations, "additive_migrations");

    expect(await readLegacyState(env.DB)).toEqual(legacyExpectedState);

    const legacyItems = await env.DB.prepare(
      "SELECT first_ingestion_attempt_id FROM items ORDER BY id",
    ).all();
    expect(legacyItems.results).toEqual([
      { first_ingestion_attempt_id: null },
      { first_ingestion_attempt_id: null },
    ]);

    const legacyCycle = await env.DB.prepare(
      `SELECT started_at, completed_at, trigger_reason, status
       FROM cycle_runs WHERE id = ?`,
    )
      .bind("1700000300000")
      .first();
    expect(legacyCycle).toEqual({
      started_at: null,
      completed_at: null,
      trigger_reason: null,
      status: null,
    });

    const attempts = await env.DB.prepare(
      "SELECT count(*) AS count FROM feed_poll_attempts",
    ).first<{ count: number }>();
    expect(attempts?.count).toBe(0);

    const foreignKeyViolations = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all();
    expect(foreignKeyViolations.results).toEqual([]);
  });
});
