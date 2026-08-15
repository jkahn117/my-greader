import { Hono, type Context } from "hono";
import * as v from "valibot";
import { createLogger } from "../../lib/logger";
import { decodeContinuation, normalizeItemId, toGreaderItemId } from "../../lib/crypto";
import {
  createStreamModule,
  parseStreamId,
  toGReaderItem,
} from "../../feed/stream";
import { streamContentsSchema, streamIdsSchema } from "./helpers";
import type { Variables } from "./helpers";

const stream = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/contents
// ---------------------------------------------------------------------------

stream.get("/reader/api/0/stream/contents", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/stream/contents",
    userId: c.get("userId"),
  });
  const userId = c.get("userId");

  const parsed = v.safeParse(streamContentsSchema, c.req.query());
  if (!parsed.success) return c.json({ error: "Bad request" }, 400);

  const { s, n, xt, c: contToken, ot } = parsed.output;
  const streamId = parseStreamId(s);

  const mod = createStreamModule(c.env.DB);
  const conditions = await mod.resolveScope({
    streamId,
    userId,
    excludeRead: xt === "user/-/state/com.google/read",
    newerThan: ot ?? null,
    cursor: contToken ? decodeContinuation(contToken) : null,
  });

  const { page, hasMore, continuation } = await mod.queryPage({
    conditions,
    userId,
    limit: n,
  });

  logger.info("stream/contents", { stream: s, count: page.length, hasMore });

  return c.json({
    id: s,
    items: page.map(toGReaderItem),
    ...(continuation ? { continuation } : {}),
  });
});

// ---------------------------------------------------------------------------
// GET /reader/api/0/stream/items/ids
// ---------------------------------------------------------------------------

stream.get("/reader/api/0/stream/items/ids", async (c) => {
  const logger = createLogger({
    path: "/reader/api/0/stream/items/ids",
    userId: c.get("userId"),
  });
  const userId = c.get("userId");

  const parsed = v.safeParse(streamIdsSchema, c.req.query());
  if (!parsed.success) return c.json({ error: "Bad request" }, 400);

  const { s, n, xt, c: contToken, ot } = parsed.output;
  const streamId = parseStreamId(s);

  const mod = createStreamModule(c.env.DB);
  const conditions = await mod.resolveScope({
    streamId,
    userId,
    excludeRead: xt === "user/-/state/com.google/read",
    newerThan: ot ?? null,
    cursor: contToken ? decodeContinuation(contToken) : null,
  });

  const { page, continuation } = await mod.queryPage({
    conditions,
    userId,
    limit: n,
  });

  logger.info("stream/items/ids", { stream: s, count: page.length });

  return c.json({
    itemRefs: page.map((r) => ({
      id: toGreaderItemId(r.item.id),
      timestampUsec: String((r.item.publishedAt ?? 0) * 1000),
    })),
    ...(continuation ? { continuation } : {}),
  });
});

// ---------------------------------------------------------------------------
// GET|POST /reader/api/0/stream/items/contents
// ---------------------------------------------------------------------------

type HonoCtx = Context<{ Bindings: Env; Variables: Variables }>;

async function handleStreamItemsContents(c: HonoCtx) {
  const logger = createLogger({
    path: "/reader/api/0/stream/items/contents",
    userId: c.get("userId"),
  });
  const userId = c.get("userId");

  let rawIds: string[] = [];
  if (c.req.method === "POST") {
    const body = await c.req.parseBody({ all: true });
    const i = body["i"];
    rawIds = Array.isArray(i) ? (i as string[]) : i ? [i as string] : [];
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
