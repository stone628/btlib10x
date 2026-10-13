import { decodeMapLine } from "./map.codec";
import type { MapDef } from "./map.schema";
import { mapDef, registerMap, registerMaps } from "./map.schema";
import { decodeMechLine, type MechIdentity, resolveStringRef } from "./mech.codec";
import type { ResolvedMechDef } from "./mech.schema";
import { mechDef, registerMech, registerMechs } from "./mech.schema";
import { decodeRelaxed } from "./relaxed-json";

/**
 * Unified catalogs: `data/btlib10x.jsonl` is the `base` pack and
 * `docs/mtf/sw/sw.jsonl` is the `sw` season pack. Each file keeps its own
 * line-0 string table (a bare JSON string array holding chassis names +
 * weapon names, first-seen pack order), its own line-1 manifest below, and
 * its own wire lines addressed by file-local line number. Each pack text is
 * held in memory once (fetch on web, file read in tests/dev); sheets decode
 * and register on demand, so heap cost is O(roster), not O(catalog).
 * Identity (`model`/`name`/`techBase`/`tonnage`/`intro`, plus optional
 * `clanName`/`callsign`) lives only in the manifest entry — the wire line
 * carries the crunch, and each sheet is single-sourced. Chassis `name`s
 * (manifest `n`) and weapon names (wire `w`) are numeric indices into the
 * entry's own pack table. Weight class is never stored — infer it with
 * `weightClassForTonnage`.
 *
 * Duplicate models across packs resolve as: `base` always loses to any
 * other pack, and among non-base packs the first loaded wins. The latter
 * entry is ignored with a warning (see `appendCatalog`).
 */
export interface MechManifestEntry extends MechIdentity {
  /** File-local line number of the sheet's wire line (lines 0-1 are table + manifest). */
  readonly line: number;
  /** Pack id of the file that carries this entry (`base`, `sw`, …). */
  readonly pack: string;
}

export interface MapManifestEntry {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** File-local line number of the map's wire line (lines 0-1 are table + manifest). */
  readonly line: number;
  /** Pack id of the file that carries this entry (`base`, `sw`, …). */
  readonly pack: string;
}

/** Line-1 manifest shape; `version` gates the whole catalog format. */
export interface CatalogManifest {
  readonly version: 1;
  readonly mechs: readonly MechManifestEntry[];
  readonly maps: readonly MapManifestEntry[];
  readonly strings: CatalogStringTable;
}

