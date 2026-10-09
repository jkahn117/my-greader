# Parallel deployment and production cutover

Status: draft for operator review. This is a plan, not yet an executable runbook. No Cloudflare resources have been created or changed for it.

## Goal and approach

Run `next` at a separate hostname, test the complete system with Current on the second device, then move `reader.iamjkahn.com` to the new Worker. Keep the everyday Current connection unchanged.

Production remains authoritative during the trial. Before promotion, copy production again while all production writers are stopped. Migrate that final copy and bind the new Worker to it. Do not promote the trial database or merge its changes into production.

The Worker and application code tested during the trial are retained. The final database is a fresh resource, so bindings and migration results need another short verification before traffic moves.

The existing [migration baseline](migration-baseline.md) remains the reference for schema semantics and compatibility. Its in-place cutover procedure is not the deployment topology proposed here. In this plan, the old database is never migrated, and old and new pollers never share a database.

## Resource inventory

Names below are proposed except for the existing resources. Record actual resource IDs before execution.

| Resource | Existing production | Trial | Final production |
| --- | --- | --- | --- |
| Worker | `my-greader` | `my-greader-next` | Same candidate Worker |
| Public hostname | `reader.iamjkahn.com` | `reader-next.iamjkahn.com` | Existing hostname moves to candidate |
| D1 | `rss-reader` | `rss-reader-rehearsal` | Fresh `rss-reader-cutover` |
| Workflow | `feed-polling` | `feed-polling-next` | Candidate Workflow, drained before rebinding D1 |
| Analytics Engine | Existing dataset | Separate trial dataset, or disabled | Separate new-production dataset |
| API Token | Everyday Current token | Dedicated second-device token | Existing production tokens preserved |
| Cron triggers | Existing schedules | Explicit trial schedules | Verified production schedules |

Bindings retain the code's names, such as `DB` and `FEED_POLLING_WORKFLOW`; their resource targets differ. Use a distinct native rate-limit namespace for the candidate. Never reuse production D1, Workflow, or Analytics Engine bindings during the trial.

The trial hostname may remain attached during validation. After cutover, remove it or restrict it so the second device cannot keep making unintended changes to production.

## Decisions to approve before implementation

- Finish dashboard functionality needed to inspect Feed failures, Cycle Run progress, and current Feed health. Visual polish and unrelated dashboard work do not block the trial. Use D1 and structured logs where the UI cannot yet answer a question.
- Use a refreshed production snapshot at cutover. Trial read/star changes, Subscriptions, new Items, and generated API Tokens are disposable.
- Accept a maintenance window for the final export, restore, migrations, and verification. Estimate its duration from the rehearsal rather than promising a zero-downtime swap.
- Preserve the old Worker and untouched production database for recovery. They are not kept as an active second backend after cutover.
- Keep the observation window open for at least seven days and one verified weekly retention run.

## Preparation gates

These are implementation prerequisites, not capabilities already present in the repository.

