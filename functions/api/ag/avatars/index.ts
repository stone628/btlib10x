import { canonicalAvatar, isUnitSlug, parseMulUrl } from "../../../../web/avatar/avatar.gallery";
import { ipHash, requireVoter } from "../_lib/auth";
import { bumpVersion, cachedJson } from "../_lib/cache";
import type { Handler } from "../_lib/cf";
import { config } from "../_lib/config";
import { getEntry, listEntries, NO_UNIT, type Sort } from "../_lib/gallery";
import { fail, guard, HttpError, json, nowSeconds, readJson, str } from "../_lib/http";
import { ensureUnit } from "../_lib/mul";
import { rateLimit } from "../_lib/rate";
import { verifyTurnstile } from "../_lib/turnstile";

/**
 * GET /api/ag/avatars?sort=top|new&unit=<slug>|none&mine=1&cursor=: a page of
 * visible entries; `unit=none` lists the ones tied to no 'Mech, `mine=1` only
 * the requesting key's own (the key is then required).
 *
 * Every list except `mine=1` is public and cached (_lib/cache.ts): the
 * device key, if the page sends one, is ignored, and the visitor's own
 * likes come from `GET /api/ag/me`. `mine=1` depends on the key, so it is
 * answered fresh and `no-store` every time.
 */
export const onRequestGet: Handler = (ctx) =>
  guard(async () => {
    const { request, env } = ctx;
    const params = new URL(request.url).searchParams;
    const sort: Sort = params.get("sort") === "new" ? "new" : "top";
    const unit = params.get("unit");
    if (unit !== null && unit !== NO_UNIT && !isUnitSlug(unit)) return fail(400, "bad_unit");
    const cursor = params.get("cursor");
    const limit = config(env).pageSize;

    if (params.get("mine") === "1") {
      const owner = await requireVoter(env, request);
      return json(await listEntries(env.DB, { sort, unit, owner, cursor, limit }));
    }

    // The cache key names every input that shapes the page, as parsed above
    // (an invalid cursor still throws 400 inside build, uncached). The page
    // size is in it because PAGE_SIZE can change without the data changing.
    const key =
      `avatars?sort=${sort}&unit=${encodeURIComponent(unit ?? "")}` +
      `&cursor=${encodeURIComponent(cursor ?? "")}&n=${limit}`;
    return cachedJson(ctx, {
      key,
      build: () => listEntries(env.DB, { sort, unit, cursor, limit }),
    });
  });

/**
 * POST /api/ag/avatars `{ q, mul?, turnstile }`: submit an avatar. `q` is the
 * creator's avatar query, `mul` the MUL page of the 'Mech it is for; empty or
 * absent means none. The same (avatar, 'Mech) pair, or the same avatar with
 * no 'Mech, submitted again returns the existing entry.
 */
export const onRequestPost: Handler = ({ request, env }) =>
  guard(async () => {
    const cfg = config(env);
    const voter = await requireVoter(env, request);
    const body = await readJson(request);
    const q = canonicalAvatar(str(body, "q").replace(/^\?/, ""));
    if (q === null) throw new HttpError(400, "bad_avatar", "not a valid avatar query");
    const mul = typeof body.mul === "string" ? body.mul.trim() : "";
    const slug = mul === "" ? null : parseMulUrl(mul);
    if (mul !== "" && slug === null) {
      throw new HttpError(400, "bad_mul_url", "not a MUL unit page URL");
    }
    await verifyTurnstile(env, request, str(body, "turnstile"));

    const existing = await env.DB.prepare("SELECT id FROM ag_avatars WHERE q = ? AND unit IS ?")
      .bind(q, slug)
      .first<{ id: number }>();
    if (existing !== null) return json({ id: existing.id, existing: true }, 200);

    await rateLimit(env, "submit", [voter, await ipHash(env, request)], cfg.submitsPerDay);
    if (slug !== null) await ensureUnit(env, slug);
    // The insert and the cache version bump go in one batch, so no reader
    // can see the new version without the new row (_lib/cache.ts). The bump
    // also runs when the insert loses a race (changes 0) or the entry is
    // hidden pending approval; a spare bump costs one cache miss, nothing
    // more.
    const [ins] = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO ag_avatars (q, unit, owner, hidden, created) VALUES (?, ?, ?, ?, ?) " +
          // Either unique index (linked or unlinked) can conflict.
          "ON CONFLICT DO NOTHING",
      ).bind(q, slug, voter, cfg.autoPublish ? 0 : 1, nowSeconds()),
      bumpVersion(env.DB),
    ]);
    if (ins === undefined) throw new HttpError(500, "internal");
    if (ins.meta.changes === 0) {
      // Lost a race with an identical submission.
      const row = await env.DB.prepare("SELECT id FROM ag_avatars WHERE q = ? AND unit IS ?")
        .bind(q, slug)
        .first<{ id: number }>();
      return json({ id: row?.id ?? null, existing: true }, 200);
    }
    const id = ins.meta.last_row_id;
    const entry = await getEntry(env.DB, id);
    return json({ id, existing: false, pending: !cfg.autoPublish, entry }, 201);
  });