/** Line-0 string table: chassis names + weapon names, first-seen pack order. */
export type CatalogStringTable = readonly string[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const CODE_TECHBASE: Readonly<Record<string, string>> = {
  "1": "Inner Sphere",
  "2": "Clan",
};

/**
 * Validate an untrusted string-table payload (parsed JSONL line 0) and
 * return it typed. Throws on any shape mismatch.
 */
export function parseCatalogStrings(raw: unknown): CatalogStringTable {
  if (!Array.isArray(raw)) throw new Error("Invalid catalog strings: expected an array");
  for (const [i, s] of raw.entries()) {
    if (typeof s !== "string" || s.length === 0) {
      throw new Error(`Invalid catalog strings: [${i}] must be a non-empty string`);
    }
  }
  return raw as string[];
}

/**
 * Validate an untrusted catalog manifest payload (parsed JSONL line 1) and
 * return it typed, resolving chassis-name numeric indices against
 * `strings` and tagging every entry with `pack` (the id of the file being
 * loaded — never part of the wire format). Throws on any shape mismatch.
 */
export function parseCatalogManifest(
  raw: unknown,
  strings: CatalogStringTable = [],
  pack = "base",
): CatalogManifest {
  if (!isRecord(raw)) throw new Error("Invalid catalog manifest: expected an object");
  if (raw.v !== 1) {
    throw new Error(`Invalid catalog manifest: unsupported version ${String(raw.v)}`);
  }
  const mechs = raw.mechs;
  const maps = raw.maps;
  if (!Array.isArray(mechs)) throw new Error("Invalid catalog manifest: mechs must be an array");
  if (!Array.isArray(maps)) throw new Error("Invalid catalog manifest: maps must be an array");
  const seenModels = new Set<string>();
  const mechEntries: MechManifestEntry[] = mechs.map((raw, i) => {
    const label = `mechs[${i}]`;
    if (!isRecord(raw)) throw new Error(`Invalid catalog manifest: ${label} must be an object`);
    const {
      m: model,
      n: rawName,
      b: techBase,
      t: tonnage,
      i: intro,
      c: clanName,
      k: callsign,
      l: line,
    } = raw;
    if (typeof model !== "string" || model.length === 0)
      throw new Error(`Invalid catalog manifest: ${label}.model must be a non-empty string`);
    if (typeof rawName !== "number")
      throw new Error(`Invalid catalog manifest: ${label}.name must be a string-table index`);
    const name = resolveStringRef(strings, rawName, `${label}.name`);
    if (typeof techBase !== "number" || (techBase as number) === 0)
      throw new Error(`Invalid catalog manifest: ${label}.techBase must be 1 or 2`);
    if (!Number.isInteger(tonnage))
      throw new Error(`Invalid catalog manifest: ${label}.tonnage must be an integer`);
    if (!Number.isInteger(intro))
      throw new Error(`Invalid catalog manifest: ${label}.intro must be an integer`);
    if (clanName !== undefined && (typeof clanName !== "string" || clanName.length === 0))
      throw new Error(`Invalid catalog manifest: ${label}.clanName must be a non-empty string`);
    if (callsign !== undefined && (typeof callsign !== "string" || callsign.length === 0))
      throw new Error(`Invalid catalog manifest: ${label}.callsign must be a non-empty string`);
    if (!Number.isInteger(line) || (line as number) < 2)
      throw new Error(`Invalid catalog manifest: ${label}.line must be an integer >= 2`);
    const key = model.toLowerCase();
    if (seenModels.has(key)) throw new Error(`Invalid catalog manifest: duplicate model ${model}`);
    seenModels.add(key);
    return {
      model,
      name,
      techBase: CODE_TECHBASE[`${techBase}`] ?? "Unknown",
      tonnage: tonnage as number,
      intro: intro as number,
      ...(clanName !== undefined && { clanName: clanName as string }),
      ...(callsign !== undefined && { callsign: callsign as string }),
      line: line as number,
      pack,
    };
  });
  const seenMaps = new Set<string>();
  const mapEntries: MapManifestEntry[] = maps.map((raw, i) => {
    const label = `maps[${i}]`;
    if (!isRecord(raw)) throw new Error(`Invalid catalog manifest: ${label} must be an object`);
    const { n: name, w: width, h: height, l: line } = raw;
    if (typeof name !== "string" || name.length === 0)
      throw new Error(`Invalid catalog manifest: ${label}.name must be a non-empty string`);
    if (!Number.isInteger(width) || (width as number) <= 0)
      throw new Error(`Invalid catalog manifest: ${label}.width must be a positive integer`);
    if (!Number.isInteger(height) || (height as number) <= 0)
      throw new Error(`Invalid catalog manifest: ${label}.height must be a positive integer`);
    if (!Number.isInteger(line) || (line as number) < 2)
      throw new Error(`Invalid catalog manifest: ${label}.line must be an integer >= 2`);
    if (seenMaps.has(name)) throw new Error(`Invalid catalog manifest: duplicate map ${name}`);
    seenMaps.add(name);
    return {
      name,
      width: width as number,
      height: height as number,
      line: line as number,
      pack,
    };
  });
  return { version: 1, mechs: mechEntries, maps: mapEntries, strings };
}

export { decodeMapLine, decodeMechLine };

// --- in-memory catalog stores (one text per pack, decoded on demand) ---

interface PackStore {
  readonly lines: readonly string[];
  readonly strings: CatalogStringTable;
}

const PACKS: Map<string, PackStore> = new Map<string, PackStore>();
const ID_TO_MECH: Map<string, MechManifestEntry> = new Map<string, MechManifestEntry>();
const LOWER_ID_TO_MECH: Map<string, MechManifestEntry> = new Map<string, MechManifestEntry>();
const ID_TO_MAP: Map<string, MapManifestEntry> = new Map<string, MapManifestEntry>();
const LOWER_ID_TO_MAP: Map<string, MapManifestEntry> = new Map<string, MapManifestEntry>();

function resetCatalogStore(): void {
  PACKS.clear();
  ID_TO_MECH.clear();
  LOWER_ID_TO_MECH.clear();
  ID_TO_MAP.clear();
  LOWER_ID_TO_MAP.clear();
}

/**
 * Merge one mech entry into the lookup maps. `base` always loses to any
 * other pack; among non-base packs the first loaded wins. A same-pack
 * reload replaces silently; any other collision warns through `onWarning`
 * and keeps exactly one entry per model.
 */
function mergeMechEntry(entry: MechManifestEntry, onWarning: (message: string) => void): void {
  const key = entry.model.toLowerCase();
  const existing = LOWER_ID_TO_MECH.get(key);
  if (existing === undefined || existing.pack === entry.pack) {
    if (existing !== undefined) ID_TO_MECH.delete(existing.model);
    ID_TO_MECH.set(entry.model, entry);
    LOWER_ID_TO_MECH.set(key, entry);
    return;
  }
  if (existing.pack === "base" && entry.pack !== "base") {
    ID_TO_MECH.delete(existing.model);
    ID_TO_MECH.set(entry.model, entry);
    LOWER_ID_TO_MECH.set(key, entry);
    // onWarning(`Duplicate model ${entry.model}: base entry replaced by "${entry.pack}" entry`);
    return;
  }
  onWarning(
    `Duplicate model ${entry.model}: kept "${existing.pack}" entry, ignored "${entry.pack}" entry`,
  );
}

/** Same merge rule as mechs, keyed on map name. */
function mergeMapEntry(entry: MapManifestEntry, onWarning: (message: string) => void): void {
  const key = entry.name.toLowerCase();
  const existing = LOWER_ID_TO_MAP.get(key);
  if (existing === undefined || existing.pack === entry.pack) {
    if (existing !== undefined) ID_TO_MAP.delete(existing.name);
    ID_TO_MAP.set(entry.name, entry);
    LOWER_ID_TO_MAP.set(key, entry);
    return;
  }
  if (existing.pack === "base" && entry.pack !== "base") {
    ID_TO_MAP.delete(existing.name);
    ID_TO_MAP.set(entry.name, entry);
    LOWER_ID_TO_MAP.set(key, entry);
    onWarning(`Duplicate map ${entry.name}: base entry replaced by "${entry.pack}" entry`);
    return;
  }
  onWarning(
    `Duplicate map ${entry.name}: kept "${existing.pack}" entry, ignored "${entry.pack}" entry`,
  );
}

function ingestCatalog(
  text: string,
  pack: string,
  onWarning: (message: string) => void,
): CatalogManifest {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2) throw new Error("Invalid catalog: expected a string table and a manifest");
  const first = lines[0];
  const second = lines[1];
  if (first === undefined || second === undefined)
    throw new Error("Invalid catalog: missing lines");
  const strings = parseCatalogStrings(JSON.parse(first));
  const manifest = parseCatalogManifest(decodeRelaxed(second), strings, pack);
  for (const entry of [...manifest.mechs, ...manifest.maps]) {
    if (entry.line >= lines.length) {
      throw new Error(`Invalid catalog: entry line ${entry.line} out of range`);
    }
  }
  lines[0] = "";
  lines[1] = "";
  PACKS.set(pack, { lines, strings });
  for (const entry of manifest.mechs) mergeMechEntry(entry, onWarning);
  for (const entry of manifest.maps) mergeMapEntry(entry, onWarning);
  return manifest;
}

