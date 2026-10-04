/**
 * Feed attempt history — bounded, paginated read projections over the
 * `feed_attempts` evidence table. Scoped to one subscribed feed; the
 * dashboard handler owns ownership checks before calling in.
 */
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "../lib/db";
import { feedAttempts, items } from "../db/schema";

export const ATTEMPT_RETENTION_DAYS = 90;
export const PROBLEM_WINDOW_DAYS = 30;
// Rows scanned when deriving streaks — a streak reaching this bound and
// finding older rows is reported as a lower bound, not an exact count.
const STREAK_SCAN_LIMIT = 500;

export type AttemptCursor = { startedAt: number; id: string };

export function encodeCursor(c: AttemptCursor): string {
  return Buffer.from(`${c.startedAt}:${c.id}`).toString("base64url");
}

export function decodeCursor(raw: string): AttemptCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep <= 0) return null;
  const startedAt = Number(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!Number.isFinite(startedAt) || id.length === 0) return null;
  return { startedAt, id };
}

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

export type AttemptRow = typeof feedAttempts.$inferSelect;

export function createFeedHistory(dbBinding: D1Database): FeedHistory {
  const d = getDb(dbBinding);

  return {
    async listAttempts(feedId, cursor, limit) {
      const rows = await d
        .select()
        .from(feedAttempts)
        .where(
          and(
            eq(feedAttempts.feedId, feedId),
            cursor
              ? or(
                  lt(feedAttempts.startedAt, cursor.startedAt),
                  and(
                    eq(feedAttempts.startedAt, cursor.startedAt),
                    lt(feedAttempts.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(feedAttempts.startedAt), desc(feedAttempts.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        rows: page,
        nextCursor:
          hasMore && last ? { startedAt: last.startedAt, id: last.id } : null,
      };
    },

    async attemptItems(attemptIds) {
      if (attemptIds.length === 0) return new Map();
      const rows = await d
        .select({
          attemptId: items.attemptId,
          id: items.id,
          title: items.title,
          url: items.url,
        })
        .from(items)
        .where(inArray(items.attemptId, attemptIds));
      const map = new Map<
        string,
        { id: string; title: string | null; url: string | null }[]
      >();
      for (const r of rows) {
        if (r.attemptId == null) continue;
        const list = map.get(r.attemptId) ?? [];
        list.push({ id: r.id, title: r.title, url: r.url });
        map.set(r.attemptId, list);
      }
      return map;
    },

    async streaks(feedId) {
      // Terminal checked attempts only: skipped and in-progress rows
      // never extend or break a streak.
      const rows = await d
        .select({ status: feedAttempts.status })
        .from(feedAttempts)
        .where(
          and(
            eq(feedAttempts.feedId, feedId),
            sql`${feedAttempts.status} is not null`,
            sql`${feedAttempts.status} != 'skipped'`,
          ),
        )
        .orderBy(desc(feedAttempts.startedAt), desc(feedAttempts.id))
        .limit(STREAK_SCAN_LIMIT + 1);

      const scanned = rows.slice(0, STREAK_SCAN_LIMIT);
      const hasOlder = rows.length > STREAK_SCAN_LIMIT;

      let problem = 0;
      for (const r of scanned) {
        if (r.status === "error") problem++;
        else break;
      }
      let rateLimited = 0;
      for (const r of scanned) {
        if (r.status === "rate_limited") rateLimited++;
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
      const rows = await d
        .select({
          kind: feedAttempts.errorKind,
          count: sql<number>`count(*)`,
          lastAt: sql<number>`max(${feedAttempts.startedAt})`,
        })
        .from(feedAttempts)
        .where(
          and(
            eq(feedAttempts.feedId, feedId),
            eq(feedAttempts.status, "error"),
            gte(feedAttempts.startedAt, since),
          ),
        )
        .groupBy(feedAttempts.errorKind);

      // Most recent message per kind for context — bounded by the same window.
      const out = [];
      for (const r of rows) {
        const latest = await d
          .select({ errorMessage: feedAttempts.errorMessage })
          .from(feedAttempts)
          .where(
            and(
              eq(feedAttempts.feedId, feedId),
              eq(feedAttempts.status, "error"),
              r.kind == null
                ? sql`${feedAttempts.errorKind} is null`
                : eq(feedAttempts.errorKind, r.kind),
              gte(feedAttempts.startedAt, since),
            ),
          )
          .orderBy(desc(feedAttempts.startedAt), desc(feedAttempts.id))
          .limit(1);
        out.push({
          kind: r.kind ?? "unknown",
          count: Number(r.count),
          lastAt: Number(r.lastAt),
          lastMessage: latest[0]?.errorMessage ?? null,
        });
      }
      return out;
    },

    async countAttempts(feedId) {
      const rows = await d
        .select({ count: sql<number>`count(*)` })
        .from(feedAttempts)
        .where(eq(feedAttempts.feedId, feedId));
      return Number(rows[0]?.count ?? 0);
    },
  };
}
