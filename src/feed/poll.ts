/**
 * Feed polling module — owns all feed-fetch policy.
 *
 * `createFeedPoller(db, transport, observe, now)` returns one
 * callable function per poll cycle.  The Workflow scheduler
 * provides bindings; the module handles HTTP responses, XML
 * parsing, fallback parsing, item storage, interval backoff,
 * permanent/transient error tracking, and deactivation.
 *
 * Observability tools (logger, metrics, wide events) stay in the
 * Workflow's `PollObserver` adapter — no Powertools imports here.
 */
import Parser from "rss-parser";
import { and, count, eq, isNull } from "drizzle-orm";
import { getDb } from "../lib/db";
import { deriveItemId } from "../lib/crypto";
import { extractReadableContent } from "../lib/readability";
import { parseFeedLenient } from "../lib/feed-parser-fallback";
import {
  feedPollAttempts,
  feeds,
  items,
  type FeedAttemptErrorClass,
  type FeedAttemptOutcome,
} from "../db/schema";

const MAX_CONTENT_BYTES = 50 * 1024;
const TRANSIENT_ERROR_THRESHOLD = 5;
const PERMANENT_ERROR_THRESHOLD = 2;
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 240;
const MAX_TTL_MINUTES = 1440;
const BACKOFF_MULTIPLIER = 2;

const PERMANENT_ERROR_STATUSES = new Set([401, 403, 404, 410]);

type ErrorClass = "transient" | "permanent";

export type FeedToCheck = {
  id: string;
  feedUrl: string;
  title: string | null;
  htmlUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: number | null;
  consecutiveErrors: number;
  checkIntervalMinutes: number;
  lastNewItemAt: number | null;
};

export type FeedPollResult =
  | {
      feedId: string;
      feedTitle: string;
      outcome: "new_items";
      newItems: number;
    }
  | {
      feedId: string;
      feedTitle: string;
      outcome: "unchanged";
      newItems: number;
    }
  | { feedId: string; feedTitle: string; outcome: "not_modified" }
  | { feedId: string; feedTitle: string; outcome: "rate_limited" }
  | { feedId: string; feedTitle: string; outcome: "skipped" }
  | {
      feedId: string;
      feedTitle: string;
      outcome: "failed";
      errorClass: FeedAttemptErrorClass;
      error: string;
    };

export type PollEvent =
  | {
      kind: "feedPolled";
      feedId: string;
      newItems: number;
      durationMs: number;
      parseStatus: "success" | "fallback";
    }
  | { kind: "feedNotModified"; feedId: string; newInterval: number }
  | { kind: "feedRateLimited"; feedId: string; backoffMinutes: number }
  | {
      kind: "feedFetchFailed";
      feedId: string;
      status?: number;
      error: string;
    }
  | { kind: "feedParseFailed"; feedId: string; error: string }
  | { kind: "feedDeactivated"; feedId: string; consecutiveErrors: number };

export interface FeedTransport {
  get(url: string, headers: Record<string, string>): Promise<Response>;
}

export interface PollObserver {
  publish(event: PollEvent): void;
}

export type PollTriggerReason = "scheduled" | "manual" | "forced";

export type PollAttemptContext = {
  cycleRunId: string;
  attemptId: string;
};

export interface FeedPoller {
  poll(feed: FeedToCheck, attempt: PollAttemptContext): Promise<FeedPollResult>;
}

// Returns a poller that fetches and stores one feed at a time.
// Dependencies (D1, HTTP transport, observer, clock) are provided
// at creation and shared across all calls to `poll()`.

