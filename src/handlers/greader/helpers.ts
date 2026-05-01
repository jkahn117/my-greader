import { z } from "zod";
import { toGreaderItemId } from "../../lib/crypto";
import type { items, feeds } from "../../db/schema";

export type { Variables } from "../../types/context";

// ---------------------------------------------------------------------------
// Shared item → GReader response mapper
// ---------------------------------------------------------------------------

// Row shape returned by the stream queries (items + feeds + item_state join)
export type ItemRow = {
  item: typeof items.$inferSelect;
  feedId: string;
  feedTitle: string | null;
  htmlUrl: string | null;
  isRead: number | null;
  isStarred: number | null;
};

/** Maps a joined item row to the GReader JSON item format */
export function toGReaderItem(r: ItemRow) {
  const categories = ["user/-/state/com.google/reading-list"];
  if (r.isRead) categories.push("user/-/state/com.google/read");
  if (r.isStarred) categories.push("user/-/state/com.google/starred");

  const publishedSec = r.item.publishedAt
    ? Math.floor(r.item.publishedAt / 1000)
    : 0;

  return {
    id: toGreaderItemId(r.item.id),
    title: r.item.title ?? "",
    canonical: [{ href: r.item.url ?? "" }],
    alternate: [{ href: r.item.url ?? "", type: "text/html" }],
    summary: { content: r.item.content ?? "" },
    author: r.item.author ?? "",
    published: publishedSec,
    updated: publishedSec,
    origin: {
      streamId: `feed/${r.feedId}`,
      title: r.feedTitle ?? "",
      htmlUrl: r.htmlUrl ?? "",
    },
    categories,
  };
}

// ---------------------------------------------------------------------------
// Stream ID parsing
// ---------------------------------------------------------------------------

export type StreamType = "feed" | "folder" | "all" | "starred";

export function parseStreamId(s: string): { type: StreamType; value: string | null } {
  if (s.startsWith("feed/")) return { type: "feed", value: s.slice(5) };
  if (s.startsWith("user/-/label/"))
    return { type: "folder", value: s.slice("user/-/label/".length) };
  if (s === "user/-/state/com.google/starred")
    return { type: "starred", value: null };
  return { type: "all", value: null };
}

// ---------------------------------------------------------------------------
// Stream query schemas
// ---------------------------------------------------------------------------

// stream/contents returns full article bodies — keep page size small
export const streamContentsSchema = z.object({
  s: z.string().default("user/-/state/com.google/reading-list"),
  n: z.coerce.number().int().min(1).max(1000).default(20),
  xt: z.string().optional(), // exclude tag, e.g. user/-/state/com.google/read
  c: z.string().optional(), // continuation token
  ot: z.coerce.number().optional(), // older than (unix seconds)
});

// stream/items/ids returns IDs only — clients like Current request up to 10000
export const streamIdsSchema = z.object({
  s: z.string().default("user/-/state/com.google/reading-list"),
  n: z.coerce.number().int().min(1).max(10000).default(20),
  xt: z.string().optional(),
  c: z.string().optional(),
  ot: z.coerce.number().optional(),
});
