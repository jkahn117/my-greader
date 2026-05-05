// Per-request observability setup — runs before all route handlers.
//
// Uses @workers-powertools/hono injectLogger middleware to:
//   - Enrich the module-level logger with request context per request
//   - Extract correlation ID from cf-ray / x-correlation-id / x-request-id
//   - Add Cloudflare properties (colo, country, etc.) to every log entry
//   - Create a request-scoped wide event (c.get("wideEvent")) that auto-emits
//     with duration_ms after the handler completes

import { injectLogger } from "@workers-powertools/hono/logger";
import { logger } from "../lib/logger";

export const observabilityMiddleware = injectLogger(logger, { wideEvent: true });
