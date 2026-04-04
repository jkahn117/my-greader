# Google Reader API

## Client Compatibility

Current connects to this backend using its **FreshRSS** sync option. In the app:

```
Settings → Sync → FreshRSS
Server URL: https://reader.yourdomain.com
Username:   user@example.com
Password:   <API token generated from /tokens UI>
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

The Worker validates by SHA-256 hashing the token and looking it up in `api_tokens WHERE revoked_at IS NULL`. On success, `last_used_at` is updated and the resolved `user_id` is attached to the request context for all downstream handlers.

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

Upserts into `item_state` for the authenticated user.

---

### `POST /reader/api/0/mark-all-as-read`

Mark all items in a stream as read.

**Request body** (form-encoded):
```
s=feed/<feed-id>          — mark all in feed
s=user/-/state/com.google/reading-list  — mark everything
ts=<timestamp-usec>       — only mark items older than this timestamp
```

**Response**: `OK` (plain text).

---

## Implementation Notes

### Item IDs

GReader uses the format `tag:google.com,2005:reader/item/<hex-id>` in full, but clients typically use just the hex portion when posting back. Handle both forms.

Generate item IDs from a hash of the article GUID or URL:
```typescript
const itemId = await hashId(item.guid ?? item.url);
// store as hex string in D1
```

### Continuation tokens

For pagination, use a base64-encoded timestamp or offset. Keep it simple — a base64 of the oldest item's `published_at` in the current page is sufficient.

### Token validation middleware

All routes under `/reader/` share a Hono middleware that:
1. Extracts the token from `Authorization: GoogleLogin auth=<token>`
2. SHA-256 hashes it
3. Looks up in D1 `api_tokens WHERE token_hash = ? AND revoked_at IS NULL`
4. Sets `c.set('userId', row.user_id)` for downstream handlers
5. Returns `401` if not found or revoked

```typescript
app.use('/reader/*', async (c, next) => {
  const auth = c.req.header('Authorization');
  const token = auth?.replace('GoogleLogin auth=', '');
  if (!token) return c.text('Unauthorized', 401);

  const hash = await sha256(token);
  const row = await c.env.DB.prepare(
    'SELECT user_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL'
  ).bind(hash).first();

  if (!row) return c.text('Unauthorized', 401);

  await c.env.DB.prepare(
    'UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?'
  ).bind(Date.now(), hash).run();

  c.set('userId', row.user_id);
  await next();
});
```
