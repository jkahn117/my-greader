import * as v from "valibot";

export type { Variables } from "../../types/context";

// ---------------------------------------------------------------------------
// Stream query schemas
// ---------------------------------------------------------------------------

// stream/contents returns full article bodies — keep page size small
export const streamContentsSchema = v.object({
  s: v.optional(v.string(), "user/-/state/com.google/reading-list"),
  n: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(1000),
    ),
    "20",
  ),
  xt: v.optional(v.string()),
  c: v.optional(v.string()),
  ot: v.optional(v.pipe(v.string(), v.transform(Number), v.number())),
});

// stream/items/ids returns IDs only — clients like Current request up to 10000
export const streamIdsSchema = v.object({
  s: v.optional(v.string(), "user/-/state/com.google/reading-list"),
  n: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(10000),
    ),
    "20",
  ),
  xt: v.optional(v.string()),
  c: v.optional(v.string()),
  ot: v.optional(v.pipe(v.string(), v.transform(Number), v.number())),
});