- [ ] Add explicit, reviewed candidate deployment configuration. Every resource target, route, secret, and cron schedule must be visible. The current `pnpm deploy` targets production and must not be used to create the candidate.
- [ ] Choose and test a maintenance mechanism that blocks all HTTP requests to the frozen environment before application code runs. Blocking only mutation routes is insufficient: authenticated API reads update API Token usage, and dashboard login can provision a User. A temporary maintenance Worker or equivalent edge gate should return `503`, not a successful empty feed or a login redirect.
- [ ] Establish how to stop scheduled dispatch and retention, drain background invocations, and enumerate every nonterminal Workflow instance, including waiting or paused instances. Removing cron triggers alone does not stop existing Workflows.
- [ ] Rehearse custom-domain reassignment with disposable resources. Record the exact dashboard or API actions, expected interruption, reverse actions, and how to confirm the hostname's Worker owner. Do not assume the operation is atomic.
- [ ] Reconcile Wrangler route declarations with the intended domain owner. An old deployment must not reclaim the production hostname or re-enable old schedules.
- [ ] Set up candidate Access policies before exposing copied data. Protect all management paths; bypass only the required GReader API paths. Keep `workers.dev` and public preview access disabled unless explicitly secured.
- [ ] Verify Access issuer, audience, and User identity on both hostnames. The candidate must accept the assertion issued for the production hostname after reassignment. Use an Access application covering both hostnames, or an explicitly rehearsed audience/configuration change.
- [ ] Verify that the same Access identity resolves to the copied `users.id`, with its existing Subscriptions, rather than provisioning an empty second User. Stop if identities differ; do not improvise an identity migration during cutover.
- [ ] Configure required secrets separately for the candidate. Never enable `DEV_MODE` remotely. Decide whether optional Analytics Engine reads/writes are enabled for each phase.
- [ ] Inventory the actual deployed code version, D1 migration history, schema, Workflow names, schedules, and all client devices. Do not assume production is at migration `0005` solely because the baseline fixture is.
- [ ] Select a clean, committed candidate revision and record its SHA, build inputs, configuration, and Worker version ID. Run `pnpm check` and the migration baseline checks. The current working tree has uncommitted work and is not a release artifact.
- [ ] Prepare export, restore, migrate, comparison, and smoke-test commands with explicit configuration and database targets. Review them before any remote operation. Keep exports and raw API Tokens outside the repository and out of logs.

