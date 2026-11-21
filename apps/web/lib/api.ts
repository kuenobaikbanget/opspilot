export class ApiError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api(path: string, method = "GET", payload?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store",
    signal,
  });
  signal?.throwIfAborted();
  if (response.status === 401) {
    window.dispatchEvent(new Event("opspilot-unauthorized"));
    throw new ApiError("Unauthorized", null, 401);
  }
  const data = await response.json();
  if (!response.ok) {
    const code = typeof data?.code === "string" && /^[a-z_]{1,80}$/.test(data.code) ? data.code : null;
    throw new ApiError(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`, code, response.status);
  }
  return data;
}
