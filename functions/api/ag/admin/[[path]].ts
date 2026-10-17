import { isUnitSlug, mulUnitUrl } from "../../../../web/avatar/avatar.gallery";
import { requireAdmin } from "../_lib/access";
import type { Ctx, Handler } from "../_lib/cf";
import { config } from "../_lib/config";
import { type AdminEntry, deleteEntry, recountVotes, unitOf } from "../_lib/gallery";
import { guard, HttpError, idParam, json, readJson } from "../_lib/http";
import { cleanImage, cleanName } from "../_lib/mul";

/**
 * /api/ag/admin/*: moderation, behind Cloudflare Access (docs/GALLERY.md §4).
 *
 *   GET    me                        the signed-in admin
 *   GET    entries?filter=&cursor=   reported | hidden | all, newest first
 *   POST   entries/:id/hide          hide an entry
 *   POST   entries/:id/unhide        show it again; reports stop auto-hiding it
 *   DELETE entries/:id               delete it with its votes and reports
 *   POST   entries/:id/ban-owner     ban the submitter's key: hide its entries, drop its votes
 *   PUT    units/:slug               fix a 'Mech's `{ name, image }`
 *   GET    export                    the top-liked visible avatar per 'Mech (ties go to the earliest)
 */

const PAGE = 100;

interface AdminRow {
  id: number;
  q: string;
  votes: number;
  reports: number;
  hidden: number;
  reviewed: number;
  created: number;
  slug: string | null;
  name: string | null;
  image: string | null;
  banned: number | null;
  pid: string | null;
}

function toAdminEntry(r: AdminRow): AdminEntry {
  return {
    id: r.id,
    q: r.q,
    unit: unitOf(r),
    votes: r.votes,
    created: r.created,
    by: r.pid,
    voted: false,
    mine: false,
    reports: r.reports,
    hidden: Boolean(r.hidden),
    reviewed: Boolean(r.reviewed),
    ownerBanned: Boolean(r.banned),
  };
}

async function listAdmin(ctx: Ctx<"path">): Promise<Response> {
  const params = new URL(ctx.request.url).searchParams;
  const filter = params.get("filter") ?? "reported";
  const where = filter === "hidden" ? "a.hidden = 1" : filter === "all" ? "1 = 1" : "a.reports > 0";
  const cursor = params.get("cursor");
  if (cursor !== null && !/^\d{1,15}$/.test(cursor)) throw new HttpError(400, "bad_cursor");
  const { results } = await ctx.env.DB.prepare(
    "SELECT a.id, a.q, a.votes, a.reports, a.hidden, a.reviewed, a.created, " +
      "u.slug, u.name, u.image, k.banned, k.pid FROM ag_avatars a " +
      "LEFT JOIN ag_units u ON u.slug = a.unit LEFT JOIN ag_keys k ON k.hash = a.owner " +
      `WHERE ${where} AND (?1 IS NULL OR a.id < ?1) ORDER BY a.id DESC LIMIT ?2`,
  )
    .bind(cursor === null ? null : Number(cursor), PAGE + 1)
    .all<AdminRow>();
  const entries = results.slice(0, PAGE).map(toAdminEntry);
  const last = entries[entries.length - 1];
  return json({
    entries,
    next: results.length > PAGE && last !== undefined ? String(last.id) : null,
  });
}

async function setHidden(ctx: Ctx<"path">, id: number, hidden: boolean): Promise<Response> {
  const res = await ctx.env.DB.prepare(
    // Unhiding marks the entry reviewed, so the same reports do not hide it again.
    "UPDATE ag_avatars SET hidden = ?2, reviewed = CASE WHEN ?2 = 0 THEN 1 ELSE reviewed END WHERE id = ?1",
  )
    .bind(id, hidden ? 1 : 0)
    .run();
  if (res.meta.changes === 0) throw new HttpError(404, "not_found");
  return json({ id, hidden });
}

