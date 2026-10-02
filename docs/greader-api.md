# Google Reader API

## Client Compatibility

Current connects to this backend using its **FreshRSS** sync option. In the app:

```
Settings → Sync → FreshRSS
Server URL: https://reader.yourdomain.com
Username:   user@example.com
Password:   <API token generated from /app/access>
```

Current does not know or care that FreshRSS is not actually running. It sends standard GReader API requests to the provided URL and this Worker responds with the expected shapes.

### Reference implementations

- [The Old Reader API docs](https://github.com/theoldreader/api) — clearest endpoint reference
- [FreshRSS GReader implementation](https://github.com/FreshRSS/FreshRSS/blob/edge/p/api/greader.php) — PHP but readable; exact response field names
- Both implement the same underlying Google Reader protocol

---

## Authentication

All GReader API requests (except ClientLogin itself) must include:

```
Authorization: GoogleLogin auth=<raw-api-token>
```

Current sends this header automatically after a successful ClientLogin.

The API Token lifecycle module hashes the token and resolves an active token from D1. On success, it records usage at most once per hour. The middleware attaches the resolved `user_id` to the request context for downstream handlers.

---

## Endpoints

### `POST /accounts/ClientLogin`

Entry point. Current calls this first when connecting.

**Request body** (form-encoded):
```
Email=user@example.com&Passwd=<api-token>&service=reader
```

**Response** (plain text, line-delimited):
```
SID=none
LSID=none
Auth=<api-token>
```

The same token is echoed back as the `Auth` value. Current stores it and sends it as the `GoogleLogin auth=` header on all subsequent requests.

---

### `GET /reader/api/0/user-info`

Called immediately after ClientLogin to confirm auth and get user identity.

**Response** (JSON):
```json
{
  "userId": "<user-id>",
  "userName": "user@example.com",
  "userProfileId": "<user-id>",
  "userEmail": "user@example.com"
}
```

---

### `GET /reader/api/0/subscription/list`

Returns all feeds the user is subscribed to.

**Response** (JSON):
```json
{
  "subscriptions": [
    {
      "id": "feed/<feed-id>",
      "title": "Feed Title",
      "htmlUrl": "https://example.com",
      "url": "https://example.com/feed.xml",
      "categories": [
        { "id": "user/-/label/<folder>", "label": "<folder>" }
      ]
    }
  ]
}
```

`categories` maps to the user's folder. Empty array if no folder set.

---

### `POST /reader/api/0/subscription/edit`

Add, edit, or remove a subscription.

**Request body** (form-encoded):
```
ac=subscribe|unsubscribe|edit
s=feed/<feed-url>
t=Custom Title          (optional, for ac=edit)
a=user/-/label/Folder   (optional, add to folder)
r=user/-/label/Folder   (optional, remove from folder)
```

**Response**: `OK` (plain text) on success.

On `ac=subscribe`: look up or create the feed in `feeds` table, then create `subscriptions` row.
On `ac=unsubscribe`: delete from `subscriptions`.
On `ac=edit`: update `title` or `folder` in `subscriptions`.

---

### `GET /reader/api/0/stream/contents`

Fetch articles for a stream (a feed, a folder, or all items).

**Query params**:
```
s=feed/<feed-id>          — specific feed
s=user/-/state/com.google/reading-list  — all items
n=20                      — number of items (default 20)
xt=user/-/state/com.google/read  — exclude read items
ot=<unix-timestamp>       — only return items newer than this (seconds)
c=<continuation-token>    — pagination
```

**Response** (JSON):
```json
{
  "id": "user/-/state/com.google/reading-list",
  "items": [
    {
      "id": "tag:google.com,2005:reader/item/<item-id>",
      "title": "Article Title",
      "canonical": [{ "href": "https://example.com/article" }],
      "summary": { "content": "<html content>" },
      "author": "Author Name",
      "published": 1234567890,
      "updated": 1234567890,
      "origin": {
        "streamId": "feed/<feed-id>",
        "title": "Feed Title",
        "htmlUrl": "https://example.com"
      },
      "categories": [
        "user/-/state/com.google/reading-list"
      ]
    }
  ],
  "continuation": "<token-for-next-page>"
}
```

Read items include `"user/-/state/com.google/read"` in `categories`. Starred items include `"user/-/state/com.google/starred"`.

---

### `GET /reader/api/0/stream/items/ids`

Returns only item IDs for a stream — used by Current for efficient sync.

**Query params**: same as `stream/contents`

**Response** (JSON):
```json
{
  "itemRefs": [
    { "id": "<item-id>", "timestampUsec": "1234567890000000" }
  ],
  "continuation": "<token>"
}
```

---

### `GET|POST /reader/api/0/stream/items/contents`

Fetch full article bodies for specific item IDs — Current's follow-up after `stream/items/ids`.

**Query / body**: one or more `i=<item-id>` (full tag or short hex).

**Response**: same item shape as `stream/contents`. Only items the user is subscribed to are returned.

---

### `GET /reader/api/0/tag/list`

Returns the starred state plus one tag per folder.

```json
{ "tags": [{ "id": "user/-/state/com.google/starred" }, { "id": "user/-/label/Tech" }] }
```

---

### `POST /reader/api/0/subscription/quickadd`

Subscribe by raw feed URL (`quickadd=<url>`). Returns `{ numResults, query, streamId }`.

---

### `POST /reader/api/0/edit-tag`

Mark items as read, unread, or starred.

**Request body** (form-encoded):
```
i=<item-id>              — one or more item IDs
a=user/-/state/com.google/read      — add tag (mark read)
r=user/-/state/com.google/read      — remove tag (mark unread)
a=user/-/state/com.google/starred   — add starred
r=user/-/state/com.google/starred   — remove starred
```

**Response**: `OK` (plain text).

Updates Item State only for Items in the authenticated User's Subscriptions.
Marking an Item read records the transition time; marking it unread clears that
time. Unknown or inaccessible Item IDs retain the compatible `OK` response but
make no change.

---

### `POST /reader/api/0/mark-all-as-read`

Mark all items in a stream as read.

**Request body** (form-encoded):
```
s=feed/<feed-id>          — mark all in a subscribed Feed
s=user/-/label/<folder>   — mark all in a Folder
s=user/-/state/com.google/reading-list  — mark everything subscribed
ts=<timestamp-usec>       — only mark items older than this timestamp
```

**Response**: `OK` (plain text). Unsupported scopes, including the starred
Stream, retain the compatible no-op response.

---

## Implementation Notes

### Item IDs

GReader uses the format `tag:google.com,2005:reader/item/<hex-id>` in full, but clients typically use just the hex portion when posting back. Handle both forms.

Generate item IDs from a hash of the article GUID or URL:
```typescript
const itemId = await deriveItemId(item.guid ?? item.url);
// store as hex string in D1
```

### Continuation tokens

Tokens are a URL-safe base64 encoding of a compound cursor `"<publishedAt>:<itemId>"`.
The compound key prevents items from being skipped or duplicated when multiple articles share
the same `published_at` timestamp (a common occurrence for bulk imports). The WHERE clause
for the next page is:

```sql
WHERE (published_at < cursor.publishedAt)
   OR (published_at = cursor.publishedAt AND id < cursor.itemId)
```

Legacy single-timestamp tokens (from older deployments) are decoded as a fallback.

### Token validation middleware

All routes under `/reader/` share a Hono middleware that:

1. Extracts the token from `Authorization: GoogleLogin auth=<token>`.
2. Delegates active-token lookup and usage recording to `createApiTokenLifecycle()`.
3. Sets the resolved User ID and email on the Hono context.
4. Returns `401` if the header is missing, the token is unknown, or the token is revoked.

The middleware does not contain token hashing, lookup, or usage-write policy.
ClientLogin uses the same active-token lookup, but keeps form validation, rate
limiting, logging, and its plain-text response in the HTTP adapter.