export function createFeedPoller(
  dbBinding: D1Database,
  transport: FeedTransport,
  observe: PollObserver,
  now: () => number,
): FeedPoller {
  const d = getDb(dbBinding);

  return { poll };

  async function poll(
    feed: FeedToCheck,
    attempt: PollAttemptContext,
  ): Promise<FeedPollResult> {
    const start = now();
    const feedTitle = feed.title ?? feed.feedUrl;

    // Persist progress before external work. A Workflow retry returns a prior
    // terminal result instead of fetching or mutating Feed policy again.
    const [, attemptRows, currentFeeds] = await d.batch([
      d
        .insert(feedPollAttempts)
        .values({
          id: attempt.attemptId,
          cycleRunId: attempt.cycleRunId,
          feedId: feed.id,
          startedAt: start,
        })
        .onConflictDoNothing(),
      d
        .select({
          outcome: feedPollAttempts.outcome,
          newItems: feedPollAttempts.newItems,
          errorClass: feedPollAttempts.errorClass,
          diagnostic: feedPollAttempts.diagnostic,
        })
        .from(feedPollAttempts)
        .where(eq(feedPollAttempts.id, attempt.attemptId)),
      d
        .select({ deactivatedAt: feeds.deactivatedAt })
        .from(feeds)
        .where(eq(feeds.id, feed.id)),
    ]);
    const durableAttempt = attemptRows[0];
    if (durableAttempt?.outcome != null) {
      return resultFromAttempt(feed.id, feedTitle, {
        ...durableAttempt,
        outcome: durableAttempt.outcome,
      });
    }

    if (currentFeeds[0]?.deactivatedAt != null) {
      await completeAttempt(attempt.attemptId, {
        outcome: "skipped",
        parserStatus: "not_attempted",
        diagnostic: "Feed became ineligible after selection",
      });
      return { feedId: feed.id, feedTitle, outcome: "skipped" };
    }

    const headers: Record<string, string> = {
      "User-Agent": "my-greader/1.0 (+https://github.com)",
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    };
    if (feed.etag) headers["If-None-Match"] = feed.etag;
    if (feed.lastModified) headers["If-Modified-Since"] = feed.lastModified;

    let response: Response;
    try {
      response = await transport.get(feed.feedUrl, headers);
    } catch (err) {
      const errorMessage = safeDiagnostic(
        err instanceof Error ? err.message : String(err),
      );
      await recordError(feed, errorMessage, "transient");
      await completeAttempt(attempt.attemptId, {
        outcome: "failed",
        errorClass: "network",
        parserStatus: "not_attempted",
        diagnostic: errorMessage,
      });
      publish({
        kind: "feedFetchFailed",
        feedId: feed.id,
        error: errorMessage,
      });
      return {
        feedId: feed.id,
        feedTitle,
        outcome: "failed",
        errorClass: "network",
        error: errorMessage,
      };
    }

    if (response.status === 304) {
      const newInterval = Math.min(
        feed.checkIntervalMinutes * BACKOFF_MULTIPLIER,
        MAX_INTERVAL_MINUTES,
      );
      await d
        .update(feeds)
        .set({
          lastFetchedAt: now(),
          checkIntervalMinutes: newInterval,
        })
        .where(eq(feeds.id, feed.id));
      await completeAttempt(attempt.attemptId, {
        outcome: "not_modified",
        httpStatus: 304,
        parserStatus: "not_attempted",
      });
      publish({
        kind: "feedNotModified",
        feedId: feed.id,
        newInterval,
      });
      return { feedId: feed.id, feedTitle, outcome: "not_modified" };
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      let backoffMinutes = Math.min(
        feed.checkIntervalMinutes * BACKOFF_MULTIPLIER,
        MAX_INTERVAL_MINUTES,
      );
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          backoffMinutes = Math.max(Math.ceil(seconds / 60), backoffMinutes);
        } else {
          const retryMs = new Date(retryAfter).getTime();
          if (!isNaN(retryMs)) {
            backoffMinutes = Math.max(
              Math.ceil((retryMs - now()) / 60_000),
              backoffMinutes,
            );
          }
        }
      }
      const errorMessage = "HTTP 429 (rate limited)";
      await d
        .update(feeds)
        .set({
          lastFetchedAt: now(),
          checkIntervalMinutes: backoffMinutes,
          lastError: errorMessage,
        })
        .where(eq(feeds.id, feed.id));
      await completeAttempt(attempt.attemptId, {
        outcome: "rate_limited",
        httpStatus: 429,
        parserStatus: "not_attempted",
        diagnostic: errorMessage,
      });
      publish({
        kind: "feedRateLimited",
        feedId: feed.id,
        backoffMinutes,
      });
      return {
        feedId: feed.id,
        feedTitle,
        outcome: "rate_limited",
      };
    }

    if (!response.ok) {
      const isPermanent = PERMANENT_ERROR_STATUSES.has(response.status);
      const errorClass: ErrorClass = isPermanent ? "permanent" : "transient";
      const errorMessage = `HTTP ${response.status}${isPermanent ? " (permanent)" : ""}`;
      await recordError(feed, errorMessage, errorClass);
      await completeAttempt(attempt.attemptId, {
        outcome: "failed",
        errorClass: "http",
        httpStatus: response.status,
        parserStatus: "not_attempted",
        diagnostic: errorMessage,
      });
      publish({
        kind: "feedFetchFailed",
        feedId: feed.id,
        status: response.status,
        error: errorMessage,
      });
      return {
        feedId: feed.id,
        feedTitle,
        outcome: "failed",
        errorClass: "http",
        error: errorMessage,
      };
    }

    let xml: string;
    try {
      xml = await response.text();
    } catch (err) {
      const errorMessage = safeDiagnostic(
        err instanceof Error ? err.message : String(err),
      );
      await recordError(feed, errorMessage, "transient");
      await completeAttempt(attempt.attemptId, {
        outcome: "failed",
        errorClass: "network",
        httpStatus: response.status,
        parserStatus: "not_attempted",
        diagnostic: errorMessage,
      });
      publish({
        kind: "feedFetchFailed",
        feedId: feed.id,
        status: response.status,
        error: errorMessage,
      });
      return {
        feedId: feed.id,
        feedTitle,
        outcome: "failed",
        errorClass: "network",
        error: errorMessage,
      };
    }
    const parser = new Parser({
      customFields: { item: [["content:encoded", "contentEncoded"]] },
    });
    let parsed;
    let parseStatus: "success" | "fallback" = "success";

    try {
      parsed = await parser.parseString(xml);
    } catch (e) {
      const parserError = safeDiagnostic((e as Error).message);

      const fallback = parseFeedLenient(xml);
      if (fallback && fallback.items.length > 0) {
        parsed = fallback;
        parseStatus = "fallback";
      } else {
        await recordError(feed, parserError, "transient");
        await completeAttempt(attempt.attemptId, {
          outcome: "failed",
          errorClass: "parse",
          httpStatus: response.status,
          parserStatus: "failure",
          diagnostic: parserError,
        });
        publish({
          kind: "feedParseFailed",
          feedId: feed.id,
          error: parserError,
        });
        return {
          feedId: feed.id,
          feedTitle,
          outcome: "failed",
          errorClass: "parse",
          error: parserError,
        };
      }
    }

    const newEtag = response.headers.get("ETag");
    const newLastModified = response.headers.get("Last-Modified");
    const time = now();

    const itemRows = (
      await Promise.all(
        (parsed.items ?? []).map(async (item: any) => {
          const guid = item.guid ?? item.link;
          if (!guid) return null;
          return {
            id: await deriveItemId(guid),
            feedId: feed.id,
            title: item.title ?? null,
            url: item.link ?? null,
            content: (() => {
              const raw = [
                item.content,
                item.contentEncoded,
                item.summary,
                item.contentSnippet,
              ]
                .filter(Boolean)
                .reduce<string>(
                  (best, c) => (c.length > best.length ? c : best),
                  "",
                );
              const cleaned =
                raw.length > 500 ? (extractReadableContent(raw) ?? raw) : raw;
              return trimContent(cleaned, MAX_CONTENT_BYTES);
            })(),
            author: item.creator ?? item.author ?? null,
            publishedAt: item.isoDate ? new Date(item.isoDate).getTime() : time,
            fetchedAt: time,
            firstIngestionAttemptId: attempt.attemptId,
          };
        }),
      )
    ).filter((r): r is NonNullable<typeof r> => r !== null);

    // After the initial backload, only insert items published recently
    // enough to prevent re-backloading purged items from long-tail feeds.
    const BACKLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
    const lastNew = feed.lastNewItemAt;
    const toInsert =
      lastNew != null
        ? itemRows.filter(
            (row) => row.publishedAt >= lastNew - BACKLOAD_WINDOW_MS,
          )
        : itemRows;

    const itemInserts = toInsert.map((row) =>
      d.insert(items).values(row).onConflictDoNothing(),
    );
    if (itemInserts.length > 0) {
      await d.batch(itemInserts as unknown as [any, ...any[]]);
    }
    // Count durable attribution rather than this execution's insert changes.
    // A retry after Item insertion but before completion reconstructs the same count.
    const attributed = await d
      .select({ count: count(items.id) })
      .from(items)
      .where(eq(items.firstIngestionAttemptId, attempt.attemptId));
    const newItems = Number(attributed[0]?.count ?? 0);

    const feedTtlMinutes = parsed.ttl
      ? Math.min(Math.round(Number(parsed.ttl)), MAX_TTL_MINUTES)
      : 0;
    const backoffInterval =
      newItems > 0
        ? MIN_INTERVAL_MINUTES
        : Math.min(
            feed.checkIntervalMinutes * BACKOFF_MULTIPLIER,
            MAX_INTERVAL_MINUTES,
          );
    const newInterval = Math.max(backoffInterval, feedTtlMinutes);

    const outcome = newItems > 0 ? "new_items" : "unchanged";
    await d.batch([
      d
        .update(feedPollAttempts)
        .set({
          completedAt: now(),
          outcome,
          newItems,
          httpStatus: response.status,
          parserStatus: parseStatus,
        })
        .where(
          and(
            eq(feedPollAttempts.id, attempt.attemptId),
            isNull(feedPollAttempts.outcome),
          ),
        ),
      d
        .update(feeds)
        .set({
          lastFetchedAt: time,
          consecutiveErrors: 0,
          lastError: null,
          checkIntervalMinutes: newInterval,
          lastNewItemAt: newItems > 0 ? time : (feed.lastNewItemAt ?? time),
          ...(feed.title == null && parsed.title != null
            ? { title: parsed.title }
            : {}),
          ...(feed.htmlUrl == null && parsed.link != null
            ? { htmlUrl: parsed.link }
            : {}),
          ...(newEtag != null ? { etag: newEtag } : {}),
          ...(newLastModified != null ? { lastModified: newLastModified } : {}),
        })
        .where(eq(feeds.id, feed.id)),
    ]);

    publish({
      kind: "feedPolled",
      feedId: feed.id,
      newItems,
      durationMs: now() - start,
      parseStatus,
    });

    return { feedId: feed.id, feedTitle, outcome, newItems };
  }

  /** Records one terminal attempt without overwriting an earlier completion. */
  async function completeAttempt(
    attemptId: string,
    values: {
      outcome: "not_modified" | "rate_limited" | "failed" | "skipped";
      errorClass?: FeedAttemptErrorClass;
      httpStatus?: number;
      parserStatus: "not_attempted" | "failure";
      diagnostic?: string;
    },
  ): Promise<void> {
    await d
      .update(feedPollAttempts)
      .set({
        ...values,
        completedAt: now(),
      })
      .where(
        and(
          eq(feedPollAttempts.id, attemptId),
          isNull(feedPollAttempts.outcome),
        ),
      );
  }

  /** Keeps observer failures outside the durable polling contract. */
  function publish(event: PollEvent): void {
    try {
      observe.publish(event);
    } catch {
      // Observers are best effort and cannot alter a committed domain outcome.
    }
  }

  async function recordError(
    feed: FeedToCheck,
    errorMessage: string,
    errorClass: ErrorClass,
  ): Promise<void> {
    const threshold =
      errorClass === "permanent"
        ? PERMANENT_ERROR_THRESHOLD
        : TRANSIENT_ERROR_THRESHOLD;
    const next = feed.consecutiveErrors + 1;
    const deactivate = next >= threshold;
    await d
      .update(feeds)
      .set({
        consecutiveErrors: next,
        lastError: errorMessage,
        lastFetchedAt: now(),
        ...(deactivate ? { deactivatedAt: now() } : {}),
      })
      .where(eq(feeds.id, feed.id));
    if (deactivate) {
      publish({
        kind: "feedDeactivated",
        feedId: feed.id,
        consecutiveErrors: next,
      });
    }
  }
}

