// Thin client for the Workers Analytics Engine SQL API.
//
// Replaces the R2 SQL client — metrics are now written to Analytics Engine
// (fire-and-forget) and queried via the AE SQL HTTP API.
//
// Usage:
//   const result = await queryAeSql(accountId, token, sql);
//   for (const row of result.data) { ... }

export interface AeSqlResult {
  data: Record<string, string | number | null>[];
  meta: { name: string; type: string }[];
}

export async function queryAeSql(
  accountId: string,
  authToken: string,
  sql: string,
): Promise<AeSqlResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    body: sql,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    // No data yet — return empty result set
    if (res.status === 404) return { data: [], meta: [] };
    throw new Error(`AE SQL query failed (${res.status}): ${text}`);
  }

  return res.json<AeSqlResult>();
}
