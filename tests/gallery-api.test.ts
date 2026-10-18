/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Ctx,
  D1Database,
  D1PreparedStatement,
  D1Result,
  Env,
} from "../functions/api/ag/_lib/cf";
import * as adminRoute from "../functions/api/ag/admin/[[path]]";
import * as entryRoute from "../functions/api/ag/avatars/[id]";
import * as reportRoute from "../functions/api/ag/avatars/[id]/report";
import * as voteRoute from "../functions/api/ag/avatars/[id]/vote";
import * as avatarsRoute from "../functions/api/ag/avatars/index";
import * as keysRoute from "../functions/api/ag/keys";
import * as unitsRoute from "../functions/api/ag/units";
import { keyPublicId } from "../web/avatar/avatar.gallery";

/**
 * The gallery API end to end: real route handlers over the real migration in
 * an in-memory SQLite (node:sqlite) behind a small D1 adapter, with Turnstile,
 * MUL and Cloudflare Access answered by a stubbed fetch.
 */

type Sqlite = typeof import("node:sqlite");
let sqlite: Sqlite | null = null;
try {
  sqlite = createRequire(import.meta.url)("node:sqlite") as Sqlite;
} catch {
  // Node without node:sqlite (< 22.5): the suite is skipped.
}

const MIGRATION = readFileSync(
  new URL("../migrations/ag/0001_gallery.sql", import.meta.url),
  "utf8",
);

function d1(db: import("node:sqlite").DatabaseSync): D1Database {
  const exec = (sql: string, binds: unknown[]): D1Result => {
    const stmt = db.prepare(sql);
    const args = binds.map((b) => (b === undefined ? null : b)) as never[];
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(sql)) {
      return { results: stmt.all(...args), meta: { changes: 0, last_row_id: 0 } };
    }
    const r = stmt.run(...args);
    return {
      results: [],
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
    };
  };
  const prepare = (
    sql: string,
    binds: unknown[] = [],
  ): D1PreparedStatement & { exec(): D1Result } => ({
    bind: (...values: unknown[]) => prepare(sql, values),
    first: async <T>() => (exec(sql, binds).results[0] as T | undefined) ?? null,
    all: async <T>() => exec(sql, binds) as D1Result<T>,
    run: async () => exec(sql, binds),
    exec: () => exec(sql, binds),
  });
  return {
    prepare: (sql) => prepare(sql),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as unknown as { exec(): D1Result }).exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const ATLAS = "https://masterunitlist.battletech.com/units/atlas-as7-d-dc";
const ATLAS_ART =
  "https://masterunitlist.battletech.com/point-backs/unit-art/manual/atlas-60d7b0.webp";
const Q = "head=sq&shoulder=no&torso=no&arms=no&legs=no";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag";

let env: Env;
let mulCalls = 0;
let mulDown = false;
let accessKeys: CryptoKeyPair;

function ctx(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    key?: string;
    params?: Record<string, string | string[]>;
    headers?: Record<string, string>;
  } = {},
): Ctx<never> {
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.7", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return {
    request: new Request(`https://bt10x.stoneworks.dev/api/ag${path}`, init),
    env,
    params: (opts.params ?? {}) as Record<never, string>,
    waitUntil: () => {},
  };
}

async function call<T = Record<string, unknown>>(
  handler: (c: Ctx<never>) => Promise<Response>,
  c: Ctx<never>,
): Promise<{ status: number; body: T }> {
  const res = await handler(c);
  return { status: res.status, body: (await res.json()) as T };
}

async function mintKey(): Promise<string> {
  const r = await call<{ key: string }>(
    keysRoute.onRequestPost as never,
    ctx("POST", "/keys", { body: { turnstile: "ok" } }),
  );
  expect(r.status).toBe(201);
  return r.body.key;
}

async function submit(key: string, q = Q, mul = ATLAS) {
  return call<{
    id: number;
    existing: boolean;
    entry?: { unit: { name: string; image: string | null } | null };
  }>(
    avatarsRoute.onRequestPost as never,
    ctx("POST", "/avatars", { key, body: { q, mul, turnstile: "ok" } }),
  );
}

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return Buffer.from(bytes).toString("base64url");
}

async function accessJwt(claims: Record<string, unknown>): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    accessKeys.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

