/** JSON responses and request parsing for the gallery API. */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

/**
 * An error the client can show. `code` is stable and machine-readable (the
 * page maps it to a localized message); `message` is English detail.
 */
export function fail(status: number, code: string, message = code): Response {
  return json({ error: code, message }, status);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/** Run a handler body, turning thrown HttpErrors into JSON error responses. */
export async function guard(body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    console.error("ag: unhandled error", e);
    return fail(500, "internal", "internal error");
  }
}

const MAX_BODY_BYTES = 4096;

/** The request's JSON object body, capped in size; throws a 400 otherwise. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    throw new HttpError(415, "bad_content_type", "expected application/json");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_json");
  }
  return body as Record<string, unknown>;
}

export function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string") throw new HttpError(400, "missing_field", `missing ${key}`);
  return v;
}

/** A positive integer route param (an entry id), or a 404. */
export function idParam(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (s === undefined || !/^[1-9]\d{0,15}$/.test(s)) throw new HttpError(404, "not_found");
  return Number(s);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
