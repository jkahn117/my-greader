/**
 * API Token lifecycle module.
 *
 * Owns raw token generation, hash-only persistence, active-token lookup,
 * usage recording, User-scoped revocation, active listing, and revoked-token
 * retention. HTTP adapters keep request parsing and response formatting.
 */
import { and, desc, eq, isNull, lte, or } from "drizzle-orm";
import { apiTokens, users } from "../../db/schema";
import { sha256 } from "../../lib/crypto";
import { getDb } from "../../lib/db";

const USAGE_WRITE_INTERVAL_MS = 60 * 60 * 1000;
const REVOKED_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApiTokenSummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ActiveApiToken {
  id: string;
  userId: string;
  email: string;
}

export interface GeneratedApiToken {
  id: string;
  rawToken: string;
}

export interface ApiTokenLifecycle {
  generate(userId: string, name: string): Promise<GeneratedApiToken>;
  findActive(rawToken: string): Promise<ActiveApiToken | null>;
  recordUsage(token: ActiveApiToken): Promise<void>;
  revoke(userId: string, tokenId: string): Promise<boolean>;
  listActive(userId: string): Promise<ApiTokenSummary[]>;
  purgeRevoked(): Promise<number>;
}

/** Returns one API Token lifecycle backed by D1. */
export function createApiTokenLifecycle(
  dbBinding: D1Database,
  clock: () => number = Date.now,
): ApiTokenLifecycle {
  const db = getDb(dbBinding);

  return {
    generate,
    findActive,
    recordUsage,
    revoke,
    listActive,
    purgeRevoked,
  };

  /** Generates a raw token for one-time reveal and persists only its hash. */
  async function generate(
    userId: string,
    name: string,
  ): Promise<GeneratedApiToken> {
    const rawBytes = crypto.getRandomValues(new Uint8Array(32));
    const rawToken = Array.from(rawBytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const id = crypto.randomUUID();

    await db.insert(apiTokens).values({
      id,
      userId,
      name,
      tokenHash: await sha256(rawToken),
      createdAt: clock(),
    });

    return { id, rawToken };
  }

  /** Resolves an unrevoked token and its User identity from the raw API Token. */
  async function findActive(rawToken: string): Promise<ActiveApiToken | null> {
    const row = await db
      .select({
        id: apiTokens.id,
        userId: apiTokens.userId,
        email: users.email,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(
        and(
          eq(apiTokens.tokenHash, await sha256(rawToken)),
          isNull(apiTokens.revokedAt),
        ),
      )
      .get();

    return row ?? null;
  }

  /** Records request use at most once per hour, including under concurrent requests. */
  async function recordUsage(token: ActiveApiToken): Promise<void> {
    const now = clock();
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiTokens.id, token.id),
          isNull(apiTokens.revokedAt),
          or(
            isNull(apiTokens.lastUsedAt),
            lte(apiTokens.lastUsedAt, now - USAGE_WRITE_INTERVAL_MS),
          ),
        ),
      );
  }

  /** Revokes an active token only when it belongs to the requesting User. */
  async function revoke(userId: string, tokenId: string): Promise<boolean> {
    const result = await db
      .update(apiTokens)
      .set({ revokedAt: clock() })
      .where(
        and(
          eq(apiTokens.id, tokenId),
          eq(apiTokens.userId, userId),
          isNull(apiTokens.revokedAt),
        ),
      );

    return result.meta.changes > 0;
  }

  /** Lists active tokens newest first for the management UI. */
  async function listActive(userId: string): Promise<ApiTokenSummary[]> {
    return db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
  }

  /** Removes revoked tokens after the shared seven-day retention window. */
  async function purgeRevoked(): Promise<number> {
    const cutoff = clock() - REVOKED_TOKEN_RETENTION_MS;
    const result = await db
      .delete(apiTokens)
      .where(lte(apiTokens.revokedAt, cutoff));
    return result.meta.changes;
  }
}
