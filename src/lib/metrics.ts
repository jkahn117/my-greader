// Business metrics for Cloudflare Workers.
// Backed by @workers-powertools/metrics + PipelinesBackend — writes named-field
// JSON records to a Cloudflare Pipeline (→ R2/Iceberg) for long-term analytics.
//
// Usage:
//   const metrics = createMetrics(env.METRICS_PIPELINE);
//   metrics.recordParse({ feedId, status: ParseStatus.SUCCESS, durationMs });
//
// createMetrics() is a per-call factory so concurrent Workflow steps each
// get their own isolated instance — avoids dimension bleeding between feeds.
//
// The dashboard does NOT query Pipeline data (it's in R2/Iceberg). Cycle
// history and feed health are queried directly from D1 instead.

import { MetricUnit, PipelinesBackend, type MetricContext, type MetricEntry, type PipelineBinding } from "@workers-powertools/metrics";

export enum ParseStatus {
  SUCCESS = "success",
  FAILURE = "failure",
}

export interface ParseEvent {
  feedId: string;
  status: ParseStatus;
  durationMs: number;
  articleCount?: number;
  error?: string;
}

export interface ReadEvent {
  userId: string;
  articleId: string;
  feedId: string;
}

export interface SubscriptionEvent {
  userId: string;
  feedId: string;
  action: "subscribe" | "unsubscribe" | "edit";
  folder?: string;
}

export interface CycleEvent {
  totalActiveFeeds: number;
  dueFeeds: number;
  checkedFeeds: number;
  newArticles: number;
  failedFeeds: number;
}

export interface CycleErrorEvent {
  error: string;
}

export interface FetchErrorEvent {
  feedId: string;
  httpStatus: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const METRIC_CONTEXT: MetricContext = {
  namespace: "rss-reader",
  serviceName: "my-greader",
};

// Explicit return type avoids the circular inference error
interface MetricsApi {
  recordParse(e: ParseEvent): void;
  recordRead(e: ReadEvent): void;
  recordSubscription(e: SubscriptionEvent): void;
  recordCycle(e: CycleEvent): void;
  recordCycleError(e: CycleErrorEvent): void;
  recordFetchError(e: FetchErrorEvent): void;
  // Flush all buffered entries to the Pipeline in a single write.
  // Call at the end of each logical unit of work and register the returned
  // promise with waitUntil() when an ExecutionContext is available.
  flush(): Promise<void>;
}

// enabled defaults to true; pass false when ANALYTICS_ENABLED === "false"
export function createMetrics(
  pipelineBinding: PipelineBinding | undefined,
  enabled = true,
): MetricsApi {
  if (!pipelineBinding || !enabled) {
    // No Pipeline binding in dev, or analytics explicitly disabled — all no-ops
    return noopMetrics;
  }

  const backend = new PipelinesBackend({ binding: pipelineBinding });
  const pending: MetricEntry[] = [];

  // Enqueues a metric entry — does NOT write immediately.
  // Call flush() to send all pending entries in one backend.write().
  function enqueue(name: string, unit: MetricUnit, value: number, dims: Record<string, string> = {}) {
    pending.push({
      name,
      unit,
      value,
      dimensions: { service: "my-greader", ...dims },
      timestamp: Date.now(),
    });
  }

  return {
    recordParse(e: ParseEvent) {
      enqueue("feed_parse_duration_ms", MetricUnit.Milliseconds, e.durationMs, {
        feedId: e.feedId,
        status: e.status,
      });
      if (e.articleCount) {
        enqueue("feed_new_articles", MetricUnit.Count, e.articleCount, {
          feedId: e.feedId,
        });
      }
      if (e.error) {
        // Truncate error message to keep Pipeline record size bounded
        enqueue("feed_parse_failure", MetricUnit.Count, 1, {
          feedId: e.feedId,
          error: e.error.slice(0, 128),
        });
      }
    },

    recordRead(e: ReadEvent) {
      enqueue("article_read", MetricUnit.Count, 1, {
        userId: e.userId,
        feedId: e.feedId,
      });
    },

    recordSubscription(e: SubscriptionEvent) {
      enqueue("subscription_change", MetricUnit.Count, 1, {
        userId: e.userId,
        action: e.action,
      });
    },

    recordCycle(e: CycleEvent) {
      enqueue("cycle_new_articles", MetricUnit.Count, e.newArticles);
      enqueue("cycle_failed_feeds", MetricUnit.Count, e.failedFeeds);
      enqueue("cycle_checked_feeds", MetricUnit.Count, e.checkedFeeds);
    },

    recordCycleError(e: CycleErrorEvent) {
      enqueue("cycle_error", MetricUnit.Count, 1, {
        error: e.error.slice(0, 128),
      });
    },

    recordFetchError(e: FetchErrorEvent) {
      enqueue("feed_fetch_error", MetricUnit.Count, 1, {
        feedId: e.feedId,
        httpStatus: String(e.httpStatus),
      });
    },

    async flush(): Promise<void> {
      if (pending.length === 0) return;
      const entries = pending.splice(0);
      await backend.write(entries, METRIC_CONTEXT);
    },
  };
}

export type Metrics = MetricsApi;

// No-op instance for dev / missing binding
const noopMetrics: MetricsApi = {
  recordParse: () => {},
  recordRead: () => {},
  recordSubscription: () => {},
  recordCycle: () => {},
  recordCycleError: () => {},
  recordFetchError: () => {},
  flush: () => Promise.resolve(),
};
