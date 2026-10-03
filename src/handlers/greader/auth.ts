import { Hono } from "hono";
import * as v from "valibot";
import { createApiTokenLifecycle } from "../../domain/tokens";
import { createLogger } from "../../lib/logger";
import type { Variables } from "./helpers";

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /accounts/ClientLogin
// ---------------------------------------------------------------------------
// Entry point for GReader clients. Validates the raw API token (Passwd field)
// and returns the same token as the Auth value — clients reuse it as the
// Authorization header on all subsequent requests.

export const clientLoginSchema = v.object({
  Email: v.pipe(v.string(), v.email()),
  Passwd: v.pipe(v.string(), v.minLength(1)),
  service: v.optional(v.string()),
});

auth.post("/accounts/ClientLogin", async (c) => {
  const logger = createLogger().child({
    rayId: c.req.header("cf-ray"),
    path: c.req.path,
  });

  // Rate limit by client IP — 5 attempts per 60s (see wrangler.jsonc)
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.LOGIN_RATE_LIMITER) {
    let success: boolean;
    try {
      ({ success } = await c.env.LOGIN_RATE_LIMITER.limit({ key: ip }));
    } catch {
      // Fail closed without exposing platform exception details to clients or logs.
      logger.error("ClientLogin rate limiter unavailable", { ip });
      return c.text("Authentication unavailable", 503);
    }
    if (!success) {
      logger.warn("ClientLogin rate limited", { ip });
      return c.text("Rate limited", 429);
    }
  }

  const body = await c.req.parseBody();
  const parsed = v.safeParse(clientLoginSchema, body);

  if (!parsed.success) {
    logger.warn("ClientLogin bad request", { errors: parsed.issues });
    return c.text("BadAuthentication", 403);
  }

  const { Passwd } = parsed.output;

  const tokenLifecycle = createApiTokenLifecycle(c.env.DB);
  const token = await tokenLifecycle.findActive(Passwd);

  if (!token) {
    logger.warn("ClientLogin failed — token not found or revoked");
    return c.text("BadAuthentication", 403);
  }

  logger.info("ClientLogin success", { email: parsed.output.Email });

  // GReader clients expect plain-text line-delimited response
  return c.text(`SID=none\nLSID=none\nAuth=${Passwd}\n`);
});

export { auth };
