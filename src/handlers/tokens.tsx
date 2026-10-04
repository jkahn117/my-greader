import { Hono } from "hono";
import * as v from "valibot";
import { getDb } from "../lib/db";
import { createLogger } from "../lib/logger";
import {
  TokenNameSchema,
  generateApiToken,
  listActiveApiTokens,
  revokeApiToken,
} from "../lib/api-tokens";
import { App } from "../views/app";
import { AccessTab, TokenList, TokenReveal } from "../views/access";

import type { Variables } from "../types/context";

const handler = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// GET /app/access — Access tab (token management)
// ---------------------------------------------------------------------------

handler.get("/app/access", async (c) => {
  const userId = c.get("userId");
  const email = c.get("email");
  const db = getDb(c.env.DB);
  const logger = createLogger({ path: "/app/access", userId });

  const tokens = await listActiveApiTokens(db, userId);

  logger.info("access tab loaded", { tokenCount: tokens.length });

  return c.html(
    <App email={email} active="access">
      <AccessTab tokens={tokens} />
    </App>,
  );
});

// ---------------------------------------------------------------------------
// POST /tokens/generate — create a new API token
// ---------------------------------------------------------------------------

const generateSchema = v.object({
  name: TokenNameSchema,
});

handler.post("/tokens/generate", async (c) => {
  const userId = c.get("userId");
  const logger = createLogger({ path: "/tokens/generate", userId });

  const body = await c.req.parseBody();
  const parsed = v.safeParse(generateSchema, { name: body.name });

  if (!parsed.success) {
    return c.html(
      <p class="text-sm text-destructive">
        Name is required (max 100 characters).
      </p>,
    );
  }

  const db = getDb(c.env.DB);
  const { row, rawToken } = await generateApiToken(
    db,
    userId,
    parsed.output.name,
  );
  const id = row.id;

  logger.info("token generated", { tokenId: id, name: parsed.output.name });

  // Re-fetch the updated list for OOB swap
  const updatedTokens = await listActiveApiTokens(db, userId);

  // Return: token reveal (goes into #generate-result) + OOB update of token list tbody
  return c.html(
    <>
      <TokenReveal rawToken={rawToken} />
      <TokenList tokens={updatedTokens} oob />
    </>,
  );
});

// ---------------------------------------------------------------------------
// DELETE /tokens/:id — revoke a token
// ---------------------------------------------------------------------------

handler.delete("/tokens/:id", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");
  const logger = createLogger({ path: `/tokens/${id}`, userId });
  const db = getDb(c.env.DB);

  await revokeApiToken(db, userId, id);

  logger.info("token revoked", { tokenId: id });

  // Empty response — htmx outerHTML swap removes the <tr>
  return new Response("", { status: 200 });
});

export { handler as tokensHandler };
