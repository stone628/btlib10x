import { decodeMapLine } from "./map.codec";
import type { MapDef } from "./map.schema";
import { mapDef, registerMap, registerMaps } from "./map.schema";
import { decodeMechLine, type MechIdentity, resolveStringRef } from "./mech.codec";
import type { ResolvedMechDef } from "./mech.schema";
import { mechDef, registerMech, registerMechs } from "./mech.schema";

/**
 * Unified catalog (`data/btlib10x.jsonl`): line 0 is the string table (a
 * bare JSON string array holding chassis names + weapon names, first-seen
 * pack order), line 1 is the manifest below, and the remaining lines are
 * packed 'Mech and map wire lines addressed by absolute file line number.
 * The whole text is held in memory once (fetch on web, file read in
 * tests/dev); sheets decode and register on demand, so heap cost is
 * O(roster), not O(catalog). Identity
 * (`model`/`name`/`techBase`/`tonnage`) lives only in the manifest entry —
 * the wire line carries the crunch, and each sheet is single-sourced.
 * Chassis `name`s (manifest `n`) and weapon names (wire `w`) are
 * `$<index>` refs into the line-0 table. Weight class is never stored —
 * infer it with `weightClassForTonnage`.
 */
export interface MechManifestEntry extends MechIdentity {
  /** Absolute file line number of the sheet's wire line (lines 0-1 are table + manifest). */
  readonly line: number;
}

export interface MapManifestEntry {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Absolute file line number of the map's wire line (lines 0-1 are table + manifest). */
  readonly line: number;
}

/** Line-1 manifest shape; `version` gates the whole catalog format. */
export interface CatalogManifest {
  readonly version: 1;
  readonly mechs: readonly MechManifestEntry[];
  readonly maps: readonly MapManifestEntry[];
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
 * return it typed, resolving chassis-name `$<index>` refs against
 * `strings`. Verbatim names still parse. Throws on any shape mismatch.
 */
export function parseCatalogManifest(
  raw: unknown,
  strings: CatalogStringTable = [],
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
    const { m: model, n: rawName, b: techBase, t: tonnage, c: clanName, l: line } = raw;
    if (typeof model !== "string" || model.length === 0)
      throw new Error(`Invalid catalog manifest: ${label}.model must be a non-empty string`);
    if (typeof rawName !== "string" || rawName.length === 0)
      throw new Error(`Invalid catalog manifest: ${label}.name must be a non-empty string`);
    const name = resolveStringRef(strings, rawName, `${label}.name`);
    if (typeof techBase !== "number" || (techBase as number) === 0)
      throw new Error(`Invalid catalog manifest: ${label}.techBase must be 1 or 2`);
    if (!Number.isInteger(tonnage))
      throw new Error(`Invalid catalog manifest: ${label}.tonnage must be an integer`);
    if (clanName !== undefined && (typeof clanName !== "string" || clanName.length === 0))
      throw new Error(`Invalid catalog manifest: ${label}.clanName must be a non-empty string`);
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
      ...(clanName !== undefined && { clanName: clanName as string }),
      line: line as number,
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
    };
  });
  return { version: 1, mechs: mechEntries, maps: mapEntries };
}

/** Case-insensitive manifest lookup; returns undefined for unknown models. */
export function findMechEntry(
  manifest: CatalogManifest,
  model: string,
): MechManifestEntry | undefined {
  const want = model.toLowerCase();
  return manifest.mechs.find((e) => e.model.toLowerCase() === want);
}

/** Exact-name manifest lookup; returns undefined for unknown maps. */
export function findMapEntry(
  manifest: CatalogManifest,
  name: string,
): MapManifestEntry | undefined {
  return manifest.maps.find((e) => e.name === name);
}

export { decodeMapLine, decodeMechLine };

// --- in-memory catalog store (one text, decoded on demand) ---

let CATALOG_LINES: readonly string[] | null = null;
let CATALOG: CatalogManifest | null = null;
let CATALOG_STRINGS: CatalogStringTable = [];

/**
 * Load a catalog text (fetched on web, read from disk in dev/tests) into
 * the module store. Synchronous; call once before the ensure helpers.
 * Line 0 is the string table (bare JSON string array), line 1 the
 * manifest. Returns the parsed manifest.
 */
export function loadCatalog(text: string): CatalogManifest {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2) throw new Error("Invalid catalog: expected a string table and a manifest");
  const first = lines[0];
  const second = lines[1];
  if (first === undefined || second === undefined)
    throw new Error("Invalid catalog: missing lines");
  const strings = parseCatalogStrings(JSON.parse(first));
  const manifest = parseCatalogManifest(JSON.parse(second), strings);
  for (const entry of [...manifest.mechs, ...manifest.maps]) {
    if (entry.line >= lines.length) {
      throw new Error(`Invalid catalog: entry line ${entry.line} out of range`);
    }
  }
  CATALOG_LINES = lines;
  CATALOG = manifest;
  CATALOG_STRINGS = strings;
  return manifest;
}

/** The loaded manifest; throws when `loadCatalog` has not run yet. */
export function catalogManifest(): CatalogManifest {
  if (CATALOG === null) throw new Error("Catalog not loaded: call loadCatalog first");
  return CATALOG;
}

/** The loaded line-0 string table; throws when `loadCatalog` has not run yet. */
export function catalogStrings(): CatalogStringTable {
  if (CATALOG === null) throw new Error("Catalog not loaded: call loadCatalog first");
  return CATALOG_STRINGS;
}

function catalogLine(n: number): string {
  if (CATALOG_LINES === null) throw new Error("Catalog not loaded: call loadCatalog first");
  const line = CATALOG_LINES[n];
  if (line === undefined) throw new Error(`Invalid catalog: line ${n} out of range`);
  return line;
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
  const manifest = catalogManifest();
  const entry = findMechEntry(manifest, model);
  if (entry === undefined) return undefined;
  // Case-insensitive manifest hit: the registry may hold it under canonical
  // case (registerMech throws on duplicates — never re-register blindly).
  const canonical = mechDef(entry.model);
  if (canonical !== undefined) return canonical;
  return registerMech(decodeMechLine(catalogLine(entry.line), entry, catalogStrings()));
}

/**
 * Decode and register the catalog map for `name` unless the registry
 * already holds it. Returns the def, or undefined for unknown names.
 * Synchronous; requires `loadCatalog` first.
 */
export function ensureMapRegistered(name: string): MapDef | undefined {
  const known = mapDef(name);
  if (known !== undefined) return known;
  const manifest = catalogManifest();
  const entry = findMapEntry(manifest, name);
  if (entry === undefined) return undefined;
  return registerMap(decodeMapLine(catalogLine(entry.line)));
}

/**
 * Register every catalog sheet (mechs + maps). Test/dev convenience —
 * production paths register on demand via the ensure helpers instead.
 */
export function registerAllCatalog(): void {
  const manifest = catalogManifest();
  const strings = catalogStrings();
  registerMechs(
    manifest.mechs.map((entry) => decodeMechLine(catalogLine(entry.line), entry, strings)),
  );
  registerMaps(manifest.maps.map((entry) => decodeMapLine(catalogLine(entry.line))));
}
