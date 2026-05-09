// Structured logger for Cloudflare Workers.
// Backed by @workers-powertools/logger — adds CF request enrichment, correlation
// IDs, and log buffering (sub-INFO logs held until an error triggers a flush).
//
// Usage:
//   import { createLogger } from "../lib/logger";
//   const log = createLogger({ path: "/foo", userId });
//   log.info("something happened", { extra: "context" });
//
// The module-level `logger` instance is enriched per-request by the
// injectLogger middleware (via observability.ts). Correlation IDs are
// extracted from request headers automatically. All child loggers created
// via createLogger() snapshot the parent's persistent keys and include the
// current correlation ID.

import { Logger } from "@workers-powertools/logger";

// Module-level singleton — enriched with request context by injectLogger middleware
export const logger = new Logger({
  serviceName: "my-greader",
  // Buffer logs below INFO; flush everything if an error or critical is emitted.
  // This is especially valuable in Workflow steps where the full log trail up
  // to a failure is otherwise invisible.
  logBufferingEnabled: true,
});

/**
 * Returns a child logger pre-tagged with the given context fields plus the
 * current correlation ID (extracted by the injectLogger middleware).
 *
 * Drop-in replacement for all createLogger(ctx) call sites.
 */
export function createLogger(ctx: Record<string, unknown> = {}): Logger {
  const correlationId = logger.getCorrelationId();
  return logger.child(correlationId ? { correlationId, ...ctx } : ctx);
}

export type { Logger };
