/**
 * Shared query grammar for `info mech` / `info weapon` listings:
 *
 *   info mech   [model | text] [key:value …] [!]
 *   info weapon [name  | text] [key:value …] [!]
 *
 * Plain words join into a case-insensitive substring search, `key:value`
 * tokens AND together as filters, and a lone `!` lifts the row cap. Filters
 * read only the catalogs (mech manifest identity, weapon catalog), never
 * decoded sheets. Pure functions over plain entries so tests can feed
 * synthetic catalogs larger than the bundled one.
 */
import type { MechManifestEntry, WeaponCategory, WeaponDef } from "btlib10x";
import { allWeaponDefs, catalogMechs, weightClassForTonnage } from "btlib10x";
import { i18n } from "./i18n/index";

/** Most rows any listing tier prints before it groups or summarizes. */
export const ROW_CAP = 20;

export interface ParsedQuery {
  /** Plain words joined by single spaces (original case); "" when none. */
  readonly text: string;
  /** Filter tokens by lowercased key; a repeated key keeps the last value. */
  readonly filters: ReadonlyMap<string, string>;
  /** A lone `!` was given: print every match, uncapped. */
  readonly force: boolean;
}

export function parseQuery(args: readonly string[], keys: readonly string[]): ParsedQuery {
  const words: string[] = [];
  const filters = new Map<string, string>();
  let force = false;
  for (const arg of args) {
    if (arg === "!") {
      force = true;
      continue;
    }
    const colon = arg.indexOf(":");
    if (colon < 0) {
      words.push(arg);
      continue;
    }
    const key = arg.slice(0, colon).toLowerCase();
    const value = arg.slice(colon + 1);
    if (!keys.includes(key)) {
      throw new Error(i18n("err.badFilterKey", { key, keys: keys.map((k) => `${k}:`).join(" ") }));
    }
    if (value === "") throw new Error(i18n("err.badFilterValue", { token: arg }));
    filters.set(key, value);
  }
  return { text: words.join(" "), filters, force };
}

/** The query echoed back in headers and errors: words, then filters, then `!`. */
export function queryLabel(q: ParsedQuery): string {
  const parts: string[] = [];
  if (q.text !== "") parts.push(q.text);
  for (const [k, v] of q.filters) parts.push(`${k}:${v}`);
  return parts.join(" ");
}

export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.text === "" && q.filters.size === 0;
}

function badValue(key: string, value: string): Error {
  return new Error(i18n("err.badFilterValue", { token: `${key}:${value}` }));
}

/**
 * Numeric filter: `N`, `A-B` (inclusive), `<N`, `<=N`, `>N`, `>=N`.
 * Returns null for anything else.
 */
export function parseNumberRange(spec: string): ((n: number) => boolean) | null {
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range !== null) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return (n) => n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
  }
  const cmp = /^(<=|>=|<|>|=)?(\d+)$/.exec(spec);
  if (cmp === null) return null;
  const v = Number(cmp[2]);
  switch (cmp[1]) {
    case "<":
      return (n) => n < v;
    case "<=":
      return (n) => n <= v;
    case ">":
      return (n) => n > v;
    case ">=":
      return (n) => n >= v;
    default:
      return (n) => n === v;
  }
}

function numberFilter(key: string, value: string): (n: number) => boolean {
  const pred = parseNumberRange(value);
  if (pred === null) throw badValue(key, value);
  return pred;
}

/**
 * Comma list of names, each an unambiguous case-insensitive prefix of one of
 * `choices` (`h` → heavy, `en` → energy; `e` is ambiguous between energy and
 * equipment and is rejected).
 */
function choiceFilter<T extends string>(
  key: string,
  value: string,
  choices: readonly T[],
): ReadonlySet<T> {
  const picked = new Set<T>();
  for (const part of value.toLowerCase().split(",")) {
    const hits = choices.filter((c) => c.toLowerCase().startsWith(part));
    const exact = choices.find((c) => c.toLowerCase() === part);
    const hit = exact ?? (hits.length === 1 ? hits[0] : undefined);
    if (part === "" || hit === undefined) throw badValue(key, value);
    picked.add(hit);
  }
  return picked;
}

type Tech = "is" | "clan";

