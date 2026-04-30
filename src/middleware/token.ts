import type { Context, Next } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../lib/db";
import { sha256 } from "../lib/crypto";
import { createLogger } from "../lib/logger";
import { apiTokens, users } from "../db/schema";

/**
 * GReader API token middleware.
 *
 * Validates the `Authorization: GoogleLogin auth=<token>` header by hashing
 * the raw token and looking it up in `api_tokens`. Updates `last_used_at` on
 * every authenticated request so the Access tab can show meaningful activity.
 */
export async function tokenMiddleware(c: Context, next: Next) {
  const logger = createLogger({ path: c.req.path });
  const auth = c.req.header("Authorization") ?? "";
  const raw = auth.startsWith("GoogleLogin auth=")
    ? auth.slice("GoogleLogin auth=".length).trim()
    : null;

  if (!raw) return c.text("Unauthorized", 401);

  const env = c.env as Env;
  const db = getDb(env.DB);
  const hash = await sha256(raw);

  const tokenRow = await db
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      email: users.email,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
    .get();

  if (!tokenRow) return c.text("Unauthorized", 401);

  if (
    !tokenRow.lastUsedAt || Date.now() - tokenRow.lastUsedAt > 3_600_000
  ) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: Date.now() })
      .where(eq(apiTokens.id, tokenRow.id));
  }

  c.set("userId", tokenRow.userId);
  c.set("email", tokenRow.email);
  await next();
}