async function adminCall(method: string, path: string[], token: string | null, body?: unknown) {
  const headers: Record<string, string> = { origin: "https://bt10x.stoneworks.dev" };
  if (token !== null) headers["cf-access-jwt-assertion"] = token;
  return call(
    adminRoute.onRequest as never,
    ctx(method, `/admin/${path.join("/")}`, { headers, params: { path }, body }),
  );
}

async function adminExport<T>() {
  const now = Math.floor(Date.now() / 1000);
  const token = await accessJwt({ aud: AUD, iss: `https://${TEAM}`, exp: now + 60 });
  const headers = { origin: "https://bt10x.stoneworks.dev", "cf-access-jwt-assertion": token };
  return call<T>(
    adminRoute.onRequest as never,
    ctx("GET", "/admin/export", { headers, params: { path: ["export"] } }),
  );
}

describe.skipIf(sqlite === null)("gallery API", () => {
  beforeEach(async () => {
    const db = new sqlite!.DatabaseSync(":memory:");
    db.exec(MIGRATION);
    env = {
      DB: d1(db),
      TURNSTILE_SECRET: "secret",
      IP_HASH_SALT: "salt",
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
    };
    mulCalls = 0;
    mulDown = false;
    accessKeys ??= (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", accessKeys.publicKey);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("turnstile/v0/siteverify")) {
        const token = (init?.body as FormData | undefined)?.get("response");
        return Response.json({ success: token === "ok" });
      }
      if (url.startsWith("https://masterunitlist.battletech.com/units/")) {
        mulCalls++;
        if (mulDown) return new Response("busy", { status: 503 });
        if (url.endsWith("/no-such-mech")) return new Response("missing", { status: 404 });
        return new Response(
          `<meta property="og:title" content="Atlas AS7-D-DC"><meta property="og:image" content="${ATLAS_ART}">`,
        );
      }
      if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [{ ...jwk, kid: "k1" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints device keys only past Turnstile", async () => {
    const bad = await call(
      keysRoute.onRequestPost as never,
      ctx("POST", "/keys", { body: { turnstile: "no" } }),
    );
    expect(bad).toEqual({
      status: 403,
      body: { error: "bot_check_failed", message: "bot_check_failed" },
    });
    expect(await mintKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("checks a key brought from another browser", async () => {
    const key = await mintKey();
    expect(await call(keysRoute.onRequestGet as never, ctx("GET", "/keys", { key }))).toEqual({
      status: 200,
      body: { pid: await keyPublicId(key) },
    });
    const unknown = "A".repeat(43);
    expect(
      (await call(keysRoute.onRequestGet as never, ctx("GET", "/keys", { key: unknown }))).body,
    ).toMatchObject({ error: "no_key" });
    expect((await call(keysRoute.onRequestGet as never, ctx("GET", "/keys"))).status).toBe(401);
    await env.DB.prepare("UPDATE ag_keys SET banned = 1").run();
    expect(
      (await call(keysRoute.onRequestGet as never, ctx("GET", "/keys", { key }))).body,
    ).toMatchObject({ error: "banned" });
  });

  it("shows each entry's submitter by public ID and lists a key's own entries", async () => {
    const alice = await mintKey();
    const bob = await mintKey();
    const a = (await submit(alice)).body.id;
    const b = (await submit(bob, `${Q}&rh=2622`)).body.id;
    const list = await call<{ entries: { id: number; by: string; mine: boolean }[] }>(
      avatarsRoute.onRequestGet as never,
      ctx("GET", "/avatars?sort=new", { key: alice }),
    );
    expect(list.body.entries).toEqual([
      expect.objectContaining({ id: b, by: await keyPublicId(bob), mine: false }),
      expect.objectContaining({ id: a, by: await keyPublicId(alice), mine: true }),
    ]);
    const mine = await call<{ entries: { id: number }[] }>(
      avatarsRoute.onRequestGet as never,
      ctx("GET", "/avatars?mine=1", { key: bob }),
    );
    expect(mine.body.entries.map((e) => e.id)).toEqual([b]);
    const anon = await call(avatarsRoute.onRequestGet as never, ctx("GET", "/avatars?mine=1"));
    expect(anon.status).toBe(401);
  });

  it("submits an avatar, reads the 'Mech from MUL once, and merges duplicates", async () => {
    const key = await mintKey();
    const first = await submit(key);
    expect(first.status).toBe(201);
    expect(first.body.entry?.unit).toMatchObject({ name: "Atlas AS7-D-DC", image: ATLAS_ART });
    // Same look, written differently: an override equal to the variant glyph.
    const again = await submit(key, `${Q}&rh=250c`);
    expect(again.body).toEqual({ id: first.body.id, existing: true });
    // Another avatar for the same 'Mech reuses the cached unit.
    expect((await submit(key, `${Q}&rh=2622`)).status).toBe(201);
    expect(mulCalls).toBe(1);
  });

  it("rejects bad avatars, bad URLs, unknown units, missing keys and failed bot checks", async () => {
    const key = await mintKey();
    expect((await submit(key, "head=sq")).body).toMatchObject({ error: "bad_avatar" });
    expect((await submit(key, Q, "https://example.com/units/atlas")).body).toMatchObject({
      error: "bad_mul_url",
    });
    expect(
      (await submit(key, Q, "https://masterunitlist.battletech.com/units/no-such-mech")).body,
    ).toMatchObject({
      error: "unknown_unit",
    });
    expect((await submit("A".repeat(43))).status).toBe(401);
    const bot = await call(
      avatarsRoute.onRequestPost as never,
      ctx("POST", "/avatars", { key, body: { q: Q, mul: ATLAS, turnstile: "no" } }),
    );
    expect(bot.status).toBe(403);
  });

  it("falls back to the slug when MUL can't be read", async () => {
    mulDown = true;
    const r = await submit(await mintKey());
    expect(r.body.entry?.unit).toMatchObject({ name: "Atlas AS7-D-DC", image: null });
  });

  it("toggles one vote per key and sorts by votes", async () => {
    const a = await mintKey();
    const b = await mintKey();
    const x = (await submit(a)).body.id;
    const y = (await submit(a, `${Q}&rh=2622`)).body.id;
    const vote = (key: string, id: number) =>
      call<{ voted: boolean; votes: number }>(
        voteRoute.onRequestPost as never,
        ctx("POST", `/avatars/${id}/vote`, { key, params: { id: String(id) } }),
      );
    expect((await vote(a, y)).body).toEqual({ voted: true, votes: 1 });
    expect((await vote(b, y)).body).toEqual({ voted: true, votes: 2 });
    expect((await vote(b, y)).body).toEqual({ voted: false, votes: 1 });
    const list = await call<{
      entries: { id: number; votes: number; voted: boolean; mine: boolean }[];
    }>(avatarsRoute.onRequestGet as never, ctx("GET", "/avatars?sort=top", { key: a }));
    expect(list.body.entries.map((e) => [e.id, e.votes, e.voted, e.mine])).toEqual([
      [y, 1, true, true],
      [x, 0, false, true],
    ]);
  });

  it("pages through entries with a cursor", async () => {
    env.PAGE_SIZE = "2";
    const key = await mintKey();
    for (const ch of ["2622", "2623", "2624"]) await submit(key, `${Q}&rh=${ch}`);
    const get = (query: string) =>
      call<{ entries: { id: number }[]; next: string | null }>(
        avatarsRoute.onRequestGet as never,
        ctx("GET", `/avatars?${query}`),
      );
    const p1 = await get("sort=new");
    expect(p1.body.entries.map((e) => e.id)).toEqual([3, 2]);
    const p2 = await get(`sort=new&cursor=${p1.body.next}`);
    expect(p2.body).toEqual({ entries: [expect.objectContaining({ id: 1 })], next: null });
    const t1 = await get("sort=top");
    const t2 = await get(`sort=top&cursor=${t1.body.next}`);
    expect([...t1.body.entries, ...t2.body.entries].map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("hides an entry at the report threshold, once per key", async () => {
    env.REPORT_HIDE_THRESHOLD = "2";
    const owner = await mintKey();
    const id = (await submit(owner)).body.id;
    const report = (key: string) =>
      call(
        reportRoute.onRequestPost as never,
        ctx("POST", `/avatars/${id}/report`, { key, params: { id: String(id) } }),
      );
    const r1 = await mintKey();
    await report(r1);
    await report(r1);
    expect(
      (
        await call(
          entryRoute.onRequestGet as never,
          ctx("GET", `/avatars/${id}`, { params: { id: String(id) } }),
        )
      ).status,
    ).toBe(200);
    await report(await mintKey());
    const hidden = await call(
      entryRoute.onRequestGet as never,
      ctx("GET", `/avatars/${id}`, { params: { id: String(id) } }),
    );
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: "under_review", message: "under_review" });
  });

  it("answers under_review for entries awaiting approval, even to their submitter", async () => {
    env.AUTO_PUBLISH = "false";
    const owner = await mintKey();
    const first = await submit(owner);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ pending: true });
    const get = (id: number, key?: string) =>
      call(
        entryRoute.onRequestGet as never,
        ctx("GET", `/avatars/${id}`, {
          ...(key === undefined ? {} : { key }),
          params: { id: String(id) },
        }),
      );
    expect((await get(first.body.id, owner)).body).toMatchObject({ error: "under_review" });
    expect((await get(first.body.id)).body).toMatchObject({ error: "under_review" });
    expect((await get(first.body.id + 1000)).body).toMatchObject({ error: "not_found" });
    // The same avatar again points at the hidden original.
    expect((await submit(owner)).body).toEqual({ id: first.body.id, existing: true });
  });

  it("lets only the submitter delete an entry", async () => {
    const owner = await mintKey();
    const id = (await submit(owner)).body.id;
    const del = (key: string) =>
      call(
        entryRoute.onRequestDelete as never,
        ctx("DELETE", `/avatars/${id}`, { key, params: { id: String(id) } }),
      );
    expect((await del(await mintKey())).status).toBe(403);
    expect((await del(owner)).status).toBe(200);
    expect((await del(owner)).status).toBe(404);
  });

  it("rate-limits submissions per key", async () => {
    env.SUBMITS_PER_DAY = "1";
    const key = await mintKey();
    expect((await submit(key)).status).toBe(201);
    expect((await submit(key, `${Q}&rh=2622`)).body).toMatchObject({ error: "rate_limited" });
  });

  it("accepts avatars with no 'Mech, merges them apart from linked ones, and lists them as a group", async () => {
    const key = await mintKey();
    const loose = await submit(key, Q, "");
    expect(loose.status).toBe(201);
    expect(loose.body.entry?.unit).toBeNull();
    expect(mulCalls).toBe(0);
    // Same avatar, no 'Mech again: merged. Same avatar for a 'Mech: its own entry.
    expect((await submit(key, `${Q}&rh=250c`, "  ")).body).toEqual({
      id: loose.body.id,
      existing: true,
    });
    const linked = await submit(key);
    expect(linked.status).toBe(201);
    expect(linked.body.id).not.toBe(loose.body.id);
    // A field that is filled in must still be a MUL unit page.
    expect((await submit(key, Q, "atlas")).body).toMatchObject({ error: "bad_mul_url" });

    const none = await call<{ entries: { id: number; unit: unknown }[] }>(
      avatarsRoute.onRequestGet as never,
      ctx("GET", "/avatars?unit=none"),
    );
    expect(none.body.entries).toEqual([expect.objectContaining({ id: loose.body.id, unit: null })]);
    const all = await call<{ entries: unknown[] }>(
      avatarsRoute.onRequestGet as never,
      ctx("GET", "/avatars?sort=new"),
    );
    expect(all.body.entries).toHaveLength(2);
    const units = await call<{ units: unknown[]; unlinked: { count: number; top: string } }>(
      unitsRoute.onRequestGet as never,
      ctx("GET", "/units"),
    );
    expect(units.body.units).toHaveLength(1);
    expect(units.body.unlinked).toEqual({ count: 1, top: Q });
    const exp = await adminExport<{ units: { id: number }[] }>();
    expect(exp.body.units.map((u) => u.id)).toEqual([linked.body.id]);
  });

  it("lists units and exports the top avatar per 'Mech to admins", async () => {
    const key = await mintKey();
    const top = (await submit(key, `${Q}&rh=2622`)).body.id;
    await submit(key);
    await call(
      voteRoute.onRequestPost as never,
      ctx("POST", `/avatars/${top}/vote`, { key, params: { id: String(top) } }),
    );
    const units = await call<{ units: { slug: string; count: number; top: string }[] }>(
      unitsRoute.onRequestGet as never,
      ctx("GET", "/units?q=atl"),
    );
    expect(units.body.units).toEqual([
      expect.objectContaining({ slug: "atlas-as7-d-dc", count: 2, top: `${Q}&rh=2622` }),
    ]);
    expect((await adminCall("GET", ["export"], null)).status).toBe(403);
    const exp = await adminExport<{
      units: { slug: string; q: string; votes: number; mul: string }[];
    }>();
    expect(exp.body.units).toEqual([
      expect.objectContaining({ slug: "atlas-as7-d-dc", q: `${Q}&rh=2622`, votes: 1, mul: ATLAS }),
    ]);
  });

  it("guards admin routes with a valid Access token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = await accessJwt({
      aud: [AUD],
      iss: `https://${TEAM}`,
      exp: now + 60,
      email: "me@example.com",
    });
    expect((await adminCall("GET", ["me"], null)).status).toBe(403);
    expect(
      (
        await adminCall(
          "GET",
          ["me"],
          await accessJwt({ aud: ["other"], iss: `https://${TEAM}`, exp: now + 60 }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await adminCall(
          "GET",
          ["me"],
          await accessJwt({ aud: [AUD], iss: `https://${TEAM}`, exp: now - 1 }),
        )
      ).status,
    ).toBe(403);
    const forged = `${good.slice(0, good.lastIndexOf(".") + 1)}${b64url("nope")}`;
    expect((await adminCall("GET", ["me"], forged)).status).toBe(403);
    expect((await adminCall("GET", ["me"], good)).body).toMatchObject({ email: "me@example.com" });
    env.ACCESS_AUD = "";
    expect((await adminCall("GET", ["me"], good)).body).toMatchObject({
      error: "admin_not_configured",
    });
  });

  it("hides, unhides, deletes, bans and fixes 'Mechs from the admin routes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await accessJwt({ aud: AUD, iss: `https://${TEAM}`, exp: now + 60 });
    const owner = await mintKey();
    const voter = await mintKey();
    const a = (await submit(owner)).body.id;
    const b = (await submit(voter, `${Q}&rh=2622`)).body.id;
    await call(
      voteRoute.onRequestPost as never,
      ctx("POST", `/avatars/${a}/vote`, { key: voter, params: { id: String(a) } }),
    );

    expect((await adminCall("POST", ["entries", String(a), "hide"], token)).body).toEqual({
      id: a,
      hidden: true,
    });
    const hidden = await adminCall("GET", ["entries"], token);
    expect(hidden.status).toBe(200);
    expect((await adminCall("POST", ["entries", String(a), "unhide"], token)).body).toEqual({
      id: a,
      hidden: false,
    });

    // Banning b's owner hides b and removes their vote on a.
    expect((await adminCall("POST", ["entries", String(b), "ban-owner"], token)).body).toEqual({
      banned: true,
      votesRemoved: 1,
    });
    const one = await call<{ entry: { votes: number } }>(
      entryRoute.onRequestGet as never,
      ctx("GET", `/avatars/${a}`, { params: { id: String(a) } }),
    );
    expect(one.body.entry.votes).toBe(0);
    expect((await submit(voter, `${Q}&rh=2623`)).body).toMatchObject({ error: "banned" });

    expect(
      (
        await adminCall("PUT", ["units", "atlas-as7-d-dc"], token, {
          name: "Atlas",
          image: "https://evil.example/x.png",
        })
      ).body,
    ).toMatchObject({ error: "bad_image" });
    expect(
      (await adminCall("PUT", ["units", "atlas-as7-d-dc"], token, { name: "Atlas", image: "" }))
        .body,
    ).toEqual({ slug: "atlas-as7-d-dc", name: "Atlas", image: null });

    expect((await adminCall("DELETE", ["entries", String(a)], token)).body).toEqual({ deleted: a });
    expect(
      (
        await call(
          entryRoute.onRequestGet as never,
          ctx("GET", `/avatars/${a}`, { params: { id: String(a) } }),
        )
      ).status,
    ).toBe(404);
  });

  it("refuses admin writes from other origins", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await accessJwt({ aud: AUD, iss: `https://${TEAM}`, exp: now + 60 });
    const r = await call(
      adminRoute.onRequest as never,
      ctx("DELETE", "/admin/entries/1", {
        headers: { origin: "https://evil.example", "cf-access-jwt-assertion": token },
        params: { path: ["entries", "1"] },
      }),
    );
    expect(r.body).toMatchObject({ error: "bad_origin" });
  });
});