function techFilter(value: string): ReadonlySet<Tech> {
  const picked = new Set<Tech>();
  for (const part of value.toLowerCase().split(",")) {
    if (part === "is" || part === "innersphere" || part === "inner") picked.add("is");
    else if (part === "clan" || part === "cl") picked.add("clan");
    else throw badValue("tech", value);
  }
  return picked;
}

interface SortSpec {
  readonly by: string;
  readonly desc: boolean;
}

function sortFilter(value: string, choices: readonly string[]): SortSpec {
  const desc = value.startsWith("-");
  const by = (desc ? value.slice(1) : value).toLowerCase();
  if (!choices.includes(by)) throw badValue("sort", value);
  return { by, desc };
}

function textHit(needle: string, ...haystack: readonly (string | undefined)[]): boolean {
  if (needle === "") return true;
  const n = needle.toLowerCase();
  return haystack.some((h) => h?.toLowerCase().includes(n) === true);
}

// ---------------------------------------------------------------- mechs ----
export const MECH_FILTER_KEYS = ["class", "ton", "tech", "intro", "pack", "sort"] as const;
const WEIGHT_CLASSES = ["Light", "Medium", "Heavy", "Assault"] as const;
/** Catalog packs a 'Mech can come from (see `loadCatalog` / `appendCatalog`). */
const MECH_PACKS = ["base", "sw"] as const;
const MECH_SORTS = ["ton", "name", "model", "intro"] as const;

function mechTech(m: MechManifestEntry): Tech {
  return m.techBase === "Clan" ? "clan" : "is";
}

/** Filter + sort the mech manifest (default order: tonnage, then name, then model). */
export function selectMechs(
  entries: readonly MechManifestEntry[],
  q: ParsedQuery,
): MechManifestEntry[] {
  const preds: ((m: MechManifestEntry) => boolean)[] = [];
  const cls = q.filters.get("class");
  if (cls !== undefined) {
    const set = choiceFilter("class", cls, WEIGHT_CLASSES);
    preds.push((m) => set.has(weightClassForTonnage(m.tonnage)));
  }
  const ton = q.filters.get("ton");
  if (ton !== undefined) {
    const pred = numberFilter("ton", ton);
    preds.push((m) => pred(m.tonnage));
  }
  const tech = q.filters.get("tech");
  if (tech !== undefined) {
    const set = techFilter(tech);
    preds.push((m) => set.has(mechTech(m)));
  }
  const intro = q.filters.get("intro");
  if (intro !== undefined) {
    const pred = numberFilter("intro", intro);
    preds.push((m) => pred(m.intro));
  }
  const pack = q.filters.get("pack");
  if (pack !== undefined) {
    const set = choiceFilter("pack", pack, MECH_PACKS);
    preds.push((m) => set.has(m.pack.toLowerCase() as (typeof MECH_PACKS)[number]));
  }
  const sortRaw = q.filters.get("sort");
  const sort = sortRaw === undefined ? { by: "ton", desc: false } : sortFilter(sortRaw, MECH_SORTS);
  const list = entries.filter(
    (m) => textHit(q.text, m.model, m.name, m.clanName, m.callsign) && preds.every((p) => p(m)),
  );
  const byName = (a: MechManifestEntry, b: MechManifestEntry) =>
    a.name.localeCompare(b.name) || a.model.localeCompare(b.model);
  const cmp: (a: MechManifestEntry, b: MechManifestEntry) => number =
    sort.by === "name"
      ? byName
      : sort.by === "model"
        ? (a, b) => a.model.localeCompare(b.model)
        : sort.by === "intro"
          ? (a, b) => a.intro - b.intro || byName(a, b)
          : (a, b) => a.tonnage - b.tonnage || byName(a, b);
  return list.sort(sort.desc ? (a, b) => cmp(b, a) : cmp);
}

// -------------------------------------------------------------- weapons ----
export const WEAPON_FILTER_KEYS = ["cat", "tech", "heat", "range", "dmg", "sort"] as const;
const CATEGORIES: readonly WeaponCategory[] = ["BALLISTIC", "ENERGY", "MISSILE", "EQUIPMENT"];
const WEAPON_SORTS = ["cat", "name", "heat", "range", "dmg"] as const;