Cloudflare documents that cron changes can take time to propagate. Wait for propagation and verify actual inactivity, rather than treating removal from configuration as a freeze. See the [Cron Trigger documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Phase 1: rehearse against real data

### Take the rehearsal snapshot

1. Fully sync everyday Current to production. Stop using it briefly during the snapshot.
2. Apply the production maintenance gate. Stop both polling and retention dispatch, wait for propagation, and drain all background work. Let Workflows finish where possible; record any terminated instance.
3. Verify no client, dashboard request, cron invocation, Workflow, or other writer can change production D1. Recheck the Workflow inventory and relevant logs.
4. Record migration history and domain table counts. Export production outside the repository, checksum it, restore it into a local SQLite database, and check integrity and foreign keys.
5. Restore the export into the fresh rehearsal D1 database. Verify the restored data against the export before migrations.
6. Remove production maintenance and restore its original schedules. Confirm everyday Current still syncs. Production is authoritative again.

A short freeze makes the rehearsal snapshot represent a drained system rather than carrying half-finished polling work into an unrelated Workflow deployment. If that freeze is not acceptable, define and test snapshot reconciliation before taking a live copy.

### Migrate and deploy the candidate

1. Keep the candidate inaccessible and unscheduled until copied data and Access protections are ready.
2. Apply all pending migrations to rehearsal D1 only. Record exactly which migrations ran.
3. Compare IDs and relationships for Users, Feeds, Subscriptions, Items, Item State, and API Tokens against the restored snapshot. Verify custom titles, Folders, read timestamps, starred state, and token revocation. Row counts alone are not enough.
4. Run integrity and foreign-key checks. Verify the expected additive Feed-state changes described in the migration baseline; do not expect legacy polling timestamps to become precise new history.
5. Deploy the selected candidate revision at the trial hostname with rehearsal bindings and no schedules initially.
6. Confirm browser authentication, copied User identity, and API authentication. An API request must receive a protocol response, not an Access redirect.
7. Generate a dedicated second-device API Token in the rehearsal database. Copied production token hashes are sensitive and remain valid in the clone; do not circulate or log them.

Gate: correct bindings, migrated data preserved, authentication works, and no candidate resource writes into production.

## Phase 2: second-device E2E trial

Connect the second device in Current's FreshRSS mode to the trial hostname. Leave the everyday device on production.

Record a small set of known Items and Subscriptions to use throughout verification.

- [ ] Subscriptions retain custom titles and Folders; existing Item IDs, read state, and starred state match the snapshot.
- [ ] Current sync succeeds without browser authentication redirects or repeated full resynchronization.
- [ ] Mark a known Item read, then unread. Confirm each transition reaches rehearsal D1 and survives a fresh Current sync.
- [ ] Star and unstar a known Item, then verify persistence. Make test Subscription edits and verify them if Current exposes those controls.
- [ ] Run a normal manual sync and a forced sync. Verify terminal Cycle Runs and their Feed attempts in D1, logs, and available dashboard views.
- [ ] Run overlapping forced syncs. Confirm ownership skips and reconciled outcomes rather than duplicate or stale writes.
- [ ] Enable candidate schedules and observe actual scheduled delivery. Use a controlled Feed to prove a new Item reaches D1 and then Current; empty cycles alone do not prove ingestion.
- [ ] Exercise a controlled Feed failure and confirm useful diagnostics. Do not intentionally break real publishers.
- [ ] Verify durable diagnostics work with Analytics Engine disabled. Optional trend cards must not be required to establish polling success.
- [ ] Exercise retention on disposable rehearsal data and verify starred preservation. Observe real scheduled retention delivery before closing the overall observation window.
- [ ] Record Workflow IDs, Cycle Run IDs, failures, and elapsed restore/migration time. Do not record raw API Tokens or feed response bodies containing private data.

Gate: no unexplained protocol regressions, data loss, stuck runs, or reconciliation failures. Ordinary publisher failures are acceptable when classified and visible. If application code changes to fix a failure, record the new revision and rerun affected checks before calling it the cutover candidate.

The dashboard can be unfinished aesthetically. Missing diagnostics must have a documented D1/log verification path, not an unchecked acceptance box.

## Phase 3: prepare final promotion

1. Disconnect or reset the second device's test connection. Verify it will not replay queued trial read/star or Subscription changes into the refreshed database. Do not simply leave Current pointed at a hostname whose database will be replaced.
2. Freeze the candidate, remove trial schedules, wait for propagation, and drain all its nonterminal Workflow instances and retention work.
3. Preserve the rehearsal database for troubleshooting. Create a fresh final D1 database rather than importing over the trial database.
4. Prepare candidate configuration pointing to final D1, with schedules still disabled. Keep the tested application revision pinned; document every configuration difference.
5. Prepare Access audience handling for both hostnames and the custom-domain transfer and reversal steps.
6. Review the checklist, recovery decision table below, and expected maintenance duration before starting.

Gate: no test device or old candidate Workflow can write to the final database when its binding changes.

## Phase 4: final snapshot and migration

1. Finish everyday Current sync, confirm its changes reached production, then close or disconnect all production clients.
2. Freeze production HTTP traffic, polling, and retention using the rehearsed procedure. Drain all old background writers. Keep production frozen for the remainder of the cutover.
3. Record the freeze timestamp, old Worker version, database ID, schedules, Workflow inventory, migration history, baseline counts, and sampled protocol IDs/state.
4. Export production again. This is the authoritative recovery snapshot, not the earlier rehearsal export. Checksum it and prove local restore, integrity, and foreign-key checks.
5. Restore it into final D1. Verify restoration before migration, including migration history.
6. Apply pending migrations to final D1. Repeat the data preservation comparisons and integrity checks from Phase 1.
7. Bind the candidate to final D1 and deploy the pinned application revision with schedules disabled and the maintenance gate still controlling public access.
8. Use narrowly controlled operator access to the trial hostname for authentication and API canaries. Confirm copied API Tokens work, the Access User is correct, and the second device remains disconnected.
9. Run one normal and one forced polling canary. Record resulting writes and terminal outcomes. Undo deliberate read/star test changes before opening regular traffic.

Gate: final data is preserved, candidate points only at final resources, and canaries pass. Stop before transferring the production hostname if anything is unexplained.

Canaries write only to final D1. Old production remains frozen and untouched, so abandoning this phase does not require down-migrating or restoring its database.

## Phase 5: move the regular hostname

1. Keep regular client traffic behind maintenance while reassigning `reader.iamjkahn.com` from the old Worker to the candidate through Cloudflare Custom Domains. This is not a CNAME switch.
2. Verify the hostname's Worker owner, TLS, and effective Access policies. Confirm management authentication and GReader API bypass separately on the regular hostname.
3. Verify the Worker version and final D1 binding serving that hostname. Do not infer successful transfer solely from an HTTP `200`.
4. Align checked-in deployment configuration with the new domain owner and disabled old schedules. No subsequent deployment may undo the transfer.
5. Open regular HTTP traffic and sync everyday Current at its existing URL using its existing API Token. Verify known Subscriptions, Folders, Item IDs, and read/star state. Make and verify one new read transition.
6. Enable only the candidate's verified production schedules. Confirm a real scheduled Cycle Run reaches a terminal outcome. Keep old production polling and retention stopped.
7. Remove or restrict the trial hostname. Reconfigure the second device as a regular production client only after clearing its trial connection and pending changes.
8. Record the first regular-client write time. From this point, returning to old D1 would lose acknowledged production changes unless explicitly reconciled.

Cloudflare manages DNS and certificates for [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). The exact transfer operation and maintenance routing must be rehearsed before execution; this draft does not assume a gap-free reassignment.

## Recovery decisions

| Failure point | Recovery action | Data consequence |
| --- | --- | --- |
| During rehearsal or trial | Stop candidate writers; fix or discard isolated resources. | Everyday production is unaffected. Trial changes are disposable. |
| Final migration or canaries fail, before regular traffic opens | Stop candidate writers, leave final D1 for diagnosis, keep or restore old hostname ownership, remove old maintenance and restore old schedules. | Old D1 still contains every change accepted before the freeze. Candidate canary changes are discarded. |
| Hostname transfer or Access fails while regular traffic is still blocked | Reverse the rehearsed transfer and configuration changes; verify old resources before resuming them. | No regular-client changes should have been accepted during maintenance. |
| Failure after regular traffic opens | Freeze the new environment immediately and export final D1. Prefer a forward fix or a rehearsed schema-compatible code rollback using final D1. | Old D1 is stale. A hostname reversal alone is not a safe rollback. |
| New data is damaged or old code must be restored after opening traffic | Preserve both databases and stop all writers. Decide explicitly whether to repair/reconcile new changes or restore the pre-cutover state with acknowledged data loss. | Returning to the frozen old database loses all accepted post-cutover changes; requires operator approval. |

Before resuming either environment, verify that the other cannot write through another hostname, cron, or Workflow. Never enable the pre-migration poller against migrated final D1. Do not claim an old commit is a valid code rollback without checking its schema and polling compatibility against the selected release.

## Phase 6: observe and retire

For at least seven days and through a real weekly retention run, check Current sync, new-Item arrival, Feed failure diagnostics, scheduler gaps, unfinished attempts, ownership skips, and retention preservation. Compare against the recorded trial and baseline rather than requiring every publisher to succeed.

Keep the old environment frozen and recovery exports encrypted for the agreed recovery period. After acceptance:

- Declare final D1 authoritative and update resource names/documentation accordingly. Renaming resources is not required for promotion.
- Remove old public exposure and scheduling configuration so stale deployments cannot restore traffic or writers.
- Retire old Worker and Workflow resources only after the recovery window closes.
- Remove rehearsal resources and trial-only API Tokens. Keep approved backups under the normal retention policy.
- Replace this draft's placeholders with the executed commands, actual resource IDs, timings, results, and deployment record location.

## Execution record

Store sensitive artifacts outside the repository. Record these nonsensitive references with the deployment:

- Operator, date, selected commit, Worker versions, configuration revisions, and resource IDs.
- Rehearsal and final export checksums, secure locations, restore results, and elapsed times.
- Freeze and reopen times, drained or terminated Workflow IDs, and evidence that all writers stopped.
- Migration lists, preservation comparison results, and integrity/foreign-key checks.
- Trial and final canary Cycle Run IDs and second-device/everyday Current results.
- Custom-domain transfer, Access checks, first regular-client write time, and recovery decisions.
- Observation-window end, weekly retention result, and retirement approval.
