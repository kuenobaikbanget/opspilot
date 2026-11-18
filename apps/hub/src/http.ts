export function j(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function readJson(req: Request, allowEmpty: boolean): Promise<unknown> {
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024) {
          await reader.cancel();
          throw new Error("Body too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const raw = new TextDecoder().decode(bytes);
    return JSON.parse(allowEmpty ? raw || "{}" : raw);
  } catch {
    throw new SyntaxError("Invalid JSON body");
  }
}

export const invalid = (error: string, status = 400) => j({ error }, status);

export async function body(req: Request): Promise<any> {
  return readJson(req, true);
}

export function urlUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export const apiError = (error: string, code: string, status = 400) =>
  j({ error, code }, status);

export function aiOrigin(req: Request): Response | null {
  return req.headers.get("origin") === (process.env.ALLOWED_ORIGIN || "http://localhost:3000")
    ? null
    : apiError("Forbidden origin", "forbidden_origin", 403);
}

export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

/** The same bounded parser as existing routes, with strict AI request semantics. */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError("JSON content type required", 415);
  }
  const value: unknown = await readJson(req, false);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError("JSON object required", 400);
  }
  return value as Record<string, unknown>;
}
