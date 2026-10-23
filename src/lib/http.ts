/**
 * Lightweight JSON API helpers.
 * Eliminates the repeated `fetch → if(!res.ok) → res.json()` pattern across components.
 */

export interface FetchError extends Error {
  status?: number;
  /** Machine-readable reason, when the API sends one (e.g. a refusal a retry can override). */
  code?: string;
}

/**
 * Fetch JSON from an API endpoint.
 * Throws on non-2xx responses with the API error message.
 */
export async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = new Error(
      (body.error as string) || `Request failed with status ${res.status}`,
    ) as FetchError;
    err.status = res.status;
    if (typeof body.code === "string") err.code = body.code;
    throw err;
  }
  return res.json() as Promise<T>;
}

/**
 * POST JSON data to an API endpoint.
 * Shortcut for the most common pattern: POST with JSON body.
 * `init` carries request options (e.g. an `AbortSignal`) without rebuilding the call.
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  init?: RequestInit,
): Promise<T> {
  return fetchJson<T>(url, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json", ...init?.headers },
    body: JSON.stringify(body),
  });
}

/**
 * PATCH JSON data to an API endpoint.
 */
export async function patchJson<T = unknown>(
  url: string,
  body: unknown,
  init?: RequestInit,
): Promise<T> {
  return fetchJson<T>(url, {
    ...init,
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...init?.headers },
    body: JSON.stringify(body),
  });
}

/**
 * DELETE an API endpoint.
 */
export async function deleteJson<T = unknown>(url: string, body?: unknown): Promise<T> {
  if (body === undefined) return fetchJson<T>(url, { method: "DELETE" });
  return fetchJson<T>(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * PUT JSON data to an API endpoint.
 */
export async function putJson<T = unknown>(
  url: string,
  body: unknown,
  init?: RequestInit,
): Promise<T> {
  return fetchJson<T>(url, {
    ...init,
    method: "PUT",
    headers: { "Content-Type": "application/json", ...init?.headers },
    body: JSON.stringify(body),
  });
}
