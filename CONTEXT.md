# My GReader

A personal RSS aggregator that exposes a Google Reader-compatible API so native GReader clients (currently just Current) can sync. The system polls feeds, stores articles, and surfaces reading state per-user.

## Language

### Core Entities

**Feed**: A canonical RSS or Atom source URL. Shared across all users — each unique URL is fetched once per polling cycle regardless of subscriber count. _Avoid_: Source, channel, blog

**Subscription**: A user's intentional following of a Feed. Carries an optional custom title and folder. Links one User to one Feed. _Avoid_: Follow, sub, feed (when referring to the user relationship)

**Item**: A single article or post fetched from a Feed. Content is shared (stored once in the `items` table) and identified by a SHA-256 hash of its GUID or URL. _Avoid_: Article, entry, post (use in prose but not as a canonical term)

**Folder**: A user-defined label that groups Subscriptions. Maps to GReader `user/-/label/<name>` stream IDs and Current's "currents". _Avoid_: Category, tag, label, group, river, current

**User**: An authenticated person. Provisioned on first login via Cloudflare Access JWT; the `sub` claim is the stable identifier. _Avoid_: Account, customer, member

### Reading & State

**Item State**: A User's read and starred flags on a specific Item. There is at most one `item_state` row per (user, item) pair — it is created lazily on first interaction with that item. _Avoid_: Read status, star status, user state

**Stream**: A filtered, ordered view of Items scoped to a single User's Subscriptions. Supported scopes: all items, a specific Feed, a Folder, or all starred items. Rendered by the GReader `stream/contents` and `stream/items/ids` endpoints. _Avoid_: Feed (when referring to the GReader stream concept), list, timeline

### Auth

**API Token**: A long-lived bearer token for GReader clients. The raw token (64 hex chars) is shown once at generation; only its SHA-256 hash is stored. Used as the password in GReader `ClientLogin` and as the `GoogleLogin auth=` header on subsequent requests. _Avoid_: Password, key, secret, credential

### Operations

**Polling**: The scheduled act of fetching a Feed via HTTP, parsing the XML response, and storing new Items. Uses conditional requests (ETag / Last-Modified) to avoid redundant downloads. _Avoid_: Fetching, crawling, scraping

**Cycle Run**: A summary record of one polling cycle. Records counts of active feeds, feeds checked, new items stored, and failed feeds. Stored in `cycle_runs` for the dashboard timeline. _Avoid_: Batch run, cron run, cycle

**Deactivation**: Automatic disabling of a Feed when consecutive errors cross a threshold (2 permanent errors like 404/410, or 5 transient errors). A deactivated feed is skipped in future polling cycles until manually re-activated. _Avoid_: Disablement, suspension, banning

**Backoff**: Adaptive increase of a Feed's poll interval when no new items are found (up to 240 minutes) or when the server returns 429. Resets to 30 minutes when new items appear. _Avoid_: Throttling, rate limiting, cooldown
