import type { Context, Next } from 'hono'
import { createLogger } from '../lib/logger'

const RESPONSE_BODY_CAP = 10 * 1024 // 10 KB

// Headers that carry credentials — log the type but not the value
const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'cf-access-jwt-assertion'])

function scrubHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value
  })
  return out
}

/**
 * Exhaustive request+response trace middleware for debugging unknown clients.
 * Enabled only when TRACE_REQUESTS=true in env (set in .dev.vars locally).
 * Emits a single structured log entry per request containing the full
 * request (method, URL, query params, headers, body) and response
 * (status, headers, body truncated to 10 KB).
 */
export async function traceMiddleware(c: Context, next: Next) {
  const env = c.env as Env
  if (!env.TRACE_REQUESTS) {
    return next()
  }

  const logger = createLogger({ middleware: 'trace' })
  const req    = c.req.raw
  const url    = new URL(req.url)

  // Capture request body without consuming the stream Hono will read later
  const reqBodyRaw = await req.clone().text().catch(() => null)

  // Run the rest of the stack
  await next()

  // Clone the response so we can read its body without consuming the one
  // Hono will send to the client
  const res         = c.res
  const resClone    = res.clone()
  const resBodyRaw  = await resClone.text().catch(() => null)
  const resBodyText = resBodyRaw !== null && resBodyRaw.length > RESPONSE_BODY_CAP
    ? resBodyRaw.slice(0, RESPONSE_BODY_CAP) + `… [truncated ${resBodyRaw.length - RESPONSE_BODY_CAP}B]`
    : resBodyRaw

  // Collect query params as a plain object for readability
  const query: Record<string, string | string[]> = {}
  url.searchParams.forEach((value, key) => {
    const existing = query[key]
    if (existing === undefined) {
      query[key] = value
    } else {
      query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
    }
  })

  logger.debug('trace', {
    req: {
      method:  req.method,
      path:    url.pathname,
      query,
      headers: scrubHeaders(req.headers),
      body:    reqBodyRaw ?? null,
    },
    res: {
      status:  res.status,
      headers: scrubHeaders(res.headers),
      body:    resBodyText ?? null,
    },
  })
}
