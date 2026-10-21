import { bumpVersion } from "./cache";
import type { D1Database, D1PreparedStatement } from "./cf";
import { HttpError } from "./http";

/** Gallery reads and writes over the ag_ tables (docs/GALLERY.md §6). */

/**
 * An entry as every visitor sees it. It holds nothing about the requesting
 * key, so list and entry responses are the same for everyone and can be
 * cached once for all (_lib/cache.ts). Whether the visitor liked it or
 * submitted it comes separately from `marksFor` (`GET /api/ag/me`).
 */
export interface Entry {
  id: number;
  q: string;
  /** The 'Mech it is for; null when the submitter named none. */
  unit: { slug: string; name: string; image: string | null } | null;
  votes: number;
  created: number;
  /** Public ID of the submitter's key (avatar.gallery.ts publicId). */
  by: string | null;
}

/** Admin view adds the moderation fields. */
export interface AdminEntry extends Entry {
  reports: number;
  hidden: boolean;
  reviewed: boolean;
  ownerBanned: boolean;
}

interface EntryRow {
  id: number;
  q: string;
  votes: number;
  created: number;
  by: string | null;
  slug: string | null;
  name: string | null;
  image: string | null;
}

// No per-visitor columns (and no ag_votes join) here, on purpose: see Entry.
// ?1 is reserved for the owner filter of `mine` lists, so the other
// parameters keep the same numbers whether or not that filter is used.
const ENTRY_SELECT =
  "SELECT a.id, a.q, a.votes, a.created, k.pid AS by, u.slug, u.name, u.image " +
  "FROM ag_avatars a LEFT JOIN ag_units u ON u.slug = a.unit " +
  "LEFT JOIN ag_keys k ON k.hash = a.owner";

/** The entry's unit from a LEFT JOIN on ag_units, or null when unlinked. */
export function unitOf(r: {
  slug: string | null;
  name: string | null;
  image: string | null;
}): Entry["unit"] {
  return r.slug === null ? null : { slug: r.slug, name: r.name ?? r.slug, image: r.image };
}

function toEntry(r: EntryRow): Entry {
  return {
    id: r.id,
    q: r.q,
    unit: unitOf(r),
    votes: r.votes,
    created: r.created,
    by: r.by,
  };
}

export type Sort = "top" | "new";

/** `unit` value that lists the entries tied to no 'Mech. */
export const NO_UNIT = "none";

export interface ListQuery {
  sort: Sort;
  /** A unit slug, NO_UNIT, or null for every entry. */
  unit: string | null;
  /**
   * Only this key hash's own entries (`?mine=1`). The one personal list:
   * its route never caches it.
   */
  owner?: string | null;
  cursor: string | null;
  limit: number;
}

/** Cursor for the row after `e` in `sort` order. */
function cursorOf(sort: Sort, e: Entry): string {
  return sort === "top" ? `${e.votes}.${e.id}` : String(e.id);
}

/** A page of visible entries, plus the cursor of the next page (null at the end). */
export async function listEntries(
  db: D1Database,
  q: ListQuery,
): Promise<{ entries: Entry[]; next: string | null }> {
  const where = ["a.hidden = 0"];
  const owner = q.owner ?? null;
  const binds: unknown[] = [owner];
  if (owner !== null) where.push("a.owner = ?1");
  if (q.unit === NO_UNIT) {
    where.push("a.unit IS NULL");
  } else if (q.unit !== null) {
    binds.push(q.unit);
    where.push(`a.unit = ?${binds.length}`);
  }
  if (q.cursor !== null) {
    if (q.sort === "top") {
      const m = /^(\d{1,9})\.(\d{1,15})$/.exec(q.cursor);
      if (m === null) throw new HttpError(400, "bad_cursor");
      binds.push(Number(m[1]), Number(m[2]));
      const v = binds.length - 1;
      where.push(`(a.votes < ?${v} OR (a.votes = ?${v} AND a.id < ?${v + 1}))`);
    } else {
      if (!/^\d{1,15}$/.test(q.cursor)) throw new HttpError(400, "bad_cursor");
      binds.push(Number(q.cursor));
      where.push(`a.id < ?${binds.length}`);
    }
  }
  const order = q.sort === "top" ? "a.votes DESC, a.id DESC" : "a.id DESC";
  binds.push(q.limit + 1);
  const sql = `${ENTRY_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?${binds.length}`;
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<EntryRow>();
  const entries = results.slice(0, q.limit).map(toEntry);
  const last = entries[entries.length - 1];
  return {
    entries,
    next: results.length > q.limit && last !== undefined ? cursorOf(q.sort, last) : null,
  };
}

/** One visible entry, or null. */
export async function getEntry(db: D1Database, id: number): Promise<Entry | null> {
  const row = await db
    .prepare(`${ENTRY_SELECT} WHERE a.id = ?2 AND a.hidden = 0`)
    .bind(null, id)
    .first<EntryRow>();
  return row === null ? null : toEntry(row);
}

/** Statement that recounts an entry's votes from ag_votes. */
export function recountVotes(db: D1Database, id: number): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE ag_avatars SET votes = (SELECT COUNT(*) FROM ag_votes WHERE avatar = ?1) WHERE id = ?1",
    )
    .bind(id);
}

