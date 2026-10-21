import type { Ctx, D1Database, D1PreparedStatement, EdgeCache } from "./cf";
import { json } from "./http";

/**
 * Caching for the gallery's public reads (docs/GALLERY.md §3a).
 *
 * The public GET routes (`/avatars` lists, `/avatars/:id`, `/units`) return
 * the same bytes to every visitor: nothing in them depends on who asks (the
 * per-visitor "liked" / "yours" marks come from `GET /api/ag/me`, which is
 * never cached). That lets one copy serve everyone, in two layers:
 *
 * 1. Edge: the Workers Cache API (`caches.default`) of the data center that
 *    handles the request. A hit skips the route's D1 queries; the Function
 *    itself still runs (Pages always invokes it), so this saves D1 reads and
 *    latency, not Function requests.
 * 2. Browser: the response carries `cache-control: no-cache` and a weak
 *    ETag. The browser keeps the body but asks every time; when nothing has
 *    changed the answer is a body-less `304`, decided before the cache or the
 *    query is touched.
 *
 * Invalidation is by version, not by purge. `ag_meta.version` is a counter
 * that every write changing public data bumps in the same D1 batch
 * (`bumpVersion`). The version is part of both the edge cache key and the
 * ETag, so after a bump the old copies are simply never asked for again, in
 * every data center at once (a Cache API `delete` would only clear the one
 * data center that ran the write). Stale copies age out by `EDGE_TTL`.
 *
 * Each cached read therefore costs one indexed single-row D1 read (the
 * version) instead of the route's own queries. A new submission, a like, a
 * report, a delete or any admin action shows up on the very next request.
 *
 * Ordering rule that keeps this correct: read the version *before* the data,
 * and bump it *with or after* the data change. A reader that races a write
 * then either stores fresh data under the old version (harmless: it is
 * newer than the key promises) or reads the new version and fresh data.
 * It can never store old data under the new version.
 */

/**
 * Bump when the shape of a cached response changes (a new field, a renamed
 * one). Deploys do not clear the edge cache, so without this an old copy
 * could be served to new page code until the version moves for another
 * reason.
 */
export const CACHE_SCHEMA = 2;

/**
 * How long the edge keeps a copy, in seconds. Copies never go stale while
 * their version is current, so this only bounds two things: how long
 * superseded copies occupy the cache, and how long a change made outside the
 * API (a manual `wrangler d1 execute`, which does not bump the version) can
 * stay hidden. Run `bumpVersion`'s SQL by hand after such an edit to show it
 * at once.
 */
export const EDGE_TTL = 3600;

/** The `ag_meta` row that holds the version (migrations/ag/0002_cache_version.sql). */
const VERSION_KEY = "version";

/**
 * Statement that bumps the version. Put it in the same `db.batch` as the
 * write, or run it right after, so the change and the new version land
 * together (see the ordering rule above). The upsert also creates the row if
 * the migration's seed row is missing.
 */
export function bumpVersion(db: D1Database): D1PreparedStatement {
  return db
    .prepare("INSERT INTO ag_meta (k, v) VALUES (?1, 1) ON CONFLICT (k) DO UPDATE SET v = v + 1")
    .bind(VERSION_KEY);
}

/**
 * The current version, or null when it cannot be read (most likely
 * `0002_cache_version.sql` not applied yet). Null turns caching off for the
 * request instead of failing it, so reads keep working while the migration
 * is pending. Writes do fail until then, because their batches include
 * `bumpVersion`.
 */
export async function galleryVersion(db: D1Database): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT v FROM ag_meta WHERE k = ?")
      .bind(VERSION_KEY)
      .first<{ v: number }>();
    return row?.v ?? 0;
  } catch (e) {
    console.error("ag: cache version unreadable, serving uncached", e);
    return null;
  }
}

/**
 * `caches.default` when the runtime has it. Workers and Pages Functions do;
 * Node (the tests, unless they install a fake) does not, and then every read
 * goes straight to D1.
 */
function edgeCache(): EdgeCache | null {
  const g = globalThis as unknown as { caches?: { default?: EdgeCache } };
  return g.caches?.default ?? null;
}

/** The headers `json()` (_lib/http.ts) sends, minus its `no-store`. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

/** Headers the browser gets: keep the body, but revalidate it on every use. */
const BROWSER_CACHE_CONTROL = "public, no-cache";

/** 32-bit FNV-1a of `text`, in base 36: a short, stable tag, not a security hash. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Whether an If-None-Match header lists `etag` (or `*`). */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  // A list of entity tags; weak comparison, so `W/"x"` and `"x"` both match.
  const bare = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t.replace(/^W\//, "") === bare);
}

export interface CachedRead {
  /**
   * What identifies this response: the route plus only the parameters that
   * change its body, in a fixed order (e.g. `avatars?sort=top&unit=&cursor=`).
   * Built by the route from parsed, validated values, never from the raw
   * URL, so junk query parameters (`?x=1`, `?x=2`, …) cannot fill the cache
   * with copies or force a D1 query each.
   */
  key: string;
  /** Builds the JSON body on a miss. Thrown HttpErrors pass through uncached. */
  build: () => Promise<unknown>;
}

/**
 * Answer a public GET from the browser's copy (304), the edge cache, or
 * `build()`, in that order; on a miss, store the result at the edge without
 * delaying the response.
 */
export async function cachedJson(
  ctx: Pick<Ctx, "request" | "env" | "waitUntil">,
  read: CachedRead,
): Promise<Response> {
  const version = await galleryVersion(ctx.env.DB);
  if (version === null) return json(await read.build());

  // The ETag holds what can change one URL's body: the response shape, the
  // data version, and a hash of the cache key, which covers inputs that are
  // not in the URL (the page size, set by PAGE_SIZE).
  const etag = `W/"ag${CACHE_SCHEMA}.${version}.${fnv1a(read.key)}"`;
  const revalidate = { "cache-control": BROWSER_CACHE_CONTROL, etag };

  // 1. The browser already has this version: nothing to send.
  if (etagMatches(ctx.request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: revalidate });
  }

  // 2. The edge copy for this version. The key is a synthetic URL on this
  // site's own host (the Cache API keys by URL; a path under /__ag_cache/
  // can never collide with a real page). It carries no Authorization or
  // Cookie, so all visitors share it.
  const cache = edgeCache();
  const origin = new URL(ctx.request.url).origin;
  const keyRequest = new Request(`${origin}/__ag_cache/${CACHE_SCHEMA}/${version}/${read.key}`);
  if (cache !== null) {
    const hit = await cache.match(keyRequest).catch(() => undefined);
    if (hit !== undefined) {
      // Copy into a fresh Response: the cached one has immutable headers and
      // the edge's cache-control, which the browser must not see.
      return new Response(hit.body, { status: 200, headers: { ...JSON_HEADERS, ...revalidate } });
    }
  }

  // 3. Miss: query D1. An error thrown here is never stored.
  const body = JSON.stringify(await read.build());
  if (cache !== null) {
    // The edge copy says `s-maxage` so the Cache API keeps it for EDGE_TTL;
    // its ETag and cache-control are replaced on the way out (step 2).
    const stored = new Response(body, {
      headers: { ...JSON_HEADERS, "cache-control": `public, max-age=0, s-maxage=${EDGE_TTL}` },
    });
    // waitUntil: store after the response is sent; a failed put only costs
    // the next request a miss.
    ctx.waitUntil(cache.put(keyRequest, stored).catch(() => {}));
  }
  return new Response(body, { status: 200, headers: { ...JSON_HEADERS, ...revalidate } });
}
