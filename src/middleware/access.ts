import type { Context, Next } from "hono";
import * as v from "valibot";
import { getDb } from "../lib/db";
import { users } from "../db/schema";
import { createLogger, Logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JwtHeader {
  alg: string;
  kid: string;
}

const nonEmptyString = v.pipe(
  v.string(),
  v.check((value) => value.trim().length > 0),
);
const numericDate = v.pipe(v.number(), v.finite(), v.integer());
const accessClaims = v.object({
  iss: nonEmptyString,
  sub: nonEmptyString,
  aud: v.union([
    nonEmptyString,
    v.pipe(v.array(nonEmptyString), v.minLength(1)),
  ]),
  email: nonEmptyString,
  iat: numericDate,
  exp: numericDate,
});
type AccessJwtPayload = v.InferOutput<typeof accessClaims>;
const jwksSchema = v.object({
  keys: v.array(
    v.object({
      kid: nonEmptyString,
      kty: v.literal("RSA"),
      n: nonEmptyString,
      e: nonEmptyString,
      alg: v.optional(v.literal("RS256")),
      use: v.optional(v.literal("sig")),
      key_ops: v.optional(v.array(v.literal("verify"))),
    }),
  ),
});

// Hardcoded dev identity — used when Cloudflare Access is not configured
export const DEV_USER_ID = "dev-user-id";
export const DEV_USER_EMAIL = "dev@localhost";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// In-memory cache for JWKS to persist for lifetime of isolate
let jwksCache: {
  issuer: string;
  jwks: v.InferOutput<typeof jwksSchema>;
  cachedAt: number;
} | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  const logger = createLogger({ path: c.req.path });
  const env = c.env as Env;

  // Dev bypass — gated on DEV_MODE; never set in production
  if (env.DEV_MODE === "true") {
    const db = getDb(env.DB);
    await db
      .insert(users)
      .values({ id: DEV_USER_ID, email: DEV_USER_EMAIL, createdAt: Date.now() })
      .onConflictDoNothing();
    c.set("userId", DEV_USER_ID);
    c.set("email", DEV_USER_EMAIL);
    return next();
  }

  const jwtToken = c.req.header("Cf-Access-Jwt-Assertion");
  if (!jwtToken) {
    logger.warn("missing Cf-Access-Jwt-Assertion header");
    return c.text("Unauthorized", 401);
  }

  if (!env.CF_ACCESS_AUD || !isHttpsIssuer(env.CF_ACCESS_ISSUER)) {
    logger.error(
      "Cloudflare Access audience or HTTPS issuer is not configured",
    );
    return c.text("Authentication unavailable", 500);
  }

  const payload = await verifyAccessJwt(
    jwtToken,
    env.CF_ACCESS_AUD,
    env.CF_ACCESS_ISSUER,
    logger,
  );
  if (!payload) {
    return c.text("Unauthorized", 401);
  }

  // Auto-provision user on first login — no admin required for single-user setup
  const db = getDb(env.DB);
  await db
    .insert(users)
    .values({ id: payload.sub, email: payload.email, createdAt: Date.now() })
    .onConflictDoNothing();

  c.set("userId", payload.sub);
  c.set("email", payload.email);
  await next();
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

async function verifyAccessJwt(
  token: string,
  audience: string,
  issuer: string,
  logger: ReturnType<typeof createLogger>,
): Promise<AccessJwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    logger.warn("malformed JWT: wrong segment count");
    return null;
  }

  const [headerB64, payloadB64, sigB64] = parts;

  let header: JwtHeader;
  let payload: AccessJwtPayload;
  try {
    header = JSON.parse(b64urlToUtf8(headerB64));
    payload = v.parse(accessClaims, JSON.parse(b64urlToUtf8(payloadB64)));
  } catch {
    logger.warn("failed to decode JWT segments");
    return null;
  }

  if (
    !header ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !header.kid.trim()
  ) {
    logger.warn("JWT algorithm or key ID is invalid");
    return null;
  }

  if (payload.iss !== issuer) {
    logger.warn("JWT issuer mismatch");
    return null;
  }

  // Audience validation
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) {
    logger.warn("JWT audience mismatch", { aud });
    return null;
  }

  // Expiry validation
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    logger.warn("JWT expired", { exp: payload.exp });
    return null;
  }

  // Only the configured issuer may supply verification keys.
  const usedCache = hasFreshJwks(issuer);
  let jwks = await fetchJwks(issuer, logger);
  if (!jwks) return null;

  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk && usedCache) {
    jwks = await fetchJwks(issuer, logger, true);
    if (!jwks) return null;
    jwk = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    logger.warn("JWT kid not found in JWKS", { kid: header.kid });
    return null;
  }

  // Import RSA public key and verify RS256 signature
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (err) {
    logger.error("failed to import JWKS public key", { err: String(err) });
    return null;
  }

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let valid: boolean;
  try {
    const signature = b64urlToBytes(sigB64);
    valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      cryptoKey,
      signature,
      signed,
    );
  } catch {
    logger.warn("invalid JWT signature data");
    return null;
  }

  if (!valid) {
    logger.warn("JWT signature verification failed");
    return null;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept only a configured HTTPS origin, without credentials or path components. */
function isHttpsIssuer(issuer: unknown): issuer is string {
  if (typeof issuer !== "string") return false;
  try {
    const url = new URL(issuer);
    return url.protocol === "https:" && url.origin === issuer;
  } catch {
    return false;
  }
}

/** Cache reuse is restricted to the configured issuer and the one-hour TTL. */
function hasFreshJwks(issuer: string): boolean {
  return (
    jwksCache !== null &&
    jwksCache.issuer === issuer &&
    Date.now() - jwksCache.cachedAt >= 0 &&
    Date.now() - jwksCache.cachedAt < JWKS_TTL_MS
  );
}

/** Fetch Access keys without redirecting to an untrusted key service or falling back to stale data. */
async function fetchJwks(
  issuer: string,
  logger: Logger,
  refresh = false,
): Promise<v.InferOutput<typeof jwksSchema> | null> {
  if (!refresh && hasFreshJwks(issuer) && jwksCache) {
    return jwksCache.jwks;
  }

  try {
    const res = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      redirect: "manual",
    });

    if (!res.ok) {
      logger.error("failed to fetch Access JWKS", { status: res.status });
      return null;
    }

    const jwks = v.parse(jwksSchema, await res.json());
    jwksCache = { issuer, jwks, cachedAt: Date.now() };
    return jwks;
  } catch (err) {
    logger.error("error fetching Access JWKS", { err: String(err) });
    return null;
  }
}

/** Decodes a base64url string to a UTF-8 string */
function b64urlToUtf8(b64url: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    b64urlToBytes(b64url),
  );
}

/** Decodes a base64url string to raw bytes */
function b64urlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url) || b64url.length % 4 === 1) {
    throw new Error("Invalid base64url encoding");
  }
  const decoded = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}
