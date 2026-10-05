import type { Context, Next } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../lib/db";
import { sha256 } from "../lib/crypto";
import { apiTokens, users } from "../db/schema";
import { LAST_USED_RESOLUTION_MS } from "../lib/api-tokens";

/**
 * GReader API token middleware.
 *
 * Validates the `Authorization: GoogleLogin auth=<token>` header by hashing
 * the raw token and looking it up in `api_tokens`. Refreshes `last_used_at`
 * at most hourly (LAST_USED_RESOLUTION_MS) so the Access tab can show coarse
 * activity without a D1 write on every GReader request.
 */
export async function tokenMiddleware(c: Context, next: Next) {
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
    !tokenRow.lastUsedAt ||
    Date.now() - tokenRow.lastUsedAt > LAST_USED_RESOLUTION_MS
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
