import { Hono, type Context } from "hono";
import * as v from "valibot";
import { createLogger } from "../../lib/logger";
import {
  decodeContinuation,
  normalizeItemId,
  toGreaderItemId,
} from "../../lib/crypto";
import { createStreamModule, toGReaderItem } from "../../feed/stream";
import {
  parseStreamId,
  streamContentsSchema,
  streamIdsSchema,
} from "./helpers";
import type { Variables } from "./helpers";

const stream = new Hono<{ Bindings: Env; Variables: Variables }>();

interface StreamContentsResponse {
  id: string;
  items: ReturnType<typeof toGReaderItem>[];
  continuation?: string;
}

interface ItemRefsResponse {
  itemRefs: Array<{ id: string; timestampUsec: string }>;
  continuation?: string;
}

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/contents
// ---------------------------------------------------------------------------
//
// Returns paginated feed articles with full content for a stream
// (feed, folder, starred, or all).  Supports continuation-based
// cursor pagination and read-state exclusion.

stream.get("/reader/api/0/stream/contents", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/stream/contents",
    userId: c.get("userId"),
  });

  const userId = c.get("userId");

  const parsed = v.safeParse(streamContentsSchema, c.req.query());

  if (!parsed.success) return c.json({ error: "Bad request" }, 400);

  const { s, n, xt, c: contToken, ot } = parsed.output;
  const scope = parseStreamId(s);

  const mod = createStreamModule(c.env.DB);

  const { page, hasMore, continuation } = await mod.queryPage({
    scope,
    userId,
    excludeRead: xt === "user/-/state/com.google/read",
    newerThan: ot ?? null,
    cursor: contToken ? decodeContinuation(contToken) : null,
    limit: n,
  });

  logger.info("stream/contents", { count: page.length, hasMore });

  const response: StreamContentsResponse = {
    id: s,
    items: page.map(toGReaderItem),
  };

  if (continuation) response.continuation = continuation;

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/items/ids
// ---------------------------------------------------------------------------
//
// Lightweight variant: returns only item IDs and timestamps for the
// same stream scope.  Clients use this to discover new items, then
// fetch just the missing articles via stream/items/contents.

stream.get("/reader/api/0/stream/items/ids", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/stream/items/ids",
    userId: c.get("userId"),
  });

  const userId = c.get("userId");

  const parsed = v.safeParse(streamIdsSchema, c.req.query());

  if (!parsed.success) return c.json({ error: "Bad request" }, 400);

  const { s, n, xt, c: contToken, ot } = parsed.output;
  const scope = parseStreamId(s);

  const mod = createStreamModule(c.env.DB);

  const { page, continuation } = await mod.queryIdPage({
    scope,
    userId,
    excludeRead: xt === "user/-/state/com.google/read",
    newerThan: ot ?? null,
    cursor: contToken ? decodeContinuation(contToken) : null,
    limit: n,
  });

  logger.info("stream/items/ids", { count: page.length });

  const response: ItemRefsResponse = {
    itemRefs: page.map((r) => ({
      id: toGreaderItemId(r.id),
      timestampUsec: String((r.publishedAt ?? 0) * 1000),
    })),
  };

  if (continuation) response.continuation = continuation;

  return c.json(response);
});

// ---------------------------------------------------------------------------
// GET|POST /reader/api/0/stream/items/contents
// ---------------------------------------------------------------------------
//
// Fetches full article content for a specific set of item IDs.
// Accepts repeated `i` params via GET query string or POST form
// body.  Only returns items belonging to feeds the user is
// subscribed to.

type HonoCtx = Context<{ Bindings: Env; Variables: Variables }>;

const itemIdsSchema = v.object({
  i: v.union([v.string(), v.array(v.string())]),
});

async function handleStreamItemsContents(c: HonoCtx) {
  const logger = createLogger({
    path: "/reader/api/0/stream/items/contents",
    userId: c.get("userId"),
  });

  const userId = c.get("userId");

  let rawIds: string[] = [];

  if (c.req.method === "POST") {
    const parsed = v.safeParse(
      itemIdsSchema,
      await c.req.parseBody({ all: true }),
    );

    if (!parsed.success) return c.json({ error: "Bad request" }, 400);

    rawIds = Array.isArray(parsed.output.i)
      ? parsed.output.i
      : [parsed.output.i];
  } else {
    rawIds = c.req.queries("i") ?? [];
  }

  const itemIds = rawIds.map(normalizeItemId).filter(Boolean);

  if (itemIds.length === 0)
    return c.json({ id: "user/-/state/com.google/reading-list", items: [] });

  const mod = createStreamModule(c.env.DB);
  const rows = await mod.queryByIds({ ids: itemIds, userId });

  logger.info("stream/items/contents", {
    requested: itemIds.length,
    found: rows.length,
  });

  return c.json({
    id: "user/-/state/com.google/reading-list",
    items: rows.map(toGReaderItem),
  });
}

stream.get("/reader/api/0/stream/items/contents", handleStreamItemsContents);

stream.post("/reader/api/0/stream/items/contents", handleStreamItemsContents);

export { stream };
