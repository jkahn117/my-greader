import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared context variable type (set by middleware)
// ---------------------------------------------------------------------------

export type Variables = { userId: string; email: string };

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
