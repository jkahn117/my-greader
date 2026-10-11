import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { apiTokens, users } from "../src/db/schema";
import { deriveItemId, sha256 } from "../src/lib/crypto";
import { getDb } from "../src/lib/db";

const TOKEN = "bulk-stream-token";

const BASE = "http://localhost";

const USER_ID = "bulk-stream-user";

async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();

  const response = await worker.fetch(
    new Request(`${BASE}${path}`, init),
    env,
    ctx,
  );

  await waitOnExecutionContext(ctx);

  return response;
}

async function seedFeed(userId: string, name: string) {
  const feedId = crypto.randomUUID();

  await env.DB.prepare(
    "INSERT INTO feeds (id, feed_url, title, html_url) VALUES (?, ?, ?, ?)",
  )
    .bind(
      feedId,
      `https://${name}.example/feed.xml`,
      name,
      `https://${name}.example`,
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO subscriptions (id, user_id, feed_id) VALUES (?, ?, ?)",
  )
    .bind(crypto.randomUUID(), userId, feedId)
    .run();

  return feedId;
}

async function seedItem(feedId: string, index: number) {
  const guid = `https://example.com/article/${index}`;
  const itemId = await deriveItemId(guid);

  await env.DB.prepare(
    "INSERT INTO items (id, feed_id, title, url, content, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      itemId,
      feedId,
      `Article ${index}`,
      guid,
      `<p>Body ${index}</p>`,
      index,
      index,
    )
    .run();

  return itemId;
}

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM item_state; DELETE FROM api_tokens; DELETE FROM subscriptions; DELETE FROM items; DELETE FROM feeds; DELETE FROM users;",
  );

  const db = getDb(env.DB);
  await db.insert(users).values([
    {
      id: USER_ID,
      email: "bulk-stream@example.com",
      createdAt: Date.now(),
    },
    {
      id: "someone-else",
      email: "other@example.com",
      createdAt: Date.now(),
    },
  ]);

  await db.insert(apiTokens).values({
    id: crypto.randomUUID(),
    userId: USER_ID,
    name: "Bulk stream test",
    tokenHash: await sha256(TOKEN),
    createdAt: Date.now(),
  });
});

function authHeaders(): HeadersInit {
  return { Authorization: `GoogleLogin auth=${TOKEN}` };
}

describe("bounded GReader Stream requests", () => {
  it.each([89, 101])(
    "returns compatible full contents for %i requested IDs",
    async (count) => {
      const feedId = await seedFeed(USER_ID, "visible");

      const itemIds = await Promise.all(
        Array.from({ length: count }, (_, index) => seedItem(feedId, index)),
      );

      const inaccessibleFeed = await seedFeed("someone-else", "private");
      const inaccessibleId = await seedItem(inaccessibleFeed, 1000);

      const requestIds = [
        ...itemIds,
        itemIds[0],
        "f".repeat(64),
        inaccessibleId,
      ];

      const body = new URLSearchParams();
      requestIds.forEach((id) => body.append("i", id));

      const response = await fetch("/reader/api/0/stream/items/contents", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      expect(response.status).toBe(200);

      // SAFETY: the successful contents endpoint returns this GReader response shape.
      const result = (await response.json()) as {
        id: string;
        items: Array<{
          id: string;
          title: string;
          summary: { content: string };
        }>;
      };

      expect(result.id).toBe("user/-/state/com.google/reading-list");
      expect(result.items).toHaveLength(count);
      expect(new Set(result.items.map((item) => item.id))).toEqual(
        new Set(itemIds.map((id) => `tag:google.com,2005:reader/item/${id}`)),
      );
      expect(result.items[0]).toMatchObject({
        title: expect.any(String),
        summary: { content: expect.stringContaining("<p>Body") },
      });
    },
  );

  it("returns ID refs in stream order with the compatible timestamp format", async () => {
    const feedId = await seedFeed(USER_ID, "ids");
    const first = await seedItem(feedId, 1);

    const second = await seedItem(feedId, 2);

    const response = await fetch(
      "/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list",
      { headers: authHeaders() },
    );

    // SAFETY: this endpoint returns itemRefs with string IDs and microsecond timestamps.
    const result = (await response.json()) as {
      itemRefs: Array<{ id: string; timestampUsec: string }>;
    };

    expect(response.status).toBe(200);
    expect(result.itemRefs).toEqual([
      {
        id: `tag:google.com,2005:reader/item/${second}`,
        timestampUsec: "2000",
      },
      { id: `tag:google.com,2005:reader/item/${first}`, timestampUsec: "1000" },
    ]);
  });
});
