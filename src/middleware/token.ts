import type { Context, Next } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { sha256 } from '../lib/crypto'
import { createLogger } from '../lib/logger'
import { apiTokens, users } from '../db/schema'

/**
 * GReader API token middleware.
 *
 * Validates the `Authorization: GoogleLogin auth=<token>` header by hashing
 * the raw token and looking it up in `api_tokens`. Updates `last_used_at` on
 * every authenticated request so the Access tab can show meaningful activity.
 */
export async function tokenMiddleware(c: Context, next: Next) {
  const logger = createLogger({ path: c.req.path })
  const auth   = c.req.header('Authorization') ?? ''
  const raw    = auth.startsWith('GoogleLogin auth=')
    ? auth.slice('GoogleLogin auth='.length).trim()
    : null

  if (!raw) return c.text('Unauthorized', 401)

  const env  = c.env as Env
  const db   = getDb(env.DB)
  const hash = await sha256(raw)

  const tokenRow = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
    .get()

  if (!tokenRow) {
    logger.warn('API token not found or revoked')
    return c.text('Unauthorized', 401)
  }

  const user = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, tokenRow.userId))
    .get()

  if (!user) {
    logger.warn('token owner not found', { userId: tokenRow.userId })
    return c.text('Unauthorized', 401)
  }

  // Record the last time this token was used
  await db
    .update(apiTokens)
    .set({ lastUsedAt: Date.now() })
    .where(eq(apiTokens.id, tokenRow.id))

  c.set('userId', tokenRow.userId)
  c.set('email',  user.email)
  await next()
}
