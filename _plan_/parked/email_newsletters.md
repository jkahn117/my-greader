# Email Newsletter Ingest

## Overview

Newsletters arrive as emails rather than RSS feeds. This feature routes inbound emails to the Worker, parses them, and stores each email as a feed item — making newsletters appear alongside RSS content in any GReader client.

No third-party service (Kill the Newsletter, Feedbin) is required. Cloudflare Email Routing forwards inbound mail directly to a Worker `email()` export, keeping everything within the existing stack.

---

## Trade-offs

| | |
|---|---|
| **Pros** | Native Cloudflare — no external dependencies; newsletters appear in Current alongside RSS; existing GReader API compatibility for free; one address handles all senders |
| **Cons** | Email Routing requires MX records on the zone — if `iamjkahn.com` already has MX records for another mail provider (Gmail, Fastmail), Cloudflare Email Routing can coexist via routing rules, but all MX records must point to Cloudflare and forwarding to the original provider must be configured explicitly |
| **HTML fidelity** | Newsletter HTML is often complex (tables, inline styles, tracking pixels). Content is stored as-is and trimmed to 50 KB like RSS items — rendering quality depends on the GReader client. |
| **No article extraction** | Each email becomes one item. Digest-style newsletters (e.g. dense link roundups) are stored as a single blob rather than individual articles. Simple and universal — article extraction is brittle across newsletter markup variations. |
| **No unsubscribe automation** | You still manage newsletter subscriptions via each sender's unsubscribe link. The Worker only receives and stores. |

---

## Architecture

```
newsletters@iamjkahn.com
  → Cloudflare Email Routing rule
  → Worker email() handler
  → postal-mime parses MIME body
  → upsert feeds row  (type='email', feedUrl='email:<from-address>')
  → upsert subscriptions row  (auto-subscribes your userId)
  → insert items row  (subject → title, HTML body → content)
  → appears in GReader client as unread item in sender's feed
```

The GReader API sees email feeds identically to RSS feeds — no client changes needed.

---

## DNS and Email Routing Setup

### 1. Enable Cloudflare Email Routing

In the Cloudflare dashboard for `iamjkahn.com`:

**Email → Email Routing → Get started**

Cloudflare will prompt you to add the required DNS records.

### 2. Required DNS records

Cloudflare Email Routing requires these records on the `iamjkahn.com` zone:

**MX records** (replace any existing MX records, or route alongside them — see note below):

| Type | Name | Mail server | Priority |
|------|------|-------------|----------|
| MX | `iamjkahn.com` | `route1.mx.cloudflare.net` | 52 |
| MX | `iamjkahn.com` | `route2.mx.cloudflare.net` | 37 |
| MX | `iamjkahn.com` | `route3.mx.cloudflare.net` | 16 |

**SPF record** — add `include:_spf.mx.cloudflare.net` to your existing SPF TXT record (or create one if absent):

```
v=spf1 include:_spf.mx.cloudflare.net ~all
```

> **If `iamjkahn.com` already has MX records (personal email on Gmail/Fastmail etc.):** Cloudflare Email Routing can forward non-matching addresses to your existing provider. In the Email Routing dashboard, add a **catch-all rule → Forward to → your-existing@provider.com** for everything that isn't `newsletters@`. Your personal mail is unaffected.

### 3. Create the routing rule

In Email Routing → Routing rules → **Create address**:

| Field | Value |
|-------|-------|
| Custom address | `newsletters@iamjkahn.com` |
| Action | **Send to a Worker** |
| Worker | `my-greader` |

When a newsletter sender asks for your address, give them `newsletters@iamjkahn.com`.

---

## Schema Change

Add a `type` column to `feeds` to distinguish email feeds from RSS feeds. The polling workflow must skip email feeds — they receive items via push, not pull.

```sql
-- migration: drizzle/0004_feed_type.sql
ALTER TABLE `feeds` ADD `type` text NOT NULL DEFAULT 'rss';
```

Update the polling query's WHERE clause to add `AND feeds.type = 'rss'`.

Drizzle schema addition:

```typescript
type: text('type').notNull().default('rss'), // 'rss' | 'email'
```