/** Statement that recounts reports and auto-hides at `threshold` (0 = never). */
export function recountReports(db: D1Database, id: number, threshold: number): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE ag_avatars SET reports = (SELECT COUNT(*) FROM ag_reports WHERE avatar = ?1), " +
        "hidden = CASE WHEN ?2 > 0 AND reviewed = 0 AND " +
        "(SELECT COUNT(*) FROM ag_reports WHERE avatar = ?1) >= ?2 THEN 1 ELSE hidden END " +
        "WHERE id = ?1",
    )
    .bind(id, threshold);
}

/**
 * Statements that delete an entry with its votes and reports, and bump the
 * cache version so cached lists stop showing it (_lib/cache.ts).
 */
export function deleteEntry(db: D1Database, id: number): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM ag_votes WHERE avatar = ?").bind(id),
    db.prepare("DELETE FROM ag_reports WHERE avatar = ?").bind(id),
    db.prepare("DELETE FROM ag_avatars WHERE id = ?").bind(id),
    bumpVersion(db),
  ];
}

/** Toggle `voter`'s vote on a visible entry; returns the new state. */
export async function toggleVote(
  db: D1Database,
  id: number,
  voter: string,
): Promise<{ voted: boolean; votes: number }> {
  const exists = await db
    .prepare("SELECT 1 AS x FROM ag_avatars WHERE id = ? AND hidden = 0")
    .bind(id)
    .first();
  if (exists === null) throw new HttpError(404, "not_found");
  const ins = await db
    .prepare("INSERT INTO ag_votes (avatar, voter) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(id, voter)
    .run();
  const voted = ins.meta.changes > 0;
  // A like changes the entry's count and its place in "top", so it bumps the
  // cache version too. That makes every like a cache miss for the next
  // reader of each list, which is the price of never showing a count that
  // disagrees with the button the voter just pressed.
  const stmts = voted
    ? [recountVotes(db, id), bumpVersion(db)]
    : [
        db.prepare("DELETE FROM ag_votes WHERE avatar = ? AND voter = ?").bind(id, voter),
        recountVotes(db, id),
        bumpVersion(db),
      ];
  await db.batch(stmts);
  const row = await db
    .prepare("SELECT votes FROM ag_avatars WHERE id = ?")
    .bind(id)
    .first<{ votes: number }>();
  return { voted, votes: row?.votes ?? 0 };
}

/** Most ids `marksFor` takes in one call: the largest PAGE_SIZE (_lib/config.ts). */
export const MAX_MARK_IDS = 200;

/**
 * Of `ids`, the ones `voter` liked and the ones it submitted: the personal
 * half of a page that the public, cached half leaves out (see Entry). Hidden
 * entries are skipped, matching what the lists show. The ids go in as one
 * JSON array read by `json_each`, because D1 allows at most 100 bound
 * parameters per statement and a page can hold 200 entries.
 */
export async function marksFor(
  db: D1Database,
  voter: string,
  ids: number[],
): Promise<{ voted: number[]; mine: number[] }> {
  if (ids.length === 0) return { voted: [], mine: [] };
  const { results } = await db
    .prepare(
      "SELECT a.id, a.owner = ?1 AS mine, " +
        "EXISTS (SELECT 1 FROM ag_votes v WHERE v.avatar = a.id AND v.voter = ?1) AS voted " +
        "FROM ag_avatars a WHERE a.id IN (SELECT value FROM json_each(?2)) AND a.hidden = 0 " +
        "ORDER BY a.id",
    )
    .bind(voter, JSON.stringify(ids))
    .all<{ id: number; mine: number; voted: number }>();
  return {
    voted: results.filter((r) => r.voted).map((r) => r.id),
    mine: results.filter((r) => r.mine).map((r) => r.id),
  };
}

/** Visible entries tied to no 'Mech: count and top avatar (null when none). */
export async function unlinkedSummary(
  db: D1Database,
): Promise<{ count: number; top: string | null }> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count, (SELECT b.q FROM ag_avatars b WHERE b.unit IS NULL " +
        "AND b.hidden = 0 ORDER BY b.votes DESC, b.id ASC LIMIT 1) AS top " +
        "FROM ag_avatars a WHERE a.unit IS NULL AND a.hidden = 0",
    )
    .first<{ count: number; top: string | null }>();
  return { count: row?.count ?? 0, top: row?.top ?? null };
}

/** Units with visible entries: entry count and top avatar each. */
export async function listUnits(
  db: D1Database,
  search: string,
): Promise<{ slug: string; name: string; image: string | null; count: number; top: string }[]> {
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { results } = await db
    .prepare(
      "SELECT u.slug, u.name, u.image, COUNT(a.id) AS count, " +
        "(SELECT b.q FROM ag_avatars b WHERE b.unit = u.slug AND b.hidden = 0 " +
        "ORDER BY b.votes DESC, b.id ASC LIMIT 1) AS top " +
        "FROM ag_units u JOIN ag_avatars a ON a.unit = u.slug AND a.hidden = 0 " +
        "WHERE ?1 = '' OR u.name LIKE ?2 ESCAPE '\\' OR u.slug LIKE ?2 ESCAPE '\\' " +
        "GROUP BY u.slug ORDER BY u.name LIMIT 500",
    )
    .bind(search, like)
    .all<{ slug: string; name: string; image: string | null; count: number; top: string }>();
  return results;
}
