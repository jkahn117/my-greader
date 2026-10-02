# Migration baseline and recovery

Issue [#19](https://github.com/jkahn117/my-greader/issues/19) records the compatibility baseline before polling persistence changes. The database boundary is `0005_query_performance_indexes.sql`, on code baseline `e6d9436`.

## Baseline checks

Run these before and after every additive migration stage:

```bash
pnpm exec vitest run test/migrations.test.ts
pnpm exec vitest run test/greader.test.ts
pnpm exec vitest run test/polling-outcomes.test.ts
pnpm exec tsc --noEmit
pnpm lint
pnpm build
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

## Feed ownership rollout

Migration `0008_feed_poll_ownership.sql` is additive and must run after `0007`. It adds a nullable owner and lease expiry plus a default-zero fencing number to each Feed. Feed attempts gain a nullable ownership fence. Existing rows start unowned and retain their outcomes.

The code before this migration does not acquire ownership, so an old Workflow must not overlap a new one. Use this deployment order:

1. Pause scheduled polling and avoid normal or forced manual syncs.
2. Let every old Workflow instance finish. Terminate any instance that cannot drain, then verify that no old instance is running.
3. Run the baseline checks, export D1, apply `0008`, and verify row counts plus `PRAGMA foreign_key_check`.
4. Deploy the ownership-aware Worker.
5. Run one forced sync as a canary. Verify its Cycle Run completes and any concurrent test request records the busy Feed as skipped.
6. Restore scheduled and manual polling.

Do not rely on a rolling code deployment to protect old instances. Their polling path predates the ownership check and can still write Feed state.

The previous Worker can read the additive schema, but rollback has the same execution boundary. Pause all polling entry points and drain or terminate ownership-aware Workflows before deploying the old Worker. Leave `0008` in place. After ownership-aware writes begin, prefer a forward fix because the old Worker bypasses the ownership contract. A database restore requires stopping all writers first.

## Explicit Feed state rollout

Migration `0009_explicit_feed_state.sql` is additive and must run after `0008`. It adds separate timestamps for successful checks, precise new-Item discovery, initial backload completion, and next eligibility, plus a Deactivation reason.

The migration preserves uncertainty:

- `last_successful_poll_at` and `last_new_item_discovered_at` remain `NULL` for every legacy Feed. The overloaded historical timestamps cannot prove either event.
- A non-null legacy `last_new_item_at` proves that the old poller completed initial backload, including for an empty Feed, so it initializes `initial_backload_completed_at` and marks `poll_state_origin` as `legacy_inferred`.
- Other legacy Feeds use `poll_state_origin = legacy_uncertain`; the dashboard does not call their unknown backload history pending or complete.
- `next_poll_at` receives the old eligibility calculation, `last_fetched_at + check_interval_minutes * 60000`.
- Existing deactivated Feeds receive `legacy_unknown`; the migration does not guess whether a User or an error threshold deactivated them.

Apply the schema before deploying the new Worker. Pause polling and drain existing Workflow instances first because the previous code writes only the overloaded columns while the new code reads only the explicit columns. Run one scheduled and one forced canary after deployment. Verify successful-check and next-eligibility timestamps, an empty Feed's backload completion, and an automatic Deactivation reason.

The `last_fetched_at` and `last_new_item_at` columns stay in place for schema-level rollback compatibility, but the new Worker does not read or write them. Do not deploy the old Worker after new polling writes begin: it cannot interpret explicit backload completion and may repeat an initial backload. Prefer a forward fix. If rollback is unavoidable, stop all writers and restore the pre-migration export with the matching old Worker. Remove the compatibility columns only after the final migration observation window closes and no rollback target reads them.

## Final cutover runbook

This is the supported deployment path for migrations `0006` through `0009` and the cutover Worker. Keep a deployment log with command output, row counts, version IDs, Workflow instance IDs, canary Cycle Run IDs, and the manual Current result. Never store the D1 export or token values in the repository.

### 1. Rehearse locally

Run the full gate:

```bash
pnpm exec vitest run test/migrations.test.ts
pnpm exec vitest run test/greader.test.ts
pnpm exec vitest run test/polling-outcomes.test.ts
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

`test/migrations.test.ts` rebuilds representative data at migration `0005`, applies every additive migration, compares stable IDs and relationships, and runs `PRAGMA foreign_key_check`. The Workflow suite covers empty, failed, retried, overlapping, interrupted, and Analytics Engine failure paths. Local Workflow doubles prove application idempotency, not Cloudflare runtime scheduling. Run the canaries below against Cloudflare before declaring the cutover complete.

### 2. Export and verify recovery data

Record baseline table counts, export remote D1 outside the checkout, hash the file, and prove that SQLite can restore it:

```bash
mkdir -p ../my-greader-deployment
pnpm wrangler d1 export rss-reader --remote \
  --output ../my-greader-deployment/before-cutover.sql
shasum -a 256 ../my-greader-deployment/before-cutover.sql \
  > ../my-greader-deployment/before-cutover.sql.sha256

rm -f /tmp/my-greader-restore-check.sqlite
sqlite3 /tmp/my-greader-restore-check.sqlite \
  < ../my-greader-deployment/before-cutover.sql
sqlite3 /tmp/my-greader-restore-check.sqlite \
  'PRAGMA integrity_check; PRAGMA foreign_key_check;
   SELECT "users", count(*) FROM users
   UNION ALL SELECT "feeds", count(*) FROM feeds
   UNION ALL SELECT "subscriptions", count(*) FROM subscriptions
   UNION ALL SELECT "items", count(*) FROM items
   UNION ALL SELECT "item_state", count(*) FROM item_state
   UNION ALL SELECT "api_tokens", count(*) FROM api_tokens;'
```

The integrity result must be `ok`, the foreign-key query must return no rows, and counts must match production. Keep the export encrypted under the operator's normal backup policy. A checksum alone does not prove recovery; the temporary import is required.

### 3. Stop old polling writers

Pause both cron triggers in Cloudflare and avoid the normal and forced dashboard sync controls. List queued and running instances:

```bash
pnpm wrangler workflows instances list feed-polling --status queued
pnpm wrangler workflows instances list feed-polling --status running
```

Let old instances complete. For each instance that cannot drain, record its ID and terminate it:

```bash
pnpm wrangler workflows instances terminate feed-polling <instance-id>
```

Repeat both list commands until neither reports an instance. Do not rely on a rolling Worker deployment. The cutover Worker no longer accepts the old `force` payload, and old polling code does not share every final invariant.

### 4. Migrate and deploy

Apply all pending migrations while writers remain stopped:

```bash
pnpm wrangler d1 migrations apply rss-reader --remote
pnpm deploy
```

Record the deployed Worker version ID. Recheck the six baseline counts and `PRAGMA foreign_key_check` before restoring traffic. A count change at this point is a failed migration because the additive migrations do not delete domain data.

### 5. Run Cloudflare and Current canaries

Restore manual polling first, but leave the scheduled trigger paused.

1. Run a normal manual sync. Confirm its Cycle Run has the `manual` trigger, reaches a terminal outcome, and reconciles with its Feed attempts.
2. Run a forced sync and a second concurrent forced sync. Confirm busy Feeds are skipped, no stale owner changes Feed state, and both Cycle Runs finish or show an explicit interruption.
3. Use an existing API Token in Current. Confirm ClientLogin, Subscription titles and Folders, Item IDs, read state, starred state, and a two-way read transition without generating a replacement token.
4. Check `/app/timeline` for the canary Cycle Run and attempt IDs. Match those IDs in structured logs.
5. If Analytics Engine is configured, check its optional cards. Then temporarily set `ANALYTICS_ENABLED=false` in the canary environment and confirm durable Timeline and Feed diagnostics still work.
6. Restore scheduled polling and confirm the next scheduled Cycle Run.

Keep the observation window open for at least seven days and through one weekly retention run. Review scheduler gaps, failure rates, unfinished attempts, reconciliation errors, ownership skips, Current sync, and retention before closing it.

### 6. Recover a failed cutover

Before the migrated Worker receives traffic, roll back the Worker and leave additive migrations in place only if that Worker is documented as compatible. Migration `0009` is not compatible with the pre-migration poller once writes resume.

After new polling writes start, stop cron and manual writers first. Prefer a forward fix. The immediately preceding `next` release at `0e8443c` uses the same schema and is the only planned temporary code rollback for this final cutover. Record why it is needed and redeploy the cutover after repair.

If data is damaged or an older Worker is unavoidable, keep all writers stopped, preserve the failed database for diagnosis, restore the verified export into a replacement D1 database, bind the matching Worker version to it, repeat the full data and Current checks, and only then switch traffic. Never import the export over a live database.

## Cutover audit record

The repository rehearsal covers additive migration of representative data, foreign-key verification, GReader behavior, domain D1 behavior, Workflow retry and overlap behavior, lint, type checking, and production build. Backup export, Cloudflare Workflow drainage, deployed canaries, and the manual Current check are operator gates because local tests cannot prove them. Attach their results to the deployment log before closing the production observation window.
