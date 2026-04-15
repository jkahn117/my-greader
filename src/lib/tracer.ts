// Trace enrichment for Cloudflare Workers.
// Backed by @workers-powertools/tracer — manages correlation IDs and custom
// application spans with timing and error capture.
//
// The module-level `tracer` is enriched per-request by the observability
// middleware (tracer.addContext), which extracts or generates a correlation
// ID from request headers (x-correlation-id, x-request-id, cf-ray).
//
// Use tracer.captureAsync() to create a named span around any async operation:
//   const result = await tracer.captureAsync("fetchAndStoreFeed", async (span) => {
//     span.annotations.feedId = feed.id;
//     return doWork();
//   });
//
// Use tracer.captureFetch() for service-to-service calls (injects correlation
// ID headers into outbound requests). Do NOT use it for external feed URLs —
// adding trace headers to RSS feeds is unnecessary and looks suspicious.

import { Tracer } from "@workers-powertools/tracer";

// Module-level singleton — addContext() called per request in observability middleware
export const tracer = new Tracer({ serviceName: "my-greader" });