/** Clan weapons carry the catalog's `CL ` name prefix. */
export function weaponTech(w: WeaponDef): Tech {
  return w.name.startsWith("CL ") ? "clan" : "is";
}

/** Best-case damage: variable damage's best bracket, or a full missile salvo. */
export function weaponMaxDamage(w: WeaponDef): number {
  if (w.variableDamage) return Math.max(...w.variableDamage);
  if (w.missileDamage !== undefined && w.missiles !== undefined)
    return w.missileDamage * w.missiles;
  return w.damage ?? 0;
}

/** Filter + sort the weapon catalog (default order: catalog order). */
export function selectWeapons(entries: readonly WeaponDef[], q: ParsedQuery): WeaponDef[] {
  const preds: ((w: WeaponDef) => boolean)[] = [];
  const cat = q.filters.get("cat");
  if (cat !== undefined) {
    const set = choiceFilter("cat", cat, CATEGORIES);
    preds.push((w) => set.has(w.category));
  }
  const tech = q.filters.get("tech");
  if (tech !== undefined) {
    const set = techFilter(tech);
    preds.push((w) => set.has(weaponTech(w)));
  }
  const heat = q.filters.get("heat");
  if (heat !== undefined) {
    const pred = numberFilter("heat", heat);
    preds.push((w) => pred(w.heat ?? 0));
  }
  const range = q.filters.get("range");
  if (range !== undefined) {
    const pred = numberFilter("range", range);
    preds.push((w) => pred(w.long));
  }
  const dmg = q.filters.get("dmg");
  if (dmg !== undefined) {
    const pred = numberFilter("dmg", dmg);
    preds.push((w) => pred(weaponMaxDamage(w)));
  }
  const sortRaw = q.filters.get("sort");
  const sort =
    sortRaw === undefined ? { by: "cat", desc: false } : sortFilter(sortRaw, WEAPON_SORTS);
  const list = entries.filter((w) => textHit(q.text, w.name) && preds.every((p) => p(w)));
  if (sort.by === "cat") return sort.desc ? list.reverse() : list;
  const key = (w: WeaponDef): number =>
    sort.by === "heat" ? (w.heat ?? 0) : sort.by === "range" ? w.long : weaponMaxDamage(w);
  const cmp: (a: WeaponDef, b: WeaponDef) => number =
    sort.by === "name"
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => key(a) - key(b) || a.name.localeCompare(b.name);
  return list.sort(sort.desc ? (a, b) => cmp(b, a) : cmp);
}

// ------------------------------------------------------------- closest ----
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur.push(Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub));
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Up to `limit` names closest to `input` for "did you mean" errors: names
 * starting with the input first, then containing it, then by edit distance
 * (only those within half the input's length).
 */
export function closestNames(input: string, names: readonly string[], limit = 5): string[] {
  const needle = input.toLowerCase();
  const maxDist = Math.max(2, Math.ceil(needle.length / 2));
  return names
    .map((name) => {
      const lower = name.toLowerCase();
      const rank = lower.startsWith(needle) ? 0 : lower.includes(needle) ? 1 : 2;
      return { name, rank, dist: editDistance(needle, lower) };
    })
    .filter((c) => c.rank < 2 || c.dist <= maxDist)
    .sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((c) => c.name);
}

/** Unknown-model error naming the closest model keys, when any are close. */
export function unknownModelError(
  model: string,
  entries: readonly MechManifestEntry[] = catalogMechs(),
): Error {
  const closest = closestNames(
    model,
    entries.map((m) => m.model),
  );
  return new Error(
    closest.length > 0
      ? i18n("err.unknownModelClosest", { model, closest: closest.join(", ") })
      : i18n("err.unknownModel", { model }),
  );
}

/** Unknown-weapon error naming the closest weapon names, when any are close. */
export function unknownWeaponError(
  name: string,
  entries: readonly WeaponDef[] = allWeaponDefs(),
): Error {
  const closest = closestNames(
    name,
    entries.map((w) => w.name),
  );
  return new Error(
    closest.length > 0
      ? i18n("err.unknownWeaponClosest", { name, closest: closest.join(", ") })
      : i18n("err.unknownWeapon", { name }),
  );
}
