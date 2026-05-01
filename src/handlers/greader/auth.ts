import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../lib/db";
import { createLogger } from "../../lib/logger";
import { sha256 } from "../../lib/crypto";
import { apiTokens } from "../../db/schema";
import type { Variables } from "./helpers";

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// POST /accounts/ClientLogin
// ---------------------------------------------------------------------------
// Entry point for GReader clients. Validates the raw API token (Passwd field)
// and returns the same token as the Auth value — clients reuse it as the
// Authorization header on all subsequent requests.

export const clientLoginSchema = z.object({
  Email: z.email(),
  Passwd: z.string().min(1),
  service: z.string().optional(),
});

auth.post("/accounts/ClientLogin", async (c) => {
  const logger = createLogger({ path: "/accounts/ClientLogin" });

  // Rate limit by client IP — 5 attempts per 60s (see wrangler.jsonc)
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.LOGIN_RATE_LIMITER) {
    const { success } = await c.env.LOGIN_RATE_LIMITER.limit({ key: ip });
    if (!success) {
      logger.warn("ClientLogin rate limited", { ip });
      return c.text("Rate limited", 429);
    }
  }

  const body = await c.req.parseBody();
  const parsed = clientLoginSchema.safeParse(body);

  if (!parsed.success) {
    logger.warn("ClientLogin bad request", { errors: parsed.error.issues });
    return c.text("BadAuthentication", 403);
  }

  const { Passwd } = parsed.data;

  const db = getDb(c.env.DB);
  const hash = await sha256(Passwd);
  const row = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
    .get();

  if (!row) {
    logger.warn("ClientLogin failed — token not found or revoked");
    return c.text("BadAuthentication", 403);
  }

  logger.info("ClientLogin success", { email: parsed.data.Email });

  // GReader clients expect plain-text line-delimited response
  return c.text(`SID=none\nLSID=none\nAuth=${Passwd}\n`);
});

export { auth };
