import Parser from "rss-parser";
import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { deriveItemId } from "../lib/crypto";
import { extractReadableContent } from "../lib/readability";
import { parseFeedLenient } from "../lib/feed-parser-fallback";
import { feeds, items } from "../db/schema";

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
  | { feedId: string; feedTitle: string; status: "ok"; newItems: number }
  | { feedId: string; feedTitle: string; status: "not_modified" }
  | { feedId: string; feedTitle: string; status: "error"; error: string };

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

export interface FeedPoller {
  poll(feed: FeedToCheck): Promise<FeedPollResult>;
}

export function createFeedPoller(
  dbBinding: D1Database,
  transport: FeedTransport,
  observe: PollObserver,
  now: () => number,
): FeedPoller {
  const d = getDb(dbBinding);

  return { poll };

  async function poll(feed: FeedToCheck): Promise<FeedPollResult> {
    const start = now();
    const feedTitle = feed.title ?? feed.feedUrl;

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
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      await recordError(feed, errorMessage, "transient");
      observe.publish({
        kind: "feedFetchFailed",
        feedId: feed.id,
        error: errorMessage,
      });
      return {
        feedId: feed.id,
        feedTitle,
        status: "error",
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
      observe.publish({
        kind: "feedNotModified",
        feedId: feed.id,
        newInterval,
      });
      return { feedId: feed.id, feedTitle, status: "not_modified" };
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
          backoffMinutes = Math.max(
            Math.ceil(seconds / 60),
            backoffMinutes,
          );
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
      observe.publish({
        kind: "feedRateLimited",
        feedId: feed.id,
        backoffMinutes,
      });
      return {
        feedId: feed.id,
        feedTitle,
        status: "error",
        error: errorMessage,
      };
    }

    if (!response.ok) {
      const isPermanent = PERMANENT_ERROR_STATUSES.has(response.status);
      const errorClass: ErrorClass = isPermanent
        ? "permanent"
        : "transient";
      const errorMessage = `HTTP ${response.status}${isPermanent ? " (permanent)" : ""}`;
      await recordError(feed, errorMessage, errorClass);
      observe.publish({
        kind: "feedFetchFailed",
        feedId: feed.id,
        status: response.status,
        error: errorMessage,
      });
      return {
        feedId: feed.id,
        feedTitle,
        status: "error",
        error: errorMessage,
      };
    }

    const xml = await response.text();
    const parser = new Parser({
      customFields: { item: [["content:encoded", "contentEncoded"]] },
    });
    let parsed;
    let parseStatus: "success" | "fallback" = "success";

    try {
      parsed = await parser.parseString(xml);
    } catch (e) {
      const parserError = (e as Error).message;

      const fallback = parseFeedLenient(xml);
      if (fallback && fallback.items.length > 0) {
        parsed = fallback;
        parseStatus = "fallback";
      } else {
        await recordError(feed, parserError, "transient");
        observe.publish({
          kind: "feedParseFailed",
          feedId: feed.id,
          error: parserError,
        });
        return {
          feedId: feed.id,
          feedTitle,
          status: "error",
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
                raw.length > 500
                  ? (extractReadableContent(raw) ?? raw)
                  : raw;
              return trimContent(cleaned, MAX_CONTENT_BYTES);
            })(),
            author: item.creator ?? item.author ?? null,
            publishedAt: item.isoDate
              ? new Date(item.isoDate).getTime()
              : time,
            fetchedAt: time,
          };
        }),
      )
    ).filter((r): r is NonNullable<typeof r> => r !== null);

    let newItems = 0;
    if (itemRows.length > 0) {
      const stmts = itemRows.map((row) =>
        d.insert(items).values(row).onConflictDoNothing(),
      );
      const batchResults = await d.batch(
        stmts as unknown as [any, ...any[]],
      );
      newItems = batchResults.reduce(
        (sum, r) => sum + r.meta.changes,
        0,
      );
    }

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

    await d
      .update(feeds)
      .set({
        title: parsed.title ?? feed.title,
        htmlUrl: parsed.link ?? feed.htmlUrl,
        lastFetchedAt: time,
        consecutiveErrors: 0,
        lastError: null,
        checkIntervalMinutes: newInterval,
        ...(newItems > 0 ? { lastNewItemAt: time } : {}),
        ...(newEtag != null ? { etag: newEtag } : {}),
        ...(newLastModified != null
          ? { lastModified: newLastModified }
          : {}),
      })
      .where(eq(feeds.id, feed.id));

    observe.publish({
      kind: "feedPolled",
      feedId: feed.id,
      newItems,
      durationMs: now() - start,
      parseStatus,
    });

    return { feedId: feed.id, feedTitle, status: "ok", newItems };
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
      observe.publish({
        kind: "feedDeactivated",
        feedId: feed.id,
        consecutiveErrors: next,
      });
    }
  }
}

function trimContent(content: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(content);
  if (encoded.length <= maxBytes) return content;
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}
