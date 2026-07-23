export const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ? String(data.error) : `Request failed (${res.status})`);
  }
  return data;
};

export async function postJson<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ? String(data.error) : `Request failed (${res.status})`);
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
