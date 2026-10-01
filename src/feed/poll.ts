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
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { deriveItemId } from "../lib/crypto";
import { extractReadableContent } from "../lib/readability";
import { parseFeedLenient } from "../lib/feed-parser-fallback";
import {
  feedPollAttempts,
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
const MAX_D1_JSON_PARAMETER_BYTES = 1_500_000;
const POLL_LEASE_MS = 5 * 60 * 1000;

const PERMANENT_ERROR_STATUSES = new Set([401, 403, 404, 410]);

type ErrorClass = "transient" | "permanent";

export type FeedDeactivationReason =
  | "manual"
  | "automatic_transient"
  | "automatic_permanent"
  | "legacy_unknown";

export type PollStateOrigin =
  | "explicit"
  | "legacy_inferred"
  | "legacy_uncertain";

type ItemCommitRow = {
  id: string;
  feedId: string;
  title: string | null;
  url: string | null;
  content: string;
  author: string | null;
  publishedAt: number;
  fetchedAt: number;
  firstIngestionAttemptId: string;
};

export type FeedToCheck = {
  id: string;
  feedUrl: string;
  title: string | null;
  htmlUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  lastSuccessfulPollAt: number | null;
  lastNewItemDiscoveredAt: number | null;
  initialBackloadCompletedAt: number | null;
  nextPollAt: number | null;
  consecutiveErrors: number;
  checkIntervalMinutes: number;
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

export interface FeedHealth {
  deactivate(userId: string, feedId: string): Promise<boolean>;
  reactivate(userId: string, feedId: string): Promise<boolean>;
}

/** Owns authorized manual Feed health transitions and polling cancellation. */
export function createFeedHealth(
  dbBinding: D1Database,
  now: () => number,
): FeedHealth {
  return { deactivate, reactivate };

  /** Pauses a subscribed Feed and cancels work that could overwrite that decision. */
  async function deactivate(userId: string, feedId: string): Promise<boolean> {
    const changedAt = now();
    const results = await dbBinding.batch([
      cancelOwnedAttempt(
        userId,
        feedId,
        changedAt,
        "Feed manually deactivated",
      ),
      dbBinding
        .prepare(
          `UPDATE feeds
              SET deactivated_at = ?, deactivation_reason = 'manual',
                  poll_owner_attempt_id = NULL, poll_lease_expires_at = NULL,
                  poll_fence = poll_fence + 1
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM subscriptions
               WHERE user_id = ? AND feed_id = feeds.id
            )`,
        )
        .bind(changedAt, feedId, userId),
    ]);
    return (results[1].meta.changes ?? 0) > 0;
  }

  /** Restores a subscribed Feed to immediate eligibility and initial Backoff. */
  async function reactivate(userId: string, feedId: string): Promise<boolean> {
    const changedAt = now();
    const results = await dbBinding.batch([
      cancelOwnedAttempt(
        userId,
        feedId,
        changedAt,
        "Feed manually reactivated",
      ),
      dbBinding
        .prepare(
          `UPDATE feeds
              SET deactivated_at = NULL, deactivation_reason = NULL,
                  consecutive_errors = 0, last_error = NULL,
                  check_interval_minutes = ?, next_poll_at = NULL,
                  poll_owner_attempt_id = NULL, poll_lease_expires_at = NULL,
                  poll_fence = poll_fence + 1
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM subscriptions
               WHERE user_id = ? AND feed_id = feeds.id
            )`,
        )
        .bind(MIN_INTERVAL_MINUTES, feedId, userId),
    ]);
    return (results[1].meta.changes ?? 0) > 0;
  }

  /** Completes an authorized transition's in-flight attempt before revoking ownership. */
  function cancelOwnedAttempt(
    userId: string,
    feedId: string,
    completedAt: number,
    diagnostic: string,
  ): D1PreparedStatement {
    return dbBinding
      .prepare(
        `UPDATE feed_poll_attempts
            SET completed_at = ?, outcome = 'skipped',
                parser_status = 'not_attempted', diagnostic = ?
          WHERE id = (
            SELECT poll_owner_attempt_id FROM feeds
             WHERE id = ? AND EXISTS (
               SELECT 1 FROM subscriptions
                WHERE user_id = ? AND feed_id = feeds.id
             )
          ) AND outcome IS NULL`,
      )
      .bind(completedAt, diagnostic, feedId, userId);
  }
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
    selectedFeed: FeedToCheck,
    attempt: PollAttemptContext,
  ): Promise<FeedPollResult> {
    const start = now();
    let feed = selectedFeed;
    let feedTitle = feed.title ?? feed.feedUrl;

    // Persist progress and claim the Feed in one D1 transaction. The fence is
    // stable for retries of this logical attempt and increases for a new owner.
    const leaseExpiresAt = start + POLL_LEASE_MS;
    const claimResults = await dbBinding.batch([
      dbBinding
        .prepare(
          `INSERT INTO feed_poll_attempts
            (id, cycle_run_id, feed_id, started_at, new_items)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(attempt.attemptId, attempt.cycleRunId, feed.id, start),
      dbBinding
        .prepare(
          `UPDATE feeds
              SET poll_owner_attempt_id = ?, poll_lease_expires_at = ?,
                  poll_fence = poll_fence + 1
            WHERE id = ? AND deactivated_at IS NULL
              AND EXISTS (
                SELECT 1 FROM feed_poll_attempts
                 WHERE id = ? AND cycle_run_id = ? AND feed_id = ?
                   AND outcome IS NULL AND ownership_fence IS NULL
              )
              AND (
                poll_owner_attempt_id IS NULL OR poll_lease_expires_at <= ?
                OR EXISTS (
                  SELECT 1 FROM feed_poll_attempts owner
                   WHERE owner.id = poll_owner_attempt_id
                     AND owner.outcome IS NOT NULL
                )
              )`,
        )
        .bind(
          attempt.attemptId,
          leaseExpiresAt,
          feed.id,
          attempt.attemptId,
          attempt.cycleRunId,
          feed.id,
          start,
        ),
      dbBinding
        .prepare(
          `UPDATE feed_poll_attempts
              SET ownership_fence = (
                SELECT poll_fence FROM feeds WHERE id = feed_id
              )
            WHERE id = ?
              AND EXISTS (
                SELECT 1 FROM feeds
                 WHERE id = feed_id AND poll_owner_attempt_id = ?
              )`,
        )
        .bind(attempt.attemptId, attempt.attemptId),
      dbBinding
        .prepare(
          `UPDATE feeds
              SET poll_lease_expires_at = ?, poll_fence = poll_fence + 1
            WHERE id = ? AND poll_owner_attempt_id = ?
              AND poll_lease_expires_at <= ?
              AND poll_fence = (
                SELECT ownership_fence FROM feed_poll_attempts WHERE id = ?
              )
              AND EXISTS (
                SELECT 1 FROM feed_poll_attempts
                 WHERE id = ? AND cycle_run_id = ? AND feed_id = ?
                   AND outcome IS NULL
              )`,
        )
        .bind(
          leaseExpiresAt,
          feed.id,
          attempt.attemptId,
          start,
          attempt.attemptId,
          attempt.attemptId,
          attempt.cycleRunId,
          feed.id,
        ),
      dbBinding
        .prepare(
          `UPDATE feed_poll_attempts
              SET ownership_fence = (
                SELECT poll_fence FROM feeds WHERE id = feed_id
              )
            WHERE id = ?
              AND EXISTS (
                SELECT 1 FROM feeds
                 WHERE id = feed_id AND poll_owner_attempt_id = ?
              )`,
        )
        .bind(attempt.attemptId, attempt.attemptId),
      dbBinding
        .prepare(
          `UPDATE feeds
              SET poll_owner_attempt_id = ?, poll_lease_expires_at = ?
            WHERE id = ? AND deactivated_at IS NULL
              AND poll_owner_attempt_id = ? AND poll_lease_expires_at > ?
              AND poll_fence = (
                SELECT ownership_fence FROM feed_poll_attempts WHERE id = ?
              )
              AND EXISTS (
                SELECT 1 FROM feed_poll_attempts
                 WHERE id = ? AND cycle_run_id = ? AND feed_id = ?
                   AND outcome IS NULL
              )`,
        )
        .bind(
          attempt.attemptId,
          leaseExpiresAt,
          feed.id,
          attempt.attemptId,
          start,
          attempt.attemptId,
          attempt.attemptId,
          attempt.cycleRunId,
          feed.id,
        ),
      dbBinding
        .prepare(
          `SELECT cycle_run_id, feed_id, outcome, new_items, error_class,
                  diagnostic, ownership_fence
             FROM feed_poll_attempts WHERE id = ?`,
        )
        .bind(attempt.attemptId),
      dbBinding
        .prepare(
          `SELECT feed_url, title, html_url, etag, last_modified,
                  last_successful_poll_at, last_new_item_discovered_at,
                  initial_backload_completed_at, next_poll_at,
                  consecutive_errors, check_interval_minutes,
                  deactivated_at, poll_owner_attempt_id,
                  poll_lease_expires_at, poll_fence
             FROM feeds WHERE id = ?`,
        )
        .bind(feed.id),
    ]);
    const durableAttempt = claimResults[6].results[0] as
      | {
          cycle_run_id: string;
          feed_id: string;
          outcome: FeedAttemptOutcome | null;
          new_items: number;
          error_class: FeedAttemptErrorClass | null;
          diagnostic: string | null;
          ownership_fence: number | null;
        }
      | undefined;
    const currentFeed = claimResults[7].results[0] as
      | {
          feed_url: string;
          title: string | null;
          html_url: string | null;
          etag: string | null;
          last_modified: string | null;
          last_successful_poll_at: number | null;
          last_new_item_discovered_at: number | null;
          initial_backload_completed_at: number | null;
          next_poll_at: number | null;
          consecutive_errors: number;
          check_interval_minutes: number;
          deactivated_at: number | null;
          poll_owner_attempt_id: string | null;
          poll_lease_expires_at: number | null;
          poll_fence: number;
        }
      | undefined;
    if (
      durableAttempt?.cycle_run_id !== attempt.cycleRunId ||
      durableAttempt.feed_id !== feed.id
    ) {
      throw new Error(
        `Logical attempt ${attempt.attemptId} has conflicting identity`,
      );
    }
    if (durableAttempt.outcome != null) {
      return resultFromAttempt(feed.id, feedTitle, {
        outcome: durableAttempt.outcome,
        newItems: durableAttempt.new_items,
        errorClass: durableAttempt.error_class,
        diagnostic: durableAttempt.diagnostic,
      });
    }

    const ownershipFence = durableAttempt.ownership_fence;
    if (
      ownershipFence == null ||
      currentFeed?.poll_owner_attempt_id !== attempt.attemptId ||
      currentFeed.poll_fence !== ownershipFence
    ) {
      await skipAttempt(
        attempt.attemptId,
        currentFeed?.deactivated_at != null
          ? "Feed became ineligible after selection"
          : "Feed is owned by another Cycle Run",
      );
      return loadResult(attempt.attemptId, feed.id, feedTitle);
    }

    // Selection can wait behind another Cycle Run. Once this attempt owns the
    // Feed, policy calculations must use the latest committed Feed state.
    feed = {
      id: feed.id,
      feedUrl: currentFeed.feed_url,
      title: currentFeed.title,
      htmlUrl: currentFeed.html_url,
      etag: currentFeed.etag,
      lastModified: currentFeed.last_modified,
      lastSuccessfulPollAt: currentFeed.last_successful_poll_at,
      lastNewItemDiscoveredAt: currentFeed.last_new_item_discovered_at,
      initialBackloadCompletedAt: currentFeed.initial_backload_completed_at,
      nextPollAt: currentFeed.next_poll_at,
      consecutiveErrors: currentFeed.consecutive_errors,
      checkIntervalMinutes: currentFeed.check_interval_minutes,
    };
    feedTitle = feed.title ?? feed.feedUrl;

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
      const won = await commitFailure(feed, attempt.attemptId, ownershipFence, {
        diagnostic: errorMessage,
        healthClass: "transient",
        errorClass: "network",
        httpStatus: null,
        parserStatus: "not_attempted",
      });
      const result = await loadResult(attempt.attemptId, feed.id, feedTitle);
      if (won && result.outcome === "failed") {
        publish({
          kind: "feedFetchFailed",
          feedId: feed.id,
          error: result.error,
        });
      }
      return result;
    }

    if (response.status === 304) {
      const newInterval = Math.min(
        feed.checkIntervalMinutes * BACKOFF_MULTIPLIER,
        MAX_INTERVAL_MINUTES,
      );
      const completedAt = now();
      const commitResults = await dbBinding.batch([
        dbBinding
          .prepare(
            `UPDATE feeds
                SET last_successful_poll_at = ?, check_interval_minutes = ?,
                    next_poll_at = ?
              WHERE id = ? AND poll_owner_attempt_id = ? AND poll_fence = ?
                AND poll_lease_expires_at > ?
                AND EXISTS (
                  SELECT 1 FROM feed_poll_attempts
                   WHERE id = ? AND outcome IS NULL AND ownership_fence = ?
                )`,
          )
          .bind(
            completedAt,
            newInterval,
            completedAt + newInterval * 60_000,
            feed.id,
            attempt.attemptId,
            ownershipFence,
            completedAt,
            attempt.attemptId,
            ownershipFence,
          ),
        terminalAttemptStatement(
          attempt.attemptId,
          ownershipFence,
          completedAt,
          {
            outcome: "not_modified",
            httpStatus: 304,
            parserStatus: "not_attempted",
          },
        ),
      ]);
      const won = didCommitTerminalAttempt(commitResults);
      const result = await loadResult(attempt.attemptId, feed.id, feedTitle);
      if (won && result.outcome === "not_modified") {
        publish({
          kind: "feedNotModified",
          feedId: feed.id,
          newInterval,
        });
      }
      return result;
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
      const completedAt = now();
      const commitResults = await dbBinding.batch([
        dbBinding
          .prepare(
            `UPDATE feeds
                SET check_interval_minutes = ?, last_error = ?, next_poll_at = ?
              WHERE id = ? AND poll_owner_attempt_id = ? AND poll_fence = ?
                AND poll_lease_expires_at > ?
                AND EXISTS (
                  SELECT 1 FROM feed_poll_attempts
                   WHERE id = ? AND outcome IS NULL AND ownership_fence = ?
                )`,
          )
          .bind(
            backoffMinutes,
            errorMessage,
            completedAt + backoffMinutes * 60_000,
            feed.id,
            attempt.attemptId,
            ownershipFence,
            completedAt,
            attempt.attemptId,
            ownershipFence,
          ),
        terminalAttemptStatement(
          attempt.attemptId,
          ownershipFence,
          completedAt,
          {
            outcome: "rate_limited",
            httpStatus: 429,
            parserStatus: "not_attempted",
            diagnostic: errorMessage,
          },
        ),
      ]);
      const won = didCommitTerminalAttempt(commitResults);
      const result = await loadResult(attempt.attemptId, feed.id, feedTitle);
      if (won && result.outcome === "rate_limited") {
        publish({
          kind: "feedRateLimited",
          feedId: feed.id,
          backoffMinutes,
        });
      }
      return result;
    }

    if (!response.ok) {
      const isPermanent = PERMANENT_ERROR_STATUSES.has(response.status);
      const errorClass: ErrorClass = isPermanent ? "permanent" : "transient";
      const errorMessage = `HTTP ${response.status}${isPermanent ? " (permanent)" : ""}`;
      const won = await commitFailure(feed, attempt.attemptId, ownershipFence, {
        diagnostic: errorMessage,
        healthClass: errorClass,
        errorClass: "http",
        httpStatus: response.status,
        parserStatus: "not_attempted",
      });
      const result = await loadResult(attempt.attemptId, feed.id, feedTitle);
      if (won && result.outcome === "failed") {
        publish({
          kind: "feedFetchFailed",
          feedId: feed.id,
          status: response.status,
          error: result.error,
        });
      }
      return result;
    }

    let xml: string;
    try {
      xml = await response.text();
    } catch (err) {
      const errorMessage = safeDiagnostic(
        err instanceof Error ? err.message : String(err),
      );
      const won = await commitFailure(feed, attempt.attemptId, ownershipFence, {
        diagnostic: errorMessage,
        healthClass: "transient",
        errorClass: "network",
        httpStatus: response.status,
        parserStatus: "not_attempted",
      });
      const result = await loadResult(attempt.attemptId, feed.id, feedTitle);
      if (won && result.outcome === "failed") {
        publish({
          kind: "feedFetchFailed",
          feedId: feed.id,
          status: response.status,
          error: result.error,
        });
      }
      return result;
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
        const won = await commitFailure(
          feed,
          attempt.attemptId,
          ownershipFence,
          {
            diagnostic: parserError,
            healthClass: "transient",
            errorClass: "parse",
            httpStatus: response.status,
            parserStatus: "failure",
          },
        );
        const result = await loadResult(attempt.attemptId, feed.id, feedTitle);
        if (won && result.outcome === "failed") {
          publish({
            kind: "feedParseFailed",
            feedId: feed.id,
            error: result.error,
          });
        }
        return result;
      }
    }

    const newEtag = response.headers.get("ETag");
    const newLastModified = response.headers.get("Last-Modified");
    const time = now();

    const itemRows: ItemCommitRow[] = (
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

    // A completed initial backload gates later inserts to a moving 24-hour
    // window, even when the first successful parse contained no Items.
    const BACKLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
    const backloadAnchor =
      feed.lastNewItemDiscoveredAt ?? feed.initialBackloadCompletedAt;
    const toInsert =
      feed.initialBackloadCompletedAt != null && backloadAnchor != null
        ? itemRows.filter(
            (row) => row.publishedAt >= backloadAnchor - BACKLOAD_WINDOW_MS,
          )
        : itemRows;

    const feedTtlMinutes = parsed.ttl
      ? Math.min(Math.round(Number(parsed.ttl)), MAX_TTL_MINUTES)
      : 0;
    const newItemsInterval = Math.max(MIN_INTERVAL_MINUTES, feedTtlMinutes);
    const unchangedInterval = Math.max(
      Math.min(
        feed.checkIntervalMinutes * BACKOFF_MULTIPLIER,
        MAX_INTERVAL_MINUTES,
      ),
      feedTtlMinutes,
    );
    const completedAt = now();
    const itemJsonChunks = chunkItemRows(toInsert);
    const commitStatements = itemJsonChunks.map((itemJson) =>
      dbBinding
        .prepare(
          `INSERT INTO items
            (id, feed_id, title, url, content, author, published_at, fetched_at,
             first_ingestion_attempt_id)
           SELECT json_extract(value, '$.id'),
                  json_extract(value, '$.feedId'),
                  json_extract(value, '$.title'),
                  json_extract(value, '$.url'),
                  json_extract(value, '$.content'),
                  json_extract(value, '$.author'),
                  json_extract(value, '$.publishedAt'),
                  json_extract(value, '$.fetchedAt'),
                  ?
             FROM json_each(?)
            WHERE EXISTS (
              SELECT 1
                FROM feed_poll_attempts owned_attempt
                JOIN feeds owned_feed ON owned_feed.id = owned_attempt.feed_id
               WHERE owned_attempt.id = ? AND owned_attempt.outcome IS NULL
                 AND owned_attempt.ownership_fence = ?
                 AND owned_feed.poll_owner_attempt_id = owned_attempt.id
                 AND owned_feed.poll_fence = ?
                 AND owned_feed.poll_lease_expires_at > ?
            )
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          attempt.attemptId,
          itemJson,
          attempt.attemptId,
          ownershipFence,
          ownershipFence,
          completedAt,
        ),
    );
    commitStatements.push(
      dbBinding
        .prepare(
          `UPDATE feeds
              SET last_successful_poll_at = ?,
                  initial_backload_completed_at = coalesce(initial_backload_completed_at, ?),
                  consecutive_errors = 0,
                  last_error = NULL,
                  check_interval_minutes = CASE WHEN EXISTS (
                    SELECT 1 FROM items WHERE first_ingestion_attempt_id = ?
                  ) THEN ? ELSE ? END,
                  last_new_item_discovered_at = CASE WHEN EXISTS (
                    SELECT 1 FROM items WHERE first_ingestion_attempt_id = ?
                  ) THEN ? ELSE last_new_item_discovered_at END,
                  next_poll_at = ? + 60000 * CASE WHEN EXISTS (
                    SELECT 1 FROM items WHERE first_ingestion_attempt_id = ?
                  ) THEN ? ELSE ? END,
                  title = coalesce(title, ?),
                  html_url = coalesce(html_url, ?),
                  etag = coalesce(?, etag),
                  last_modified = coalesce(?, last_modified)
            WHERE id = ? AND poll_owner_attempt_id = ? AND poll_fence = ?
              AND poll_lease_expires_at > ?
              AND EXISTS (
                SELECT 1 FROM feed_poll_attempts
                 WHERE id = ? AND outcome IS NULL AND ownership_fence = ?
              )`,
        )
        .bind(
          completedAt,
          completedAt,
          attempt.attemptId,
          newItemsInterval,
          unchangedInterval,
          attempt.attemptId,
          completedAt,
          completedAt,
          attempt.attemptId,
          newItemsInterval,
          unchangedInterval,
          parsed.title ?? null,
          parsed.link ?? null,
          newEtag,
          newLastModified,
          feed.id,
          attempt.attemptId,
          ownershipFence,
          completedAt,
          attempt.attemptId,
          ownershipFence,
        ),
      dbBinding
        .prepare(
          `UPDATE feed_poll_attempts
              SET completed_at = ?,
                  outcome = CASE WHEN EXISTS (
                    SELECT 1 FROM items WHERE first_ingestion_attempt_id = ?
                  ) THEN 'new_items' ELSE 'unchanged' END,
                  new_items = (
                    SELECT count(*) FROM items
                     WHERE first_ingestion_attempt_id = ?
                  ),
                  http_status = ?, parser_status = ?
            WHERE id = ? AND outcome IS NULL AND ownership_fence = ?
              AND EXISTS (
                SELECT 1 FROM feeds
                 WHERE id = feed_id AND poll_owner_attempt_id = ?
                   AND poll_fence = ? AND poll_lease_expires_at > ?
              )`,
        )
        .bind(
          completedAt,
          attempt.attemptId,
          attempt.attemptId,
          response.status,
          parseStatus,
          attempt.attemptId,
          ownershipFence,
          attempt.attemptId,
          ownershipFence,
          completedAt,
        ),
    );
    const commitResults = await dbBinding.batch(commitStatements);
    const won = didCommitTerminalAttempt(commitResults);

    const committed = await loadAttempt(attempt.attemptId);
    const result = resultFromAttempt(feed.id, feedTitle, committed);
    if (
      won &&
      (result.outcome === "new_items" || result.outcome === "unchanged")
    ) {
      publish({
        kind: "feedPolled",
        feedId: feed.id,
        newItems: result.newItems,
        durationMs: now() - start,
        parseStatus,
      });
    }
    return result;
  }

  /** Records a selected Feed that this attempt cannot poll. */
  async function skipAttempt(
    attemptId: string,
    diagnostic: string,
  ): Promise<void> {
    await dbBinding
      .prepare(
        `UPDATE feed_poll_attempts
            SET completed_at = ?, outcome = 'skipped',
                parser_status = 'not_attempted', diagnostic = ?
          WHERE id = ? AND outcome IS NULL AND ownership_fence IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM feeds
               WHERE poll_owner_attempt_id = feed_poll_attempts.id
            )`,
      )
      .bind(now(), diagnostic, attemptId)
      .run();
  }

  /** Reads the terminal result after a commit, including after an ambiguous response. */
  async function loadAttempt(attemptId: string): Promise<{
    outcome: FeedAttemptOutcome;
    newItems: number;
    errorClass: FeedAttemptErrorClass | null;
    diagnostic: string | null;
  }> {
    const rows = await d
      .select({
        outcome: feedPollAttempts.outcome,
        newItems: feedPollAttempts.newItems,
        errorClass: feedPollAttempts.errorClass,
        diagnostic: feedPollAttempts.diagnostic,
      })
      .from(feedPollAttempts)
      .where(eq(feedPollAttempts.id, attemptId));
    if (rows[0]?.outcome == null) {
      throw new Error(
        `Logical attempt ${attemptId} did not complete because it lost ownership`,
      );
    }
    return { ...rows[0], outcome: rows[0].outcome };
  }

  /** Returns the winner when overlapping runtime retries race to completion. */
  async function loadResult(
    attemptId: string,
    feedId: string,
    feedTitle: string,
  ): Promise<FeedPollResult> {
    return resultFromAttempt(feedId, feedTitle, await loadAttempt(attemptId));
  }

  /** Commits Feed error health and its failed attempt in one D1 transaction. */
  async function commitFailure(
    feed: FeedToCheck,
    attemptId: string,
    ownershipFence: number,
    failure: {
      diagnostic: string;
      healthClass: ErrorClass;
      errorClass: FeedAttemptErrorClass;
      httpStatus: number | null;
      parserStatus: "not_attempted" | "failure";
    },
  ): Promise<boolean> {
    const threshold =
      failure.healthClass === "permanent"
        ? PERMANENT_ERROR_THRESHOLD
        : TRANSIENT_ERROR_THRESHOLD;
    const nextErrorCount = feed.consecutiveErrors + 1;
    const completedAt = now();
    const commitResults = await dbBinding.batch([
      dbBinding
        .prepare(
          `UPDATE feeds
              SET consecutive_errors = ?, last_error = ?, next_poll_at = ?,
                  deactivated_at = CASE WHEN ? >= ? THEN ? ELSE deactivated_at END,
                  deactivation_reason = CASE WHEN ? >= ? THEN ? ELSE deactivation_reason END
            WHERE id = ? AND poll_owner_attempt_id = ? AND poll_fence = ?
              AND poll_lease_expires_at > ?
              AND EXISTS (
                SELECT 1 FROM feed_poll_attempts
                 WHERE id = ? AND outcome IS NULL AND ownership_fence = ?
              )`,
        )
        .bind(
          nextErrorCount,
          failure.diagnostic,
          completedAt + feed.checkIntervalMinutes * 60_000,
          nextErrorCount,
          threshold,
          completedAt,
          nextErrorCount,
          threshold,
          failure.healthClass === "permanent"
            ? "automatic_permanent"
            : "automatic_transient",
          feed.id,
          attemptId,
          ownershipFence,
          completedAt,
          attemptId,
          ownershipFence,
        ),
      terminalAttemptStatement(attemptId, ownershipFence, completedAt, {
        outcome: "failed",
        errorClass: failure.errorClass,
        httpStatus: failure.httpStatus,
        parserStatus: failure.parserStatus,
        diagnostic: failure.diagnostic,
      }),
    ]);
    const won = didCommitTerminalAttempt(commitResults);
    if (won && nextErrorCount >= threshold) {
      publish({
        kind: "feedDeactivated",
        feedId: feed.id,
        consecutiveErrors: nextErrorCount,
      });
    }
    return won;
  }

  /** Creates the guarded terminal write shared by non-ingestion outcomes. */
  function terminalAttemptStatement(
    attemptId: string,
    ownershipFence: number,
    completedAt: number,
    values: {
      outcome: "not_modified" | "rate_limited" | "failed";
      errorClass?: FeedAttemptErrorClass;
      httpStatus?: number | null;
      parserStatus: "not_attempted" | "failure";
      diagnostic?: string;
    },
  ): D1PreparedStatement {
    return dbBinding
      .prepare(
        `UPDATE feed_poll_attempts
            SET completed_at = ?, outcome = ?, error_class = ?, http_status = ?,
                parser_status = ?, diagnostic = ?
          WHERE id = ? AND outcome IS NULL AND ownership_fence = ?
            AND EXISTS (
              SELECT 1 FROM feeds
               WHERE id = feed_id AND poll_owner_attempt_id = ?
                 AND poll_fence = ? AND poll_lease_expires_at > ?
            )`,
      )
      .bind(
        completedAt,
        values.outcome,
        values.errorClass ?? null,
        values.httpStatus ?? null,
        values.parserStatus,
        values.diagnostic ?? null,
        attemptId,
        ownershipFence,
        attemptId,
        ownershipFence,
        completedAt,
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
}

/** Reports whether this runtime retry performed the terminal guarded write. */
function didCommitTerminalAttempt(results: D1Result[]): boolean {
  return (results[results.length - 1]?.meta.changes ?? 0) > 0;
}

/** Packs Item rows below D1's 2 MB bound-value limit for one atomic batch. */
function chunkItemRows(rows: ItemCommitRow[]): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 2;

  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const rowBytes = encoder.encode(serialized).length;
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (
      current.length > 0 &&
      currentBytes + separatorBytes + rowBytes > MAX_D1_JSON_PARAMETER_BYTES
    ) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      currentBytes = 2;
    }
    current.push(serialized);
    currentBytes += (current.length === 1 ? 0 : 1) + rowBytes;
  }
  if (current.length > 0) {
    chunks.push(`[${current.join(",")}]`);
  }
  return chunks;
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
