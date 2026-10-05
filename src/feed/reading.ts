/**
 * Reading module — marked-read metrics behind the dashboard Reading page.
 *
 * `createReadingMetrics(db)` projects current Item State into daily and
 * per-Feed counts. The only timing fact we hold is `item_state.read_at`,
 * the latest server receipt of a mark-read (edit-tag clears it on unread,
 * re-reads replace it), so every count is "read=true with a receipt in the
 * window" scoped to the User's current Subscriptions. Day boundaries are
 * computed here in the display timezone because SQLite has no IANA zones.
 */

export interface ZonedDay {
  /** YYYY-MM-DD in the display timezone. */
  date: string;
  /** Inclusive epoch-ms local midnight. */
  start: number;
  /** Exclusive epoch-ms next local midnight. */
  end: number;
}

export interface ReadingSummary {
  daily: { date: string; count: number }[];
  byFeed: {
    feedId: string;
    title: string | null;
    feedUrl: string;
    deactivated: boolean;
    count: number;
  }[];
  subscriptionCount: number;
  starredCount: number;
}

export interface ReadingMetrics {
  summary(userId: string, days: ZonedDay[]): Promise<ReadingSummary>;
}

/** Wall-clock parts of an instant in `timezone` (24h clock). */
function zonedParts(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** UTC offset of `timezone` at instant `ms` (positive east of UTC). */
function offsetMs(ms: number, timezone: string): number {
  const p = zonedParts(ms, timezone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of local midnight for a YYYY-MM-DD date; the second offset
 *  lookup corrects for days whose offset differs from the UTC-midnight guess
 *  (DST transitions). */
function zonedMidnight(date: string, timezone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, timezone);
  return guess - offsetMs(first, timezone);
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** True when the runtime recognises `timezone` as an IANA zone. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The last `count` calendar days in `timezone`, oldest first, ending with
 * the (partial) day containing `now`. Whole local days keep the daily chart
 * and the window totals on identical boundaries.
 */
export function zonedDays(
  now: number,
  count: number,
  timezone: string,
): ZonedDay[] {
  const p = zonedParts(now, timezone);
  const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const result: ZonedDay[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = shiftDate(today, -i);
    result.push({
      date,
      start: zonedMidnight(date, timezone),
      end: zonedMidnight(shiftDate(date, 1), timezone),
    });
  }
  return result;
}

// Restricts Item State to Items of Feeds the user is subscribed to right
// now (deactivated Feeds included; unsubscribed Feeds and other Users' state
// excluded). Every query that counts reads shares this scope.
const SUBSCRIBED_ITEMS = `
  JOIN items i ON i.id = s.item_id
  JOIN subscriptions sub ON sub.feed_id = i.feed_id AND sub.user_id = s.user_id`;

/** Returns the Reading read model backed by D1. */
export function createReadingMetrics(db: D1Database): ReadingMetrics {
  return {
    /**
     * Daily counts (bucketed by the supplied local-day boundaries, passed as
     * one JSON parameter to stay under D1's bound-parameter limit), per-Feed
     * counts over the same span, plus subscription and starred totals.
     * Raw SQL: json_each day buckets have no Drizzle equivalent.
     */
    async summary(userId, days) {
      const windowStart = days[0].start;
      const windowEnd = days[days.length - 1].end;

      const [dailyRes, feedRes, subRes, starRes] = await db.batch([
        db
          .prepare(
            `WITH days AS (
               SELECT json_extract(value, '$.date') AS date,
                      json_extract(value, '$.start') AS start_ms,
                      json_extract(value, '$.end') AS end_ms
               FROM json_each(?)
             )
             SELECT d.date AS date, count(*) AS count
             FROM days d
             JOIN item_state s ON s.read_at >= d.start_ms AND s.read_at < d.end_ms
             ${SUBSCRIBED_ITEMS}
             WHERE s.user_id = ? AND s.is_read = 1
             GROUP BY d.date`,
          )
          .bind(JSON.stringify(days), userId),
        db
          .prepare(
            `SELECT f.id AS feedId,
                    coalesce(sub.title, f.title) AS title,
                    f.feed_url AS feedUrl,
                    f.deactivated_at IS NOT NULL AS deactivated,
                    count(*) AS count
             FROM item_state s
             ${SUBSCRIBED_ITEMS}
             JOIN feeds f ON f.id = i.feed_id
             WHERE s.user_id = ? AND s.is_read = 1
               AND s.read_at >= ? AND s.read_at < ?
             GROUP BY f.id
             ORDER BY count DESC, title`,
          )
          .bind(userId, windowStart, windowEnd),
        db
          .prepare(
            `SELECT count(*) AS count FROM subscriptions WHERE user_id = ?`,
          )
          .bind(userId),
        db
          .prepare(
            `SELECT count(*) AS count
             FROM item_state s
             ${SUBSCRIBED_ITEMS}
             WHERE s.user_id = ? AND s.is_starred = 1`,
          )
          .bind(userId),
      ]);

      const byDate = new Map(
        (dailyRes.results as { date: string; count: number }[]).map((r) => [
          r.date,
          Number(r.count),
        ]),
      );
      const feedRows = feedRes.results as {
        feedId: string;
        title: string | null;
        feedUrl: string;
        deactivated: number;
        count: number;
      }[];
      return {
        daily: days.map((d) => ({
          date: d.date,
          count: byDate.get(d.date) ?? 0,
        })),
        byFeed: feedRows.map((r) => ({
          feedId: r.feedId,
          title: r.title ?? null,
          feedUrl: r.feedUrl,
          deactivated: Number(r.deactivated) === 1,
          count: Number(r.count),
        })),
        subscriptionCount: Number(
          (subRes.results[0] as { count: number } | undefined)?.count ?? 0,
        ),
        starredCount: Number(
          (starRes.results[0] as { count: number } | undefined)?.count ?? 0,
        ),
      };
    },
  };
}
