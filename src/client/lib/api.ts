/** Fetch helpers for the same-origin dashboard JSON API. */

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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

  // SAFETY: Dashboard endpoints and callers share the response contracts in dashboard-api.ts.
  return (await res.json()) as T;
}

/** POST JSON to a dashboard endpoint; throws ApiError on non-2xx. */
export async function apiPost<T>(path: string, body?: JsonValue): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  const init: RequestInit = { method: "POST", headers };

  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body);
  }

  const res = await fetch(path, init);

  if (!res.ok) {
    throw new ApiError(res.status, `request failed: ${res.status}`);
  }

  // SAFETY: Dashboard endpoints and callers share the response contracts in dashboard-api.ts.
  return (await res.json()) as T;
}

/** POST a multipart form (file upload) to a dashboard endpoint. */
export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });

  if (!res.ok) {
    throw new ApiError(res.status, `request failed: ${res.status}`);
  }

  // SAFETY: Dashboard endpoints and callers share the response contracts in dashboard-api.ts.
  return (await res.json()) as T;
}

/** DELETE a dashboard resource; throws ApiError on non-2xx. */
export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new ApiError(res.status, `request failed: ${res.status}`);
  }

  // SAFETY: Dashboard endpoints and callers share the response contracts in dashboard-api.ts.
  return (await res.json()) as T;
}
