import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getDb } from "../src/lib/db";
import {
  apiTokens,
  feeds,
  items,
  subscriptions,
  users,
} from "../src/db/schema";
import { sha256 } from "../src/lib/crypto";

const TOKEN = "bulk-item-state-test-token";

const USER_ID = "bulk-item-state-user";

// Submit an authenticated bulk read-state update through the GReader API.
async function requestEditTag(itemIds: string[]): Promise<Response> {
  const body = new URLSearchParams();

  for (const itemId of itemIds) body.append("i", itemId);
  body.set("a", "user/-/state/com.google/read");

  const ctx = createExecutionContext();

  const response = await worker.fetch(
    new Request("http://localhost/reader/api/0/edit-tag", {
      method: "POST",
      headers: {
        Authorization: `GoogleLogin auth=${TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }),
    env,
    ctx,
  );

  await waitOnExecutionContext(ctx);

  return response;
}

// Seed subscribed Items in small inserts to stay within SQLite parameter limits.
async function seedItems(count: number): Promise<string[]> {
  const db = getDb(env.DB);
  const feedId = "bulk-item-state-feed";

  const itemIds = Array.from({ length: count }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );

  await db.insert(feeds).values({
    id: feedId,
    feedUrl: "https://bulk-state.example/feed.xml",
    title: "Bulk State Feed",
  });
  await db.insert(subscriptions).values({
    id: "bulk-item-state-subscription",
    userId: USER_ID,
    feedId,
  });

  for (let offset = 0; offset < itemIds.length; offset += 10) {
    await db.insert(items).values(
      itemIds.slice(offset, offset + 10).map((id) => ({
        id,
        feedId,
        title: id,
        url: `https://bulk-state.example/${id}`,
        content: "",
        publishedAt: 1,
        fetchedAt: 1,
      })),
    );
  }

  return itemIds;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM item_state");
  await env.DB.exec("DELETE FROM api_tokens");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM items");
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM users");

  const db = getDb(env.DB);
  await db.insert(users).values({
    id: USER_ID,
    email: "bulk-state@localhost",
    createdAt: Date.now(),
  });
  await db.insert(apiTokens).values({
    id: "bulk-item-state-token",
    userId: USER_ID,
    name: "Bulk Item State Test",
    tokenHash: await sha256(TOKEN),
    createdAt: Date.now(),
  });
});

describe("bulk edit-tag Item State updates", () => {
  it("updates all subscribed Items below the D1 binding limit", async () => {
    const itemIds = await seedItems(99);

    const response = await requestEditTag(itemIds);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");

    const states = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM item_state WHERE user_id = ? AND is_read = 1 AND read_at IS NOT NULL",
    )
      .bind(USER_ID)
      .first<{ count: number }>();

    expect(states?.count).toBe(99);
  });

  it("updates visible Items across batches and ignores duplicate, unknown, and inaccessible IDs", async () => {
    const itemIds = await seedItems(100);
    await env.DB.exec(
      "INSERT INTO feeds (id, feed_url, title) VALUES ('private-bulk-feed', 'https://private-bulk.example/feed.xml', 'Private')",
    );
    await env.DB.exec(
      "INSERT INTO items (id, feed_id, title, url, content, published_at, fetched_at) VALUES ('private-bulk-item', 'private-bulk-feed', 'Private', 'https://private-bulk.example/item', '', 1, 1)",
    );

    const response = await requestEditTag([
      ...itemIds,
      itemIds[0],
      "missing-bulk-item",
      "private-bulk-item",
    ]);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");

    const states = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM item_state WHERE user_id = ? AND is_read = 1 AND read_at IS NOT NULL",
    )
      .bind(USER_ID)
      .first<{ count: number }>();

    expect(states?.count).toBe(100);
  });
});
