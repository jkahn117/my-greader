/** Fetch helpers for the same-origin dashboard JSON API. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET a dashboard JSON endpoint; throws ApiError on non-2xx. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new ApiError(res.status, `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}