---

## Implementation

### Dependencies

```bash
pnpm add postal-mime
```

`postal-mime` parses raw MIME email streams in a Workers environment.

### Worker email handler — `src/handlers/email.ts`

```typescript
import PostalMime from "postal-mime";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import { feeds, items, subscriptions } from "../db/schema";
import { deriveItemId } from "../lib/crypto";

// Hard-coded to the single user — personal reader, single tenant.
// The userId must exist in the users table before emails can be stored.
const OWNER_USER_ID = "owner"; // replace with actual ID or look up by email

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const logger = createLogger({ handler: "email", from: message.from });
  const db = getDb(env.DB);

  // Parse the raw MIME message
  const raw = await new Response(message.raw).arrayBuffer();
  const email = await PostalMime.parse(raw);

  const from = message.from; // e.g. "newsletter@morningbrew.com"
  const subject = email.subject ?? "(no subject)";
  const html = email.html ?? email.text ?? "";
  const feedUrl = `email:${from}`;

  // Derive a human-readable feed title from the sender name or address
  const senderName = email.from?.name || from;

  // Upsert the synthetic feed row
  await db
    .insert(feeds)
    .values({
      id: crypto.randomUUID(),
      feedUrl,
      title: senderName,
      type: "email",
      lastFetchedAt: Date.now(),
    })
    .onConflictDoNothing();

  const feed = await db.select().from(feeds).where(eq(feeds.feedUrl, feedUrl)).get();
  if (!feed) {
    logger.error("failed to upsert email feed", { feedUrl });
    return;
  }

  // Auto-subscribe the owner if not already subscribed
  await db
    .insert(subscriptions)
    .values({
      id: crypto.randomUUID(),
      userId: OWNER_USER_ID,
      feedId: feed.id,
      title: null,
      folder: "newsletters", // default folder — user can change in client
    })
    .onConflictDoNothing();

  // Store the email as an item
  const itemId = await deriveItemId(message.headers.get("message-id") ?? `${from}:${Date.now()}`);
  const now = Date.now();

  await db
    .insert(items)
    .values({
      id: itemId,
      feedId: feed.id,
      title: subject,
      url: null,
      content: trimToLimit(html, 50 * 1024),
      author: senderName,
      publishedAt: email.date ? new Date(email.date).getTime() : now,
      fetchedAt: now,
    })
    .onConflictDoNothing();

  logger.info("email item stored", { from, subject, feedId: feed.id });
}

function trimToLimit(content: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(content);
  if (encoded.length <= maxBytes) return content;
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}
```

### Export from `src/index.tsx`

```typescript
import { handleEmail } from "./handlers/email";

export default { fetch: app.fetch, scheduled, email: handleEmail };
```

### Polling workflow — skip email feeds

In `src/workflows/feed_polling.ts`, add `eq(feeds.type, "rss")` to the WHERE clause in the `get-due-feeds` step:

```typescript
.where(
  and(
    isNull(feeds.deactivatedAt),
    eq(feeds.type, "rss"),       // skip email feeds
    or(
      isNull(feeds.lastFetchedAt),
      lte(sql`${feeds.lastFetchedAt} + ${feeds.checkIntervalMinutes} * 60000`, now),
    ),
  ),
)
```

---

## Open Questions

- **`OWNER_USER_ID`**: The email handler needs to know which user to subscribe. Options: hardcode the ID (acceptable for a single-user reader), look it up via `users` table by a known email, or derive it from an env var.
- **Spam / unexpected senders**: Currently any email to `newsletters@iamjkahn.com` creates a feed and item. A sender allowlist (env var or D1 table) would prevent noise from unwanted mail.
- **Folder assignment**: Items default to a `"newsletters"` folder. Could be made configurable per-sender via a management UI later.
- **Tracking pixel removal**: Newsletter HTML commonly embeds tracking pixels. Stripping `<img>` tags with known tracking domains before storage would be a minor privacy improvement — out of scope for initial implementation.
- **Message-ID deduplication**: Using `Message-ID` header as the item ID basis ensures idempotency if a delivery is retried. The `deriveItemId` hash handles this correctly.
