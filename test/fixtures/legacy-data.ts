export const LEGACY_MIGRATION = "0005_query_performance_indexes.sql";

export const legacyExpectedState = {
  feeds: [
    {
      id: "legacy-feed-active",
      feed_url: "https://active.example/feed.xml",
      html_url: "https://active.example",
      title: "Active legacy feed",
      last_fetched_at: 1_700_000_000_000,
      etag: '"active-etag"',
      last_modified: "Wed, 15 Nov 2023 00:00:00 GMT",
      consecutive_errors: 2,
      last_error: "HTTP 503",
      deactivated_at: null,
      check_interval_minutes: 120,
      last_new_item_at: 1_699_999_000_000,
    },
    {
      id: "legacy-feed-deactivated",
      feed_url: "https://deactivated.example/feed.xml",
      html_url: "https://deactivated.example",
      title: "Deactivated legacy feed",
      last_fetched_at: 1_699_000_000_000,
      etag: null,
      last_modified: null,
      consecutive_errors: 5,
      last_error: "HTTP 410",
      deactivated_at: 1_699_100_000_000,
      check_interval_minutes: 240,
      last_new_item_at: null,
    },
  ],
  items: [
    {
      id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      feed_id: "legacy-feed-active",
    },
    {
      id: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      feed_id: "legacy-feed-deactivated",
    },
  ],
  itemState: [
    {
      item_id:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      user_id: "legacy-user-a",
      is_read: 1,
      is_starred: 1,
      read_at: 1_700_000_100_000,
    },
    {
      item_id:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      user_id: "legacy-user-b",
      is_read: 0,
      is_starred: 1,
      read_at: null,
    },
  ],
  subscriptions: [
    {
      id: "legacy-sub-a",
      user_id: "legacy-user-a",
      feed_id: "legacy-feed-active",
      title: "My active feed",
      folder: "Research",
    },
    {
      id: "legacy-sub-b",
      user_id: "legacy-user-b",
      feed_id: "legacy-feed-deactivated",
      title: null,
      folder: "Archive",
    },
  ],
  apiTokens: [
    {
      id: "legacy-token-a",
      user_id: "legacy-user-a",
      token_hash:
        "1111111111111111111111111111111111111111111111111111111111111111",
      revoked_at: null,
    },
    {
      id: "legacy-token-b",
      user_id: "legacy-user-b",
      token_hash:
        "2222222222222222222222222222222222222222222222222222222222222222",
      revoked_at: 1_700_000_200_000,
    },
  ],
};

/** Seeds data shaped exactly like the schema at the Stage 1 migration baseline. */
export async function seedLegacyData(db: D1Database): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?), (?, ?, ?)",
      )
      .bind(
        "legacy-user-a",
        "a@example.test",
        1_600_000_000_000,
        "legacy-user-b",
        "b@example.test",
        1_600_000_100_000,
      ),
    db
      .prepare(
        `INSERT INTO feeds
          (id, feed_url, html_url, title, last_fetched_at, etag, last_modified,
           consecutive_errors, last_error, deactivated_at, check_interval_minutes,
           last_new_item_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "legacy-feed-active",
        "https://active.example/feed.xml",
        "https://active.example",
        "Active legacy feed",
        1_700_000_000_000,
        '"active-etag"',
        "Wed, 15 Nov 2023 00:00:00 GMT",
        2,
        "HTTP 503",
        null,
        120,
        1_699_999_000_000,
        "legacy-feed-deactivated",
        "https://deactivated.example/feed.xml",
        "https://deactivated.example",
        "Deactivated legacy feed",
        1_699_000_000_000,
        null,
        null,
        5,
        "HTTP 410",
        1_699_100_000_000,
        240,
        null,
      ),
    db
      .prepare(
        `INSERT INTO subscriptions (id, user_id, feed_id, title, folder)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        "legacy-sub-a",
        "legacy-user-a",
        "legacy-feed-active",
        "My active feed",
        "Research",
        "legacy-sub-b",
        "legacy-user-b",
        "legacy-feed-deactivated",
        null,
        "Archive",
      ),
    db
      .prepare(
        `INSERT INTO items
          (id, feed_id, title, url, content, author, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "legacy-feed-active",
        "Legacy active item",
        "https://active.example/item",
        "<p>Active</p>",
        "Author A",
        1_699_999_000_000,
        1_700_000_000_000,
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "legacy-feed-deactivated",
        "Legacy saved item",
        "https://deactivated.example/item",
        "<p>Saved</p>",
        "Author B",
        1_698_999_000_000,
        1_699_000_000_000,
      ),
    db
      .prepare(
        `INSERT INTO item_state
          (item_id, user_id, is_read, is_starred, read_at)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "legacy-user-a",
        1,
        1,
        1_700_000_100_000,
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        "legacy-user-b",
        0,
        1,
        null,
      ),
    db
      .prepare(
        `INSERT INTO api_tokens
          (id, user_id, name, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "legacy-token-a",
        "legacy-user-a",
        "Current",
        "1111111111111111111111111111111111111111111111111111111111111111",
        1_600_000_200_000,
        1_700_000_000_000,
        null,
        "legacy-token-b",
        "legacy-user-b",
        "Old client",
        "2222222222222222222222222222222222222222222222222222222222222222",
        1_600_000_300_000,
        1_699_000_000_000,
        1_700_000_200_000,
      ),
  ]);
}

/** Reads stable identifiers and relationships that every additive migration must preserve. */
export async function readLegacyState(db: D1Database) {
  const [feeds, items, itemState, subscriptions, apiTokens] = await Promise.all(
    [
      db
        .prepare(
          `SELECT id, feed_url, html_url, title, last_fetched_at, etag,
                last_modified, consecutive_errors, last_error, deactivated_at,
                check_interval_minutes, last_new_item_at
         FROM feeds ORDER BY id`,
        )
        .all(),
      db.prepare("SELECT id, feed_id FROM items ORDER BY id").all(),
      db
        .prepare(
          `SELECT item_id, user_id, is_read, is_starred, read_at
         FROM item_state ORDER BY item_id, user_id`,
        )
        .all(),
      db
        .prepare(
          `SELECT id, user_id, feed_id, title, folder
         FROM subscriptions ORDER BY id`,
        )
        .all(),
      db
        .prepare(
          `SELECT id, user_id, token_hash, revoked_at
         FROM api_tokens ORDER BY id`,
        )
        .all(),
    ],
  );

  return {
    feeds: feeds.results,
    items: items.results,
    itemState: itemState.results,
    subscriptions: subscriptions.results,
    apiTokens: apiTokens.results,
  };
}
