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