/** Reconstructs a completed logical attempt for a Workflow step retry. */
function resultFromAttempt(
  feedId: string,
  feedTitle: string,
  attempt: {
    outcome: FeedAttemptOutcome;
    newItems: number;
    errorClass: FeedAttemptErrorClass | null;
    diagnostic: string | null;
  },
): FeedPollResult {
  switch (attempt.outcome) {
    case "new_items":
    case "unchanged":
      return {
        feedId,
        feedTitle,
        outcome: attempt.outcome,
        newItems: attempt.newItems,
      };
    case "not_modified":
    case "rate_limited":
    case "skipped":
      return { feedId, feedTitle, outcome: attempt.outcome };
    case "failed":
      if (attempt.errorClass == null) {
        throw new Error(
          `Completed attempt for Feed ${feedId} lacks an error class`,
        );
      }
      return {
        feedId,
        feedTitle,
        outcome: "failed",
        errorClass: attempt.errorClass,
        error: attempt.diagnostic ?? "Feed polling failed",
      };
  }
}

function trimContent(content: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(content);
  if (encoded.length <= maxBytes) return content;
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

/** Removes common credential-bearing URL detail and bounds stored diagnostics. */
function safeDiagnostic(message: string): string {
  const redacted = message
    .replace(/(https?:\/\/)([^@\s/]+)@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]")
    .replace(/\b(Bearer|GoogleLogin)\s+[^\s]+/gi, "$1 [redacted]")
    .replace(/\b(auth|token|key|secret)=([^\s&]+)/gi, "$1=[redacted]");
  return redacted.slice(0, 500);
}
