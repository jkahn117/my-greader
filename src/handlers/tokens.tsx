import { Hono } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../lib/db'
import { createLogger } from '../lib/logger'
import { sha256 } from '../lib/crypto'
import { apiTokens } from '../db/schema'
import { App } from '../views/app'
import { AccessTab, TokenList, TokenReveal } from '../views/access'

type Variables = { userId: string; email: string }

const handler = new Hono<{ Bindings: Env; Variables: Variables }>()

// ---------------------------------------------------------------------------
// GET /app — Access tab (token management)
// ---------------------------------------------------------------------------

handler.get('/app', async (c) => {
  const userId = c.get('userId')
  const email  = c.get('email')
  const db     = getDb(c.env.DB)
  const logger = createLogger({ path: '/app', userId })

  const tokens = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt))

  logger.info('access tab loaded', { tokenCount: tokens.length })

  return c.html(
    <App email={email} active="access">
      <AccessTab tokens={tokens} />
    </App>,
  )
})

// ---------------------------------------------------------------------------
// POST /tokens/generate — create a new API token
// ---------------------------------------------------------------------------

const generateSchema = z.object({ name: z.string().min(1).max(100).trim() })

handler.post('/tokens/generate', async (c) => {
  const userId = c.get('userId')
  const logger = createLogger({ path: '/tokens/generate', userId })

  const body   = await c.req.parseBody()
  const parsed = generateSchema.safeParse({ name: body.name })

  if (!parsed.success) {
    return c.html(
      <p class="text-sm text-destructive">Name is required (max 100 characters).</p>,
    )
  }

  // Generate a 32-byte random token encoded as 64-char hex
  const rawBytes = crypto.getRandomValues(new Uint8Array(32))
  const rawToken = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const hash     = await sha256(rawToken)
  const id       = crypto.randomUUID()

  const db = getDb(c.env.DB)
  await db.insert(apiTokens).values({
    id,
    userId,
    name:      parsed.data.name,
    tokenHash: hash,
    createdAt: Date.now(),
  })

  logger.info('token generated', { tokenId: id, name: parsed.data.name })

  // Re-fetch the updated list for OOB swap
  const updatedTokens = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt))

  // Return: token reveal (goes into #generate-result) + OOB update of token list tbody
  return c.html(
    <>
      <TokenReveal rawToken={rawToken} />
      <TokenList tokens={updatedTokens} oob />
    </>,
  )
})

// ---------------------------------------------------------------------------
// DELETE /tokens/:id — revoke a token
// ---------------------------------------------------------------------------

handler.delete('/tokens/:id', async (c) => {
  const { id } = c.req.param()
  const userId = c.get('userId')
  const logger = createLogger({ path: `/tokens/${id}`, userId })
  const db     = getDb(c.env.DB)

  await db
    .update(apiTokens)
    .set({ revokedAt: Date.now() })
    .where(and(
      eq(apiTokens.id, id),
      eq(apiTokens.userId, userId),
      isNull(apiTokens.revokedAt),
    ))

  logger.info('token revoked', { tokenId: id })

  // Empty response — htmx outerHTML swap removes the <tr>
  return new Response('', { status: 200 })
})

export { handler as tokensHandler }
