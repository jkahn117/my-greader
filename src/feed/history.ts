import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { feedPollAttempts, items } from "../db/schema";
import { getDb } from "../lib/db";

export const ATTEMPT_RETENTION_DAYS = 90;
export const PROBLEM_WINDOW_DAYS = 30;
const STREAK_SCAN_LIMIT = 500;

export type AttemptCursor = { startedAt: number; id: string };

export function encodeCursor(cursor: AttemptCursor): string {
  return Buffer.from(`${cursor.startedAt}:${cursor.id}`).toString("base64url");
}

export function decodeCursor(raw: string): AttemptCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  const startedAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isFinite(startedAt) || id.length === 0) return null;
  return { startedAt, id };
}

export type AttemptRow = typeof feedPollAttempts.$inferSelect;

export interface FeedHistory {
  listAttempts(
    feedId: string,
    cursor: AttemptCursor | null,
    limit: number,
  ): Promise<{ rows: AttemptRow[]; nextCursor: AttemptCursor | null }>;
  attemptItems(
    attemptIds: string[],
  ): Promise<
    Map<string, { id: string; title: string | null; url: string | null }[]>
  >;
  streaks(feedId: string): Promise<{
    problem: { count: number; lowerBound: boolean };
    rateLimited: { count: number; lowerBound: boolean };
  }>;
  problemGroups(
    feedId: string,
    now: number,
  ): Promise<
    {
      kind: string;
      count: number;
      lastAt: number;
      lastMessage: string | null;
    }[]
  >;
  countAttempts(feedId: string): Promise<number>;
}

/** Creates bounded dashboard projections over durable Feed Poll Attempts. */
export function createFeedHistory(dbBinding: D1Database): FeedHistory {
  const db = getDb(dbBinding);

  return {
    async listAttempts(feedId, cursor, limit) {
      const rows = await db
        .select()
        .from(feedPollAttempts)
        .where(
          and(
            eq(feedPollAttempts.feedId, feedId),
            cursor
              ? or(
                  lt(feedPollAttempts.startedAt, cursor.startedAt),
                  and(
                    eq(feedPollAttempts.startedAt, cursor.startedAt),
                    lt(feedPollAttempts.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(feedPollAttempts.startedAt), desc(feedPollAttempts.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        rows: page,
        nextCursor:
          hasMore && last ? { startedAt: last.startedAt, id: last.id } : null,
      };
    },

    async attemptItems(attemptIds) {
      if (attemptIds.length === 0) return new Map();
      const rows = await db
        .select({
          attemptId: items.firstIngestionAttemptId,
          id: items.id,
          title: items.title,
          url: items.url,
        })
        .from(items)
        .where(inArray(items.firstIngestionAttemptId, attemptIds));
      const result = new Map<
        string,
        { id: string; title: string | null; url: string | null }[]
      >();
      for (const row of rows) {
        if (row.attemptId === null) continue;
        const attemptItems = result.get(row.attemptId) ?? [];
        attemptItems.push({ id: row.id, title: row.title, url: row.url });
        result.set(row.attemptId, attemptItems);
      }
      return result;
    },

    async streaks(feedId) {
      const rows = await db
        .select({ outcome: feedPollAttempts.outcome })
        .from(feedPollAttempts)
        .where(
          and(
            eq(feedPollAttempts.feedId, feedId),
            sql`${feedPollAttempts.outcome} is not null`,
            sql`${feedPollAttempts.outcome} != 'skipped'`,
          ),
        )
        .orderBy(desc(feedPollAttempts.startedAt), desc(feedPollAttempts.id))
        .limit(STREAK_SCAN_LIMIT + 1);

      const scanned = rows.slice(0, STREAK_SCAN_LIMIT);
      const hasOlder = rows.length > STREAK_SCAN_LIMIT;
      let problem = 0;
      for (const row of scanned) {
        if (row.outcome === "failed") problem++;
        else break;
      }
      let rateLimited = 0;
      for (const row of scanned) {
        if (row.outcome === "rate_limited") rateLimited++;
        else break;
      }
      return {
        problem: {
          count: problem,
          lowerBound: hasOlder && problem === scanned.length,
        },
        rateLimited: {
          count: rateLimited,
          lowerBound: hasOlder && rateLimited === scanned.length,
        },
      };
    },

    async problemGroups(feedId, now) {
      const since = now - PROBLEM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const rows = await db
        .select({
          kind: feedPollAttempts.errorClass,
          count: sql<number>`count(*)`,
          lastAt: sql<number>`max(${feedPollAttempts.startedAt})`,
        })
        .from(feedPollAttempts)
        .where(
          and(
            eq(feedPollAttempts.feedId, feedId),
            eq(feedPollAttempts.outcome, "failed"),
            gte(feedPollAttempts.startedAt, since),
          ),
        )
        .groupBy(feedPollAttempts.errorClass);

      const result = [];
      for (const row of rows) {
        const latest = await db
          .select({ diagnostic: feedPollAttempts.diagnostic })
          .from(feedPollAttempts)
          .where(
            and(
              eq(feedPollAttempts.feedId, feedId),
              eq(feedPollAttempts.outcome, "failed"),
              row.kind === null
                ? sql`${feedPollAttempts.errorClass} is null`
                : eq(feedPollAttempts.errorClass, row.kind),
              gte(feedPollAttempts.startedAt, since),
            ),
          )
          .orderBy(
            desc(feedPollAttempts.startedAt),
            desc(feedPollAttempts.id),
          )
          .limit(1);
        result.push({
          kind: row.kind ?? "unknown",
          count: Number(row.count),
          lastAt: Number(row.lastAt),
          lastMessage: latest[0]?.diagnostic ?? null,
        });
      }
      return result;
    },

    async countAttempts(feedId) {
      const row = await db
        .select({ count: sql<number>`count(*)` })
        .from(feedPollAttempts)
        .where(eq(feedPollAttempts.feedId, feedId))
        .get();
      return Number(row?.count ?? 0);
    },
  };
}
