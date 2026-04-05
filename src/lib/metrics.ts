// Metrics for Cloudflare Workers Analytics Engine.
// Free plan limit: 1 index per data point.
// Schema: index1 = event type (discriminator); dimensions go in blobs.

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

// index1:  "parse"
// blob1:   feedId
// blob2:   status ("success" | "failure")
// blob3:   error message (failure only)
// double1: durationMs
// double2: articleCount
function parseEventToDataPoint(binding: AnalyticsEngineDataset, e: ParseEvent) {
  binding.writeDataPoint({
    indexes: ["parse"],
    blobs: [e.feedId, e.status, e.error ?? ""],
    doubles: [e.durationMs, e.articleCount ?? 0],
  });
}

// index1: "read"
// blob1:  userId
// blob2:  articleId
function readEventToDataPoint(binding: AnalyticsEngineDataset, e: ReadEvent) {
  binding.writeDataPoint({
    indexes: ["read"],
    blobs: [e.userId, e.articleId],
  });
}

// index1: "subscription"
// blob1:  userId
// blob2:  feedId
// blob3:  action ("subscribe" | "unsubscribe" | "edit")
// blob4:  folder (empty string if none)
function subscriptionEventToDataPoint(
  binding: AnalyticsEngineDataset,
  e: SubscriptionEvent,
) {
  binding.writeDataPoint({
    indexes: ["subscription"],
    blobs: [e.userId, e.feedId, e.action, e.folder ?? ""],
  });
}

export function createMetrics(binding: AnalyticsEngineDataset | undefined) {
  const logger = createLogger({ lib: "metrics" });
  if (!binding) logger.debug("No analytics binding, metrics are a no-op");

  return {
    recordParse(e: ParseEvent) {
      if (!binding) return;
      parseEventToDataPoint(binding, e);
    },
    recordRead(e: ReadEvent) {
      if (!binding) return;
      readEventToDataPoint(binding, e);
    },
    recordSubscription(e: SubscriptionEvent) {
      if (!binding) return;
      subscriptionEventToDataPoint(binding, e);
    },
  };
}
