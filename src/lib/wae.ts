// Cloudflare Workers Analytics Engine SQL API client.
// WAE write binding is write-only — queries go through the REST API.
// Requires CF_ACCOUNT_ID (var) and CF_API_TOKEN (secret) in env.

export interface WaeRow {
  [key: string]: string | number | null;
}

export interface WaeResult {
  data: WaeRow[];
  meta: { name: string; type: string }[];
}

/**
 * Execute a SQL query against the Workers Analytics Engine SQL API.
 * Returns parsed rows on success, throws on HTTP or API error.
 */
export async function queryWae(
  accountId: string,
  apiToken: string,
  sql: string,
): Promise<WaeResult> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/sql",
    },
    body: sql,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    // 422 means the dataset schema doesn't exist yet (no data written) — treat as empty
    if (res.status === 422) return { data: [], meta: [] };
    throw new Error(`WAE query failed (${res.status}): ${text}`);
  }

  return res.json<WaeResult>();
}
