import { optionalVoter } from "./_lib/auth";
import type { Handler } from "./_lib/cf";
import { MAX_MARK_IDS, marksFor } from "./_lib/gallery";
import { guard, HttpError, json } from "./_lib/http";

/**
 * GET /api/ag/me?ids=1,2,3: which of these entries the requesting key liked
 * (`voted`) and submitted (`mine`), as two id lists.
 *
 * This is the personal half of a gallery page. The entries themselves come
 * from the public, cached reads (`/avatars`, `/avatars/:id`), which carry no
 * per-visitor fields so one copy serves everyone (_lib/cache.ts); the page
 * asks this route for the visitor's marks right after each page of entries
 * and paints them in. It is never cached (`json()` sends `no-store`) and
 * costs the key lookup plus one indexed query per page.
 *
 * No key, or one the server does not know, gets two empty lists rather than
 * an error: an anonymous visitor has liked and submitted nothing. A banned
 * key still gets 403 `banned`, as on every keyed route.
 */
export const onRequestGet: Handler = ({ request, env }) =>
  guard(async () => {
    const raw = new URL(request.url).searchParams.get("ids") ?? "";
    const parts = raw === "" ? [] : raw.split(",");
    if (parts.length > MAX_MARK_IDS) throw new HttpError(400, "too_many_ids");
    if (!parts.every((p) => /^[1-9]\d{0,15}$/.test(p))) throw new HttpError(400, "bad_ids");
    const voter = await optionalVoter(env, request);
    if (voter === null) return json({ voted: [], mine: [] });
    return json(await marksFor(env.DB, voter, [...new Set(parts.map(Number))]));
  });
