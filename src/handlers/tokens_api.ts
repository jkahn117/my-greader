import { Hono } from "hono";
import * as v from "valibot";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import {
  LAST_USED_RESOLUTION_MS,
  TokenNameSchema,
  generateApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiTokenRow,
} from "../lib/api-tokens";
import type {
  ApiTokenSummary,
  GenerateTokenResponse,
  RevokeTokenResponse,
  TokensResponse,
} from "../shared/dashboard-api";

import type { Variables } from "../types/context";

// Access-page JSON API for the React client. Responses never include token
// hashes, and only the POST response carries the raw value.
const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Domain projection of an api_tokens row — strips token_hash and user_id. */
function toSummary(row: ApiTokenRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /app/api/tokens — the User's tokens (active and revoked)
// ---------------------------------------------------------------------------

handler.get("/app/api/tokens", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/tokens", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  try {
    const rows = await listApiTokens(getDb(c.env.DB), userId);
    const response: TokensResponse = {
      tokens: rows.map(toSummary),
      connection: {
        mode: "FreshRSS",
        serverUrl: new URL(c.req.url).origin,
        username: c.get("email"),
      },
      lastUsedResolutionMinutes: LAST_USED_RESOLUTION_MS / 60_000,
      generatedAt: Date.now(),
    };
    logger.info("tokens list served", { tokenCount: rows.length });
    return c.json(response);
  } catch (err) {
    logger.error(
      "tokens list failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to load tokens" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /app/api/tokens — generate; the raw token is returned exactly once
// ---------------------------------------------------------------------------

const GenerateBody = v.object({ name: TokenNameSchema });

handler.post("/app/api/tokens", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/app/api/tokens", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  let name: string;
  try {
    name = v.parse(GenerateBody, await c.req.json()).name;
  } catch {
    return c.json({ error: "name is required (max 100 characters)" }, 400);
  }

  try {
    const { row, rawToken } = await generateApiToken(
      getDb(c.env.DB),
      userId,
      name,
    );
    logger.info("token generated", { tokenId: row.id });
    const response: GenerateTokenResponse = {
      token: toSummary(row),
      rawToken,
    };
    c.header("Cache-Control", "no-store");
    return c.json(response, 201);
  } catch (err) {
    logger.error(
      "token generation failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to generate token" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /app/api/tokens/:id — User-scoped revocation
// ---------------------------------------------------------------------------

handler.delete("/app/api/tokens/:id", async (c) => {
  const userId = c.get("userId");
  const { id } = c.req.param();
  const logger = createLogger({ path: "/app/api/tokens/:id", userId });

  if (!c.env.DB) {
    return c.json({ error: "database unavailable" }, 503);
  }

  try {
    const row = await revokeApiToken(getDb(c.env.DB), userId, id);
    if (!row) {
      logger.info("token revoke rejected — not found", { tokenId: id });
      return c.json({ error: "token not found" }, 404);
    }
    logger.info("token revoked", { tokenId: id });
    const response: RevokeTokenResponse = { token: toSummary(row) };
    return c.json(response);
  } catch (err) {
    logger.error(
      "token revoke failed",
      err instanceof Error ? err : { err: String(err) },
    );
    return c.json({ error: "failed to revoke token" }, 500);
  }
});

export { handler as tokensApiHandler };
