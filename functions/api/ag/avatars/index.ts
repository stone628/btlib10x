import { canonicalAvatar, isUnitSlug, parseMulUrl } from "../../../../web/avatar/avatar.gallery";
import { ipHash, optionalVoter, requireVoter } from "../_lib/auth";
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
 */
export const onRequestGet: Handler = ({ request, env }) =>
  guard(async () => {
    const params = new URL(request.url).searchParams;
    const sort: Sort = params.get("sort") === "new" ? "new" : "top";
    const unit = params.get("unit");
    if (unit !== null && unit !== NO_UNIT && !isUnitSlug(unit)) return fail(400, "bad_unit");
    const mine = params.get("mine") === "1";
    const page = await listEntries(env.DB, {
      sort,
      unit,
      mine,
      cursor: params.get("cursor"),
      limit: config(env).pageSize,
      voter: mine ? await requireVoter(env, request) : await optionalVoter(env, request),
    });
    return json(page);
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
    const ins = await env.DB.prepare(
      "INSERT INTO ag_avatars (q, unit, owner, hidden, created) VALUES (?, ?, ?, ?, ?) " +
        // Either unique index (linked or unlinked) can conflict.
        "ON CONFLICT DO NOTHING",
    )
      .bind(q, slug, voter, cfg.autoPublish ? 0 : 1, nowSeconds())
      .run();
    if (ins.meta.changes === 0) {
      // Lost a race with an identical submission.
      const row = await env.DB.prepare("SELECT id FROM ag_avatars WHERE q = ? AND unit IS ?")
        .bind(q, slug)
        .first<{ id: number }>();
      return json({ id: row?.id ?? null, existing: true }, 200);
    }
    const id = ins.meta.last_row_id;
    const entry = await getEntry(env.DB, id, voter);
    return json({ id, existing: false, pending: !cfg.autoPublish, entry }, 201);
  });
