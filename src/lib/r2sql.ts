// Thin client for the R2 SQL REST API (Cloudflare Iceberg / Data Catalog).
//
// Records are queried from the Parquet/Iceberg table written by the
// METRICS_PIPELINE → rss-reader-metrics-store bucket.
//
// Usage:
//   const result = await queryR2Sql(accountId, "rss-reader-metrics-store", token, sql);
//   for (const row of result.data) { ... }

export interface R2SqlResult {
  data: Record<string, string | number | null>[];
  meta: { name: string; type: string }[];
}

export async function queryR2Sql(
  accountId: string,
  bucketName: string,
  authToken: string,
  sql: string,
): Promise<R2SqlResult> {
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${accountId}/r2-sql/query/${bucketName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    // Table not yet created (no data written yet) — return empty result set
    if (res.status === 404) return { data: [], meta: [] };
    throw new Error(`R2 SQL query failed (${res.status}): ${text}`);
  }

  return res.json<R2SqlResult>();
}
