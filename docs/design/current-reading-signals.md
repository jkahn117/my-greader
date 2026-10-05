# Current reading signals over Google Reader sync

## Conclusion

Current distinguishes Mark Read, Release and age-based disappearance in its UI. The reviewed primary sources do not establish whether those actions produce distinguishable FreshRSS/Google Reader requests. Do not interpret read state as actual reading, completion, release or expiration.

## What the sources establish

- [Current's gesture docs](https://www.currentreader.app/docs/gestures) list Mark Read, Mark Unread and Release as separate configurable actions. Short-left defaults to Mark Read; long-left defaults to Release. [Reading docs](https://www.currentreader.app/docs/reading) distinguish opening an Item, scrolling and swipe actions. They do not define the FreshRSS wire mapping.
- [Current's River docs](https://www.currentreader.app/docs/river) describe velocity-based aging and per-source overrides. Disappearing from the river is not documented as a specific server mutation.
- [Current's sync docs](https://www.currentreader.app/docs/sync) say FreshRSS uses Google Reader API; read state and starred/saved state sync, while scroll positions and local preferences remain on-device. Offline changes queue for later sync. Server receipt time therefore cannot be assumed to be action time.
- [FreshRSS's implementation](https://github.com/FreshRSS/FreshRSS/blob/edge/p/api/greader.php), especially `editTag`, `markAllAsRead` and `parse`, supports read/starred flags, custom Item labels and bulk mark-read. These mutation interfaces have no generic opened, completed, skipped, expired or release-reason field. Custom labels could encode an agreed extension, but there is no evidence here that Current sends such labels for these actions.
- [The Old Reader API reference](https://github.com/theoldreader/api) describes the original Google Reader API as unofficial. Compatibility implementations are the useful references, not a current Google-maintained analytics specification.

Current's [FAQ](https://www.currentreader.app/docs/faq) says there is no read/unread concept, while its gesture and sync docs explicitly describe read state. Treat that as documentation inconsistency, not evidence for a particular request mapping.

## What this backend actually records

`src/handlers/greader/state.ts` handles read and starred operations only. Unknown tag operations return compatible `OK` without changing state. Folder labels do not constitute arbitrary Item-label support.

`src/feed/item-state.ts` writes `Date.now()` when receiving read=true, including repeated updates; unread clears the timestamp. Bulk mark-read also writes server time. Its returned Items are eligible requested Items, not necessarily fresh unread-to-read transitions. The API's Analytics Engine metric must not be assumed to count true reading events.

`src/feed/activity.ts` groups current read-state rows by that timestamp. Retention can delete those rows. Consequently the D1 chart is neither an append-only event history nor a record of reading duration, completion or release reasons.

For now, use labels such as "Items marked read" and explain that dates reflect latest server receipt. Avoid "Articles read", "completion rate", "time reading" or a read-versus-skipped breakdown.

## How to resolve the unknown

Deferred follow-up: [GitHub issue #41](https://github.com/jkahn117/my-greader/issues/41). This experiment is not a dashboard-refresh dependency. Continue with read/starred state and explicit uncertainty.

Run a bounded experiment with a synthetic Feed, disposable Items and the actual Current/iOS version and configuration:

1. Open and immediately close an Item.
2. Read/scroll to the end and close.
3. Explicitly Mark Read, then Mark Unread.
4. Release, then undo.
5. Batch Release.
6. Let untouched Items age out, then refresh/sync. Include saved and untouched controls.

Observe allowlisted API operation names, state tags, request order, scoped cutoff presence and opaque Item aliases. Inspect tags before the handler discards unknown operations. Do not capture authentication headers, ClientLogin bodies, raw bodies, article content or arbitrary label text. Delete temporary logs after the test.

If different actions send identical operations, the backend cannot reliably tell them apart. Batch size, time of day and Item age are not sufficient evidence. No request within a bounded observation period does not prove an action is always local. Distinct behavior in one tested version is not a guarantee for other releases.

If there is no distinct signal, asking Current's developer for its FreshRSS mapping or a documented extension is the next step. Do not change GReader semantics or invent inferred reasons just to populate a chart.

## Research limitation

The background researcher run `482da540-9fa2-4b32-acb8-aa74d8675744` reported failure because its configured web tools were unavailable. The parent fetched the linked primary-source pages with curl and supplied extracted text; the child produced a partial report. This note records the supported findings from those pages and local code. No Current runtime capture was performed. Current docs are undated and FreshRSS `edge` is mutable.
