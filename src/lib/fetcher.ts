export const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ? String(data.error) : `Request failed (${res.status})`);
  }
  return data;
};

// Error that also carries the parsed response body (so callers can read
// fields like `runId` from a 409 conflict).
export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

export async function postJson<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(
      data?.error ? String(data.error) : `Request failed (${res.status})`,
      res.status,
      data
    );
    // Convenience: hoist a runId if present.
    if (typeof data?.runId === "number") (err as unknown as { runId: number }).runId = data.runId;
    throw err;
  }
  return data as T;
}

export async function sendJson<T = unknown>(
  method: "PATCH" | "DELETE" | "PUT",
  url: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ? String(data.error) : `Request failed (${res.status})`);
  return data as T;
}
