import type { Context, Next } from 'hono'
import { getDb } from '../lib/db'
import { users } from '../db/schema'
import { createLogger } from '../lib/logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JwtHeader {
  alg: string
  kid: string
}

interface AccessJwtPayload {
  iss: string             // "https://<team>.cloudflareaccess.com"
  sub: string             // stable user UUID from Cloudflare Access
  aud: string | string[]
  email: string
  iat: number
  exp: number
}

// Hardcoded dev identity — matches the token middleware Phase 2 constants
export const DEV_USER_ID    = 'dev-user-id'
export const DEV_USER_EMAIL = 'dev@localhost'

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Cloudflare Access JWT verification middleware.
 *
 * Production: verifies `Cf-Access-Jwt-Assertion` JWT against the Access
 * team's JWKS, checks audience + expiry, then upserts the user row.
 *
 * Dev bypass: if DEV_MODE === 'true' (local only, never set in prod),
 * injects a hardcoded dev user without any JWT check.
 */
export async function accessMiddleware(c: Context, next: Next) {
  const logger = createLogger({ path: c.req.path })
  const env    = c.env as Env

  // Dev bypass — gated on DEV_MODE; never set in production
  if (env.DEV_MODE === 'true') {
    const db = getDb(env.DB)
    await db.insert(users)
      .values({ id: DEV_USER_ID, email: DEV_USER_EMAIL, createdAt: Date.now() })
      .onConflictDoNothing()
    c.set('userId', DEV_USER_ID)
    c.set('email',  DEV_USER_EMAIL)
    return next()
  }

  const jwtToken = c.req.header('Cf-Access-Jwt-Assertion')
  if (!jwtToken) {
    logger.warn('missing Cf-Access-Jwt-Assertion header')
    return c.text('Unauthorized', 401)
  }

  const payload = await verifyAccessJwt(jwtToken, env.CF_ACCESS_AUD, logger)
  if (!payload) {
    return c.text('Unauthorized', 401)
  }

  // Auto-provision user on first login — no admin required for single-user setup
  const db = getDb(env.DB)
  await db.insert(users)
    .values({ id: payload.sub, email: payload.email, createdAt: Date.now() })
    .onConflictDoNothing()

  c.set('userId', payload.sub)
  c.set('email',  payload.email)
  await next()
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

async function verifyAccessJwt(
  token: string,
  audience: string,
  logger: ReturnType<typeof createLogger>,
): Promise<AccessJwtPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) {
    logger.warn('malformed JWT: wrong segment count')
    return null
  }

  const [headerB64, payloadB64, sigB64] = parts

  let header: JwtHeader
  let payload: AccessJwtPayload
  try {
    header  = JSON.parse(b64urlToUtf8(headerB64))
    payload = JSON.parse(b64urlToUtf8(payloadB64))
  } catch {
    logger.warn('failed to decode JWT segments')
    return null
  }

  // Audience validation
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!aud.includes(audience)) {
    logger.warn('JWT audience mismatch', { aud })
    return null
  }

  // Expiry validation
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    logger.warn('JWT expired', { exp: payload.exp })
    return null
  }

  // Fetch JWKS from the Access certs endpoint — issuer URL is in the JWT itself
  let jwks: { keys: (JsonWebKey & { kid: string })[] }
  try {
    const certsUrl = `${payload.iss}/cdn-cgi/access/certs`
    const res = await fetch(certsUrl)
    if (!res.ok) {
      logger.error('failed to fetch Access JWKS', { status: res.status })
      return null
    }
    jwks = await res.json() as typeof jwks
  } catch (err) {
    logger.error('error fetching Access JWKS', { err: String(err) })
    return null
  }

  const jwk = jwks.keys.find(k => k.kid === header.kid)
  if (!jwk) {
    logger.warn('JWT kid not found in JWKS', { kid: header.kid })
    return null
  }

  // Import RSA public key and verify RS256 signature
  let cryptoKey: CryptoKey
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch (err) {
    logger.error('failed to import JWKS public key', { err: String(err) })
    return null
  }

  const signed    = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const signature = b64urlToBytes(sigB64)

  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    signature,
    signed,
  )

  if (!valid) {
    logger.warn('JWT signature verification failed')
    return null
  }

  return payload
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decodes a base64url string to a UTF-8 string */
function b64urlToUtf8(b64url: string): string {
  return atob(b64url.replace(/-/g, '+').replace(/_/g, '/'))
}

/** Decodes a base64url string to raw bytes */
function b64urlToBytes(b64url: string): Uint8Array {
  const binary = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