/**
 * Load a catalog text (fetched on web, read from disk in dev/tests) into
 * the module store, discarding any previously loaded packs. Synchronous;
 * call once before the ensure helpers. Line 0 is the string table (bare
 * JSON string array), line 1 the manifest. Returns the parsed manifest.
 */
export function loadCatalog(text: string, pack = "base"): CatalogManifest {
  resetCatalogStore();
  return ingestCatalog(text, pack, () => {});
}

/**
 * Load one more catalog pack (e.g. the `sw` season pack) beside the packs
 * already in the store. Each pack keeps its own string table; wire lines
 * always resolve against their own pack's table. Cross-pack duplicates
 * warn through `onWarning` (default `console.warn`): `base` always loses,
 * and among other packs the first loaded wins. Returns the parsed
 * manifest.
 */
export function appendCatalog(
  text: string,
  pack: string,
  onWarning: (message: string) => void = console.warn,
): CatalogManifest {
  return ingestCatalog(text, pack, onWarning);
}

function packStore(pack: string): PackStore {
  const store = PACKS.get(pack);
  if (store === undefined) throw new Error(`Catalog pack not loaded: ${pack}`);
  return store;
}

function catalogLine(entry: { pack: string; line: number }): string {
  const line = packStore(entry.pack).lines[entry.line];
  if (line === undefined) throw new Error(`Invalid catalog: line ${entry.line} out of range`);
  return line;
}

