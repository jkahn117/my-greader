# Migration baseline and recovery

Issue [#19](https://github.com/jkahn117/my-greader/issues/19) records the compatibility baseline before polling persistence changes. The database boundary is `0005_query_performance_indexes.sql`, on code baseline `e6d9436`.

## Baseline checks

Run these before and after every additive migration stage:

```bash
pnpm exec vitest run test/migrations.test.ts
pnpm exec vitest run test/greader.test.ts
pnpm lint
```

`test/fixtures/legacy-data.ts` represents a populated database at the boundary. `test/migrations.test.ts` rebuilds D1 through migration `0005`, loads the fixture, applies every later migration, and compares the preserved state. It also runs `PRAGMA foreign_key_check`.

The comparison covers:

- Item IDs and their Feed relationships
- per-User read and starred Item State, including `read_at`
- Subscription IDs, custom titles, Folders, Users, and Feeds
- Feed polling health fields, conditional request values, Backoff, and Deactivation
- API Token hashes, ownership, and revocation state

The fixture contains active and deactivated Feeds, two Users, shared domain relationships, and both active and revoked API Tokens. Add fields to this fixture when a migration stage starts depending on them. Do not move `LEGACY_MIGRATION`; it marks the schema that production data already uses.

`test/greader.test.ts` is the Current/FreshRSS HTTP baseline. It covers bare and `/api/greader.php` routes, accepted Item and Feed references, malformed request status codes, Stream scopes and cutoffs, equal-timestamp pagination, and per-User visibility.

## Before applying a migration

1. Run the baseline checks against the proposed migration.
2. Export the remote D1 database. Store the export outside the repository because it contains API Token hashes and feed data.

   ```bash
   pnpm wrangler d1 export rss-reader --remote --output backup-before-migration.sql
   ```

3. Record baseline row counts for `users`, `feeds`, `subscriptions`, `items`, `item_state`, and `api_tokens`. Keep the output with the deployment record.
4. Confirm that the previous Worker version can read the additive schema. New tables and columns must be nullable or have defaults until the rollback window closes.
5. Apply schema migrations before deploying code that writes the new fields.

## Verification and recovery

After migration, rerun the row counts and `PRAGMA foreign_key_check`. Then use an existing API Token with Current or the GReader endpoints and verify:

- ClientLogin succeeds without issuing a new API Token.
- `subscription/list` retains custom titles and Folders.
- `stream/items/ids` returns the same IDs for existing Items.
- a known read and starred Item retains both states.

If a check fails before new code receives traffic, stop the deployment and keep the export unchanged. Prefer rolling the Worker back while leaving additive schema in place. Do not use a destructive down-migration.

If the migration changed data, do not import the backup over an active database. Disable writers, preserve the failed database for diagnosis, and either restore the export into a replacement D1 database or deploy a tested forward repair. Repeat the fixture, row-count, foreign-key, and Current checks before switching traffic.

A Worker rollback is safe only while the old version ignores all new nullable or defaulted fields. Once new writes no longer fit the old model, recovery requires a forward fix or a restored database plus the matching Worker version.

## Poll traceability rollout

Migration `0006_poll_traceability.sql` is additive. Apply it before deploying the Worker version that passes Cycle Run and attempt identities into `FeedPoller`.

The migration adds nullable lifecycle fields to `cycle_runs`, creates `feed_poll_attempts`, and adds nullable `items.first_ingestion_attempt_id`. It does not update existing rows. Legacy Items and Cycle Runs therefore remain explicitly unattributed.

The previous Worker version remains readable after the migration because it ignores the new table and columns. A code rollback may leave new attempt rows and Item references in place. The previous version can still read and insert Items because the attribution column is nullable. Items ingested during the rollback will be unattributed. Do not remove the new schema as part of rollback.

Before deployment, run the migration and GReader compatibility tests, export D1, apply the migration, and verify row counts plus `PRAGMA foreign_key_check`. Then deploy the Worker. If verification fails before traffic reaches the new code, roll back the Worker and retain the additive schema. If new writes have started, prefer a forward fix; restoring the export requires stopping all writers first.

## Explicit polling outcomes rollout

Migration `0007_poll_outcomes.sql` is additive and must run after `0006`. It adds default-zero selected and skipped counts plus a nullable Cycle Run outcome. It also adds nullable classification, HTTP, parser, and bounded diagnostic fields to Feed attempts. Existing Cycle Runs keep unknown outcomes, and existing attempts keep unknown diagnostic fields. The migration does not reinterpret historical counts or statuses.

Apply `0007` before deploying code that writes in-progress attempts prior to HTTP work. The previous Worker ignores every new column, so a Worker rollback remains readable. New attempt outcomes written before rollback remain in the existing `outcome` column, but the previous Worker does not display their added classification detail. Keep the additive schema in place during rollback. Use the same export, row-count, foreign-key, GReader, and Current checks described above.
