// Per-request observability setup — runs before all route handlers.
//
// Enriches the module-level logger and tracer with request context:
//   - Correlation ID extracted from cf-ray / x-correlation-id / x-request-id
//   - Cloudflare properties (colo, country, etc.) added to every log entry
//   - Cold-start detection

import type { Context, Next } from "hono";
import { logger } from "../lib/logger";
import { tracer } from "../lib/tracer";

export async function observabilityMiddleware(c: Context, next: Next): Promise<Response | void> {
  // addContext extracts correlation ID and CF request properties.
  // The tracer must be enriched first so createLogger() can snapshot its
  // correlation ID into child loggers via logger.child({ correlationId }).
  tracer.addContext(c.req.raw, c.executionCtx, c.env as Record<string, unknown>);
  logger.addContext(c.req.raw, c.executionCtx, c.env as Record<string, unknown>);
  return next();
}
