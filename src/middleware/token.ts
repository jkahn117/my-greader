import type { Context, Next } from "hono";
import { createApiTokenLifecycle } from "../domain/tokens";

/**
 * GReader API token middleware.
 *
 * Parses the `Authorization: GoogleLogin auth=<token>` header, then delegates
 * validation and usage policy to the API Token lifecycle module.
 */
export async function tokenMiddleware(c: Context, next: Next) {
  const auth = c.req.header("Authorization") ?? "";
  const raw = auth.startsWith("GoogleLogin auth=")
    ? auth.slice("GoogleLogin auth=".length).trim()
    : null;

  if (!raw) return c.text("Unauthorized", 401);

  const env = c.env as Env;
  const tokenLifecycle = createApiTokenLifecycle(env.DB);
  const tokenRow = await tokenLifecycle.findActive(raw);

  if (!tokenRow) return c.text("Unauthorized", 401);

  await tokenLifecycle.recordUsage(tokenRow);

  c.set("userId", tokenRow.userId);
  c.set("email", tokenRow.email);
  await next();
}
