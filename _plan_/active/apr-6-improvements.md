# Code Review Improvements — Apr 6

Findings from a full codebase review, ordered by impact.

---

## Critical

### ✅ 1. `mark-all-as-read` is N sequential D1 round-trips

**File:** `src/handlers/greader/state.ts:144–157`

The comment says "bulk upsert in chunks" but the inner `for (const itemId of chunk)` loop `await`s each insert individually. 500 unread items = 500 sequential D1 calls, slow enough to hit Worker CPU limits. The outer chunking doesn't help — it just breaks 500 awaited calls into groups of 100 awaited calls.

Fix: use `db.batch()` exactly as `fetchAndStoreFeed` does for item inserts:

```typescript
const CHUNK = 100;
for (let i = 0; i < ids.length; i += CHUNK) {
  const chunk = ids.slice(i, i + CHUNK);
  const stmts = chunk.map((itemId) =>
    db
      .insert(itemState)
      .values({ itemId, userId, isRead: 1, isStarred: 0 })
      .onConflictDoUpdate({
        target: [itemState.itemId, itemState.userId],
        set: { isRead: 1 },
      }),
  );
  await db.batch(stmts as unknown as [any, ...any[]]);
}
```

Separately: `metrics.recordRead` fires for every item regardless of prior state, so already-read items inflate the read count. Either accept the imprecision or check current state before recording.

---

### ✅ 2. JWKS fetched on every management UI request

**File:** `src/middleware/access.ts:121–130`

Every page load fetches `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` — an external HTTP round-trip adding 100–300ms latency and consuming a subrequest. The JWKS rotates infrequently; there is no reason to re-fetch it more than once per hour.

Fix: module-level cache with a TTL:

```typescript
let jwksCache: { keys: (JsonWebKey & { kid: string })[] } | null = null;
let jwksCachedAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchJwks(issuer: string) {
  if (jwksCache && Date.now() - jwksCachedAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  jwksCache = await res.json();
  jwksCachedAt = Date.now();
  return jwksCache;
}
```

Module-level variables persist for the lifetime of a Worker isolate (minutes to hours in practice), so this meaningfully reduces fetch frequency.

---

### ✅ 3. OPML import fans out all feeds in a single Worker invocation

**File:** `src/handlers/import.tsx:107–115`

`fetchAndStoreFeed` is called concurrently for every newly imported feed inside a single `waitUntil`. Each feed costs ~2 subrequests. Importing 26+ feeds exhausts the free plan's 50-subrequest limit mid-import; remaining feeds silently fail.

Fix: trigger the Workflow instead. The Workflow already handles batching and subrequest budgeting correctly:

```typescript
if (newFeedRows.length > 0) {
  c.executionCtx.waitUntil(triggerFeedPollingWorkflow(c.env));
}
```

Newly imported feeds have null `lastFetchedAt` and are immediately due, so they'll be picked up on the next Workflow run within seconds.

---

### ✅ 4. Reactivate handler authorization ignores the feed ID

**File:** `src/handlers/feeds_ui.tsx:83–87`

```typescript
const sub = await db
  .select({ feedId: subscriptions.feedId })
  .from(subscriptions)
  .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
  .where(eq(subscriptions.userId, userId)) // ← no feedId filter
  .get();
```

Returns the user's first subscription regardless of which feed is being reactivated. The `id` URL param is never used in the WHERE clause. The deactivate handler gets this right with `and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, id))` — reactivate should match.

---

## Performance

### ✅ 5. Feed resolution does two sequential DB calls instead of one

**Files:** `src/handlers/greader/stream.ts:37–38`, `state.ts:111–112`, `subscriptions.ts:176–177`

This pattern appears in four places:

```typescript
(await db.select(...).from(feeds).where(eq(feeds.id, feedRef)).get()) ??
(await db.select(...).from(feeds).where(eq(feeds.feedUrl, feedRef)).get())
```

Two sequential D1 round-trips in the common case. Replace with a single `or()` query:

```typescript
db.select({ id: feeds.id })
  .from(feeds)
  .where(or(eq(feeds.id, feedRef), eq(feeds.feedUrl, feedRef)))
  .get();
```

---

### ✅ 6. Token middleware makes three D1 round-trips per GReader request

**File:** `src/middleware/token.ts:28–54`

Token lookup → user lookup → `lastUsedAt` update = 3 sequential D1 calls on every API request. The user lookup is redundant — join `users` in the first query. The `lastUsedAt` write on every request is expensive for display-only data; throttle to once per hour:

```typescript
const tokenRow = await db
  .select({
    id: apiTokens.id,
    userId: apiTokens.userId,
    email: users.email,
    lastUsedAt: apiTokens.lastUsedAt,
  })
  .from(apiTokens)
  .innerJoin(users, eq(users.id, apiTokens.userId))
  .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
  .get();

if (
  tokenRow &&
  (!tokenRow.lastUsedAt || Date.now() - tokenRow.lastUsedAt > 3_600_000)
) {
  await db
    .update(apiTokens)
    .set({ lastUsedAt: Date.now() })
    .where(eq(apiTokens.id, tokenRow.id));
}
```

---

## Maintainability

### ✅ 7. Identical select shape repeated three times

**File:** `src/handlers/feeds_ui.tsx`

GET `/app/feeds`, POST `/feeds/:id/reactivate`, and POST `/feeds/:id/deactivate` all build the same 10-field select object. Extract as a shared const at the top of the file.

---

### ✅ 8. `stream/contents` and `stream/items/ids` duplicate condition-building logic

**File:** `src/handlers/greader/stream.ts`

Both handlers build identical WHERE conditions (feed/folder/starred lookup, excludeRead, cursor). Only the SELECT columns and response shape differ. Extract `buildStreamConditions(streamId, userId, excludeRead, cursor, db)` to eliminate the duplication.

---

### 9. `trimContent` will be duplicated when the email handler is implemented

**Files:** `src/handlers/cron.ts`, `_plan_/email_newsletters.md`

`cron.ts` has `trimContent(content, maxBytes)`. The email plan sketches an identical `trimToLimit`. Extract to `src/lib/content.ts` before the duplication lands.

---

### ✅ 10. Import loop does 3–4 sequential D1 calls per feed

**File:** `src/handlers/import.tsx`

For each feed: insert feed → select feed → check subscription → insert subscription. For a 100-feed OPML file this is 300–400 sequential D1 round-trips. The subscription existence check can be eliminated by relying on the unique constraint — use `onConflictDoNothing()` and check `result.meta.changes === 0` to count duplicates.

---

## Minor

### ✅ 11. `b64urlToBytes` manual char loop

**File:** `src/middleware/access.ts:182–188`

```typescript
// current
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

// simpler
Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
  c.charCodeAt(0),
);
```

---

### ✅ 12. Client-side `<time>` script may be dead code

**File:** `src/views/layout.tsx`

The `DOMContentLoaded` script converts `<time datetime="ms">` elements to local time strings. Both timestamp columns in the feeds tab now render via `relativeTime()` server-side. Verify whether any `<time>` elements remain in the rendered HTML; if not, the script and wrapper can both be removed.

---

### ✅ 13. Pagination non-deterministic when items share a `publishedAt`

**File:** `src/handlers/greader/stream.ts:67`, `141`

`ORDER BY published_at DESC` with no tiebreaker means two items published at the same millisecond can appear in either order across pages, causing items to be skipped or duplicated at page boundaries. Fix:

```typescript
.orderBy(desc(items.publishedAt), desc(items.id))
```

---

### ✅ 14. `mark-all-as-read` loads all item IDs into memory

**File:** `src/handlers/greader/state.ts:134–139`

For a user with 10,000 unread items, all IDs are fetched into Worker memory before the upsert loop. A single `INSERT INTO item_state SELECT ...` raw SQL statement would handle this in one D1 operation with no memory overhead. Drizzle doesn't support `INSERT ... SELECT` natively — requires `env.DB.prepare(...)` directly.
