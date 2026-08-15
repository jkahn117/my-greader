/**
 * Analytics Engine read adapter — owns the physical AE column layout
 * and all SQL construction.  The dashboard handler provides credentials
 * and a feed-title map; the adapter returns typed domain projections.
 *
 * Degrades gracefully: every query returns an empty array when
 * analytics is disabled or AE is unreachable.
 */

export interface FeedVelocityRow {
  feedId: string;
  title: string;
  total30d: number;
  avgPerFetch: number;
}

export interface FetchPerfRow {
  feedId: string;
  title: string;
  samples: number;
  avgMs: number;
  maxMs: number;
}

export interface ErrorRateRow {
  httpStatus: string;
  occurrences: number;
  affectedFeeds: number;
}

export interface ArticleTrendRow {
  day: string;
  newArticles: number;
}

export interface AnalyticsData {
  feedVelocity: FeedVelocityRow[];
  fetchPerf: FetchPerfRow[];
  errorRates: ErrorRateRow[];
  trend30d: ArticleTrendRow[];
}

export interface AnalyticsReader {
  queryAll(
    feedActivity: { feedId: string; title: string }[],
  ): Promise<AnalyticsData>;
}

interface AeSqlResult {
  data: Record<string, string | number | null>[];
  meta: { name: string; type: string }[];
}

export function createAnalyticsReader(params: {
  accountId: string;
  apiToken: string;
  enabled: boolean;
}): AnalyticsReader {
  const { accountId, apiToken, enabled } = params;

  async function query(sql: string): Promise<AeSqlResult> {
    if (!enabled) return { data: [], meta: [] };

    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}` },
        body: sql,
      });
      if (!res.ok) {
        if (res.status === 404) return { data: [], meta: [] };
        throw new Error(
          `AE SQL query failed (${res.status}): ${await res.text().catch(() => res.statusText)}`,
        );
      }
      return res.json<AeSqlResult>();
    } catch {
      return { data: [], meta: [] };
    }
  }

  function resolveTitle(
    feedTitleMap: Map<string, string>,
    feedId: string,
  ): string {
    return feedTitleMap.get(feedId) ?? feedId.slice(0, 8);
  }

  return { queryAll };

  async function queryAll(
    feedActivity: { feedId: string; title: string }[],
  ): Promise<AnalyticsData> {
    const feedTitleMap = new Map(
      feedActivity.map((f) => [f.feedId, f.title]),
    );
    const [velocityRaw, perfRaw, errorRaw, trendRaw] =
      await Promise.all([
        query(
          `SELECT blob5 AS feedId,
                SUM(double1) AS total_new_articles,
                ROUND(AVG(double1), 1) AS avg_per_fetch
         FROM rss_reader_metrics
         WHERE index1 = 'feed_new_articles'
           AND timestamp > NOW() - INTERVAL '30' DAY
         GROUP BY blob5
         ORDER BY total_new_articles DESC
         LIMIT 20`,
        ),
        query(
          `SELECT blob5 AS feedId,
                COUNT(*) AS samples,
                ROUND(AVG(double1)) AS avg_ms,
                ROUND(MAX(double1)) AS max_ms
         FROM rss_reader_metrics
         WHERE index1 = 'feed_parse_duration_ms'
           AND timestamp > NOW() - INTERVAL '7' DAY
         GROUP BY blob5
         ORDER BY avg_ms DESC
         LIMIT 20`,
        ),
        query(
          `SELECT blob6 AS httpStatus,
                COUNT(*) AS occurrences,
                COUNT(DISTINCT blob5) AS affected_feeds
         FROM rss_reader_metrics
         WHERE index1 = 'feed_fetch_error'
           AND timestamp > NOW() - INTERVAL '7' DAY
         GROUP BY blob6
         ORDER BY occurrences DESC`,
        ),
        query(
          `SELECT toStartOfDay(timestamp) AS day,
                SUM(double1) AS new_articles
         FROM rss_reader_metrics
         WHERE index1 = 'feed_new_articles'
           AND timestamp > NOW() - INTERVAL '30' DAY
         GROUP BY day
         ORDER BY day DESC`,
        ),
      ]);

    const feedVelocity: FeedVelocityRow[] = (
      velocityRaw.data ?? []
    ).map((row) => ({
      feedId: String(row.feedId ?? ""),
      title: resolveTitle(feedTitleMap, String(row.feedId ?? "")),
      total30d: Number(row.total_new_articles ?? 0),
      avgPerFetch: Number(row.avg_per_fetch ?? 0),
    }));

    const fetchPerf: FetchPerfRow[] = (perfRaw.data ?? []).map(
      (row) => ({
        feedId: String(row.feedId ?? ""),
        title: resolveTitle(feedTitleMap, String(row.feedId ?? "")),
        samples: Number(row.samples ?? 0),
        avgMs: Number(row.avg_ms ?? 0),
        maxMs: Number(row.max_ms ?? 0),
      }),
    );

    const errorRates: ErrorRateRow[] = (errorRaw.data ?? []).map(
      (row) => ({
        httpStatus: String(row.httpStatus ?? "?"),
        occurrences: Number(row.occurrences ?? 0),
        affectedFeeds: Number(row.affected_feeds ?? 0),
      }),
    );

    const trend30d: ArticleTrendRow[] = (trendRaw.data ?? []).map(
      (row) => ({
        day: String(row.day ?? "").slice(0, 10),
        newArticles: Number(row.new_articles ?? 0),
      }),
    );

    return { feedVelocity, fetchPerf, errorRates, trend30d };
  }
}