async function banOwner(ctx: Ctx<"path">, id: number): Promise<Response> {
  const db = ctx.env.DB;
  const row = await db
    .prepare("SELECT owner FROM ag_avatars WHERE id = ?")
    .bind(id)
    .first<{ owner: string }>();
  if (row === null) throw new HttpError(404, "not_found");
  const voted = await db
    .prepare("SELECT avatar FROM ag_votes WHERE voter = ?")
    .bind(row.owner)
    .all<{ avatar: number }>();
  await db.batch([
    db.prepare("UPDATE ag_keys SET banned = 1 WHERE hash = ?").bind(row.owner),
    db.prepare("UPDATE ag_avatars SET hidden = 1 WHERE owner = ?").bind(row.owner),
    db.prepare("DELETE FROM ag_votes WHERE voter = ?").bind(row.owner),
    db.prepare("DELETE FROM ag_reports WHERE voter = ?").bind(row.owner),
    ...voted.results.map((v) => recountVotes(db, v.avatar)),
  ]);
  return json({ banned: true, votesRemoved: voted.results.length });
}

async function exportTop(ctx: Ctx<"path">): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT u.slug, u.name, a.q, a.votes, a.id FROM ag_units u " +
      "JOIN ag_avatars a ON a.id = (SELECT b.id FROM ag_avatars b " +
      "WHERE b.unit = u.slug AND b.hidden = 0 ORDER BY b.votes DESC, b.id ASC LIMIT 1) " +
      "ORDER BY u.name",
  ).all<{ slug: string; name: string; q: string; votes: number; id: number }>();
  return json({
    generated: new Date().toISOString(),
    units: results.map((r) => ({ ...r, mul: mulUnitUrl(r.slug) })),
  });
}

async function fixUnit(ctx: Ctx<"path">, slug: string): Promise<Response> {
  if (!isUnitSlug(slug)) throw new HttpError(400, "bad_unit");
  const body = await readJson(ctx.request);
  const name = typeof body.name === "string" ? cleanName(body.name) : null;
  if (name === null) throw new HttpError(400, "bad_name");
  let image: string | null = null;
  if (typeof body.image === "string" && body.image.trim() !== "") {
    image = cleanImage(body.image);
    if (image === null) throw new HttpError(400, "bad_image", "image must be an https MUL URL");
  }
  const res = await ctx.env.DB.prepare("UPDATE ag_units SET name = ?, image = ? WHERE slug = ?")
    .bind(name, image, slug)
    .run();
  if (res.meta.changes === 0) throw new HttpError(404, "not_found");
  return json({ slug, name, image });
}

export const onRequest: Handler<"path"> = (ctx) =>
  guard(async () => {
    const email = await requireAdmin(ctx.env, ctx.request);
    // Access authenticates by cookie, so writes must come from this site's own pages.
    if (ctx.request.method !== "GET") {
      const origin = ctx.request.headers.get("origin");
      if (origin !== new URL(ctx.request.url).origin) throw new HttpError(403, "bad_origin");
    }
    const raw = ctx.params.path;
    const path = Array.isArray(raw) ? raw : raw === undefined || raw === "" ? [] : [raw];
    const method = ctx.request.method;
    const [a, b, c] = path;

    if (method === "GET" && a === "me" && b === undefined) {
      return json({ email, settings: config(ctx.env) });
    }
    if (method === "GET" && a === "export" && b === undefined) return exportTop(ctx);
    if (a === "entries") {
      if (method === "GET" && b === undefined) return listAdmin(ctx);
      const id = idParam(b);
      if (method === "DELETE" && c === undefined) {
        const exists = await ctx.env.DB.prepare("SELECT 1 AS x FROM ag_avatars WHERE id = ?")
          .bind(id)
          .first();
        if (exists === null) throw new HttpError(404, "not_found");
        await ctx.env.DB.batch(deleteEntry(ctx.env.DB, id));
        return json({ deleted: id });
      }
      if (method === "POST" && c === "hide") return setHidden(ctx, id, true);
      if (method === "POST" && c === "unhide") return setHidden(ctx, id, false);
      if (method === "POST" && c === "ban-owner") return banOwner(ctx, id);
    }
    if (a === "units" && b !== undefined && path.length === 2 && method === "PUT") {
      return fixUnit(ctx, b);
    }
    throw new HttpError(404, "not_found");
  });
