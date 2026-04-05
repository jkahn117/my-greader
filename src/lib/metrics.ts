// Metrics for Cloudflare Workers
// Send metrics to Workers Analytics Engine

import { createLogger } from "./logger";

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
}

export interface SubscriptionEvent {
  userId: string;
  feedId: string;
  action: "subscribe" | "unsubscribe" | "edit";
  folder?: string;
}

export enum ParseStatus {
  SUCCESS = "success",
  FAILURE = "failure",
}

// indexes: [event, feedId, status]
// doubles: [durationMs, articleCount]
// blobs:   [error]
function parseEventToDataPoint(binding: AnalyticsEngineDataset, e: ParseEvent) {
  binding.writeDataPoint({
    indexes: ["parse", e.feedId, e.status],
    doubles: [e.durationMs, e.articleCount ?? 0],
    ...(e.error ? { blobs: [e.error] } : {}),
  });
}

// indexes:  [event, userId]
// blobs:    [articleId]
function readEventToDataPoint(binding: AnalyticsEngineDataset, e: ReadEvent) {
  binding.writeDataPoint({
    indexes: ["read", e.userId],
    blobs: [e.articleId],
  });
}

// indexes: [event, userId, feedId, action]
// blobs:   [folder]
function subscriptionEventToDataPoint(
  binding: AnalyticsEngineDataset,
  e: SubscriptionEvent,
) {
  binding.writeDataPoint({
    indexes: ["subscription", e.userId, e.feedId, e.action],
    ...(e.folder ? { blobs: [e.folder] } : {}),
  });
}

export function createMetrics(binding: AnalyticsEngineDataset | undefined) {
  const logger = createLogger({ metrics: "createMetrics" });
  if (!binding) {
    logger.warn("No analytics binding, skipping");
  }

  return {
    recordParse(e: ParseEvent) {
      if (!binding) {
        return;
      }
      parseEventToDataPoint(binding, e);
    },
    recordRead(e: ReadEvent) {
      if (!binding) {
        return;
      }
      readEventToDataPoint(binding, e);
    },
    recordSubscription(e: SubscriptionEvent) {
      if (!binding) {
        return;
      }
      subscriptionEventToDataPoint(binding, e);
    },
  };
}
