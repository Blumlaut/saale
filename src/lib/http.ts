/**
 * Lightweight JSON API helpers.
 * Eliminates the repeated `fetch → if(!res.ok) → res.json()` pattern across components.
 */

export interface FetchError extends Error {
  status?: number;
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
    throw err;
  }
  return res.json() as Promise<T>;
}

/**
 * POST JSON data to an API endpoint.
 * Shortcut for the most common pattern: POST with JSON body.
 */
export async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * PATCH JSON data to an API endpoint.
 */
export async function patchJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * DELETE an API endpoint.
 */
export async function deleteJson<T = unknown>(url: string): Promise<T> {
  return fetchJson<T>(url, { method: "DELETE" });
}