export function findMechEntry(model: string): MechManifestEntry | undefined {
  return LOWER_ID_TO_MECH.get(model.toLowerCase());
}

export function catalogMechs(): MechManifestEntry[] {
  if (PACKS.size === 0) throw new Error("Catalog not loaded: call loadCatalog first");
  return Array.from(ID_TO_MECH.values());
}

export function catalogMaps(): MapManifestEntry[] {
  if (PACKS.size === 0) throw new Error("Catalog not loaded: call loadCatalog first");
  return Array.from(ID_TO_MAP.values());
}

/**
 * Decode and register the catalog sheet for `model` unless the registry
 * already holds it. Returns the resolved def, or undefined when the
 * catalog knows no such model. Synchronous; requires `loadCatalog` first
 * (except when the registry already holds an exact-case match).
 */
export function ensureMechRegistered(model: string): ResolvedMechDef | undefined {
  const known = mechDef(model);
  if (known !== undefined) return known;
  const entry = LOWER_ID_TO_MECH.get(model.toLowerCase());
  if (entry === undefined) return undefined;
  // Case-insensitive manifest hit: the registry may hold it under canonical
  // case (registerMech throws on duplicates — never re-register blindly).
  const canonical = mechDef(entry.model);
  if (canonical !== undefined) return canonical;
  return registerMech(decodeMechLine(catalogLine(entry), entry, packStore(entry.pack).strings));
}

export function findMapEntry(name: string): MapManifestEntry | undefined {
  return LOWER_ID_TO_MAP.get(name.toLowerCase());
}

/**
 * Decode and register the catalog map for `name` unless the registry
 * already holds it. Returns the def, or undefined for unknown names.
 * Synchronous; requires `loadCatalog` first.
 */
export function ensureMapRegistered(name: string): MapDef | undefined {
  const known = mapDef(name);
  if (known !== undefined) return known;
  const entry = LOWER_ID_TO_MAP.get(name.toLowerCase());
  if (entry === undefined) return undefined;
  return registerMap(decodeMapLine(catalogLine(entry), entry));
}

/**
 * Register every catalog sheet (mechs + maps). Test/dev convenience —
 * production paths register on demand via the ensure helpers instead.
 */
export function registerAllCatalog(): void {
  registerMechs(
    Array.from(ID_TO_MECH.values()).map((entry) =>
      decodeMechLine(catalogLine(entry), entry, packStore(entry.pack).strings),
    ),
  );
  registerMaps(
    Array.from(ID_TO_MAP.values()).map((entry) => decodeMapLine(catalogLine(entry), entry)),
  );
}
