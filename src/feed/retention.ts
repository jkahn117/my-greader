/**
 * Bounded Item and operational-history retention.
 *
 * The module owns cleanup ordering so retained Items never reference deleted
 * Feed attempts. Runtime adapters only choose when cleanup runs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const OPERATIONAL_HISTORY_RETENTION_DAYS = 90;
const ITEM_BATCH_SIZE = 500;
const HISTORY_BATCH_SIZE = 100;
const MAX_BATCHES_PER_KIND = 5;

export interface RetentionResult {
  itemsDeleted: number;
  statesDeleted: number;
  cycleRunsDeleted: number;
}

export interface RetentionManager {
  purge(itemRetentionDays: number): Promise<RetentionResult>;
}

/** Creates bounded retention operations over the shared D1 store. */
export function createRetentionManager(
  db: D1Database,
  clock: () => number = Date.now,
): RetentionManager {
  return { purge };

  /** Applies Item and operational-history policy in bounded batches. */
  async function purge(itemRetentionDays: number): Promise<RetentionResult> {
    const itemResult = await purgeItems(itemRetentionDays);
    const cycleRunsDeleted = await purgeOperationalHistory();
    return { ...itemResult, cycleRunsDeleted };
  }

  /** Deletes bounded batches of old Items only when no User has starred them. */
  async function purgeItems(retentionDays: number) {
    const cutoff = clock() - retentionDays * DAY_MS;
    let itemsDeleted = 0;
    let statesDeleted = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_KIND; batch += 1) {
      const expiredItems = `
        SELECT candidate.id
          FROM items candidate
         WHERE candidate.fetched_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM item_state starred
              WHERE starred.item_id = candidate.id
                AND starred.is_starred = 1
           )
         ORDER BY candidate.fetched_at, candidate.id
         LIMIT ?`;
      const results = await db.batch([
        db
          .prepare(
            `DELETE FROM item_state
              WHERE item_id IN (${expiredItems})`,
          )
          .bind(cutoff, ITEM_BATCH_SIZE),
        db
          .prepare(`DELETE FROM items WHERE id IN (${expiredItems})`)
          .bind(cutoff, ITEM_BATCH_SIZE),
      ]);
      const deletedThisBatch = results[1]?.meta.changes ?? 0;
      statesDeleted += results[0]?.meta.changes ?? 0;
      itemsDeleted += deletedThisBatch;
      if (deletedThisBatch < ITEM_BATCH_SIZE) break;
    }

    return { itemsDeleted, statesDeleted };
  }

  /** Detaches retained Items before deleting expired attempts and Cycle Runs. */
  async function purgeOperationalHistory(): Promise<number> {
    const cutoff = clock() - OPERATIONAL_HISTORY_RETENTION_DAYS * DAY_MS;
    let deletedCycleRuns = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_KIND; batch += 1) {
      const expiredCycleRuns = `
        SELECT id FROM cycle_runs
         WHERE ran_at < ?
         ORDER BY ran_at, id
         LIMIT ?`;
      const results = await db.batch([
        db
          .prepare(
            `UPDATE items
                SET first_ingestion_attempt_id = NULL
              WHERE first_ingestion_attempt_id IN (
                SELECT id FROM feed_poll_attempts
                 WHERE cycle_run_id IN (${expiredCycleRuns})
              )`,
          )
          .bind(cutoff, HISTORY_BATCH_SIZE),
        db
          .prepare(
            `UPDATE feeds
                SET poll_owner_attempt_id = NULL,
                    poll_lease_expires_at = NULL
              WHERE poll_owner_attempt_id IN (
                SELECT id FROM feed_poll_attempts
                 WHERE cycle_run_id IN (${expiredCycleRuns})
              )`,
          )
          .bind(cutoff, HISTORY_BATCH_SIZE),
        db
          .prepare(
            `DELETE FROM feed_poll_attempts
              WHERE cycle_run_id IN (${expiredCycleRuns})`,
          )
          .bind(cutoff, HISTORY_BATCH_SIZE),
        db
          .prepare(
            `DELETE FROM cycle_runs
              WHERE id IN (${expiredCycleRuns})`,
          )
          .bind(cutoff, HISTORY_BATCH_SIZE),
      ]);
      const deletedThisBatch = results[3]?.meta.changes ?? 0;
      deletedCycleRuns += deletedThisBatch;
      if (deletedThisBatch < HISTORY_BATCH_SIZE) break;
    }

    return deletedCycleRuns;
  }
}
