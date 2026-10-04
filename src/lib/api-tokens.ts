import { and, desc, eq, isNull } from "drizzle-orm";
import * as v from "valibot";
import type { InferSelectModel } from "drizzle-orm";
import type { getDb } from "./db";
import { sha256 } from "./crypto";
import { apiTokens } from "../db/schema";

type Db = ReturnType<typeof getDb>;
export type ApiTokenRow = InferSelectModel<typeof apiTokens>;

/**
 * `last_used_at` is only rewritten when the stored value is older than this,
 * so GReader traffic costs at most one D1 write per token per hour and the
 * management UI can only claim hour-level precision.
 */
export const LAST_USED_RESOLUTION_MS = 3_600_000;

/** Token label input for the Access-page JSON API. */
export const TokenNameSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
);

/**
 * Creates a named API Token for a User. The raw value is returned to the
 * caller exactly once for display; only its SHA-256 hash is persisted, which
 * is what tokenMiddleware and ClientLogin look up.
 */
export async function generateApiToken(
  db: Db,
  userId: string,
  name: string,
): Promise<{ row: ApiTokenRow; rawToken: string }> {
  const rawBytes = crypto.getRandomValues(new Uint8Array(32));
  const rawToken = Array.from(rawBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const row: ApiTokenRow = {
    id: crypto.randomUUID(),
    userId,
    name,
    tokenHash: await sha256(rawToken),
    createdAt: Date.now(),
    lastUsedAt: null,
    revokedAt: null,
  };
  await db.insert(apiTokens).values(row);
  return { row, rawToken };
}

/** Active (unrevoked) tokens for a User, newest first — the legacy list. */
export function listActiveApiTokens(db: Db, userId: string) {
  return db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt));
}

/** All of a User's tokens including revoked ones, newest first. */
export function listApiTokens(db: Db, userId: string) {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt));
}

/**
 * Revokes one of the User's tokens. Scoped by userId so a token id belonging
 * to another User is indistinguishable from a missing one; revoking an
 * already-revoked token keeps its original revocation time.
 * Returns the token row, or null when the User owns no such token.
 */
export async function revokeApiToken(
  db: Db,
  userId: string,
  id: string,
): Promise<ApiTokenRow | null> {
  await db
    .update(apiTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(apiTokens.id, id),
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
      ),
    );
  const row = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .get();
  return row ?? null;
}
