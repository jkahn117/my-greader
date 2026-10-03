import { parse, type ParseError } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import productionConfig from "../wrangler.jsonc?raw";

// Checks deployment intent, not Cloudflare's distributed enforcement or a local counter.
describe("production ClientLogin limiter configuration", () => {
  it("requires the native binding with five attempts per sixty seconds", () => {
    const errors: ParseError[] = [];
    const config = parse(productionConfig, errors);
    expect(errors).toEqual([]);
    const limiters = config.ratelimits?.filter(
      (binding: { name: string }) => binding.name === "LOGIN_RATE_LIMITER",
    );
    expect(limiters).toHaveLength(1);
    expect(limiters[0].namespace_id).toMatch(/^\d+$/);
    expect(limiters[0].simple).toEqual({ limit: 5, period: 60 });
  });
});
