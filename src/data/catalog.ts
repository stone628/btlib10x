import { decodeMapLine } from "./map.codec";
import type { MapDef } from "./map.schema";
import { mapDef, registerMap, registerMaps } from "./map.schema";
import { decodeMechLine, type MechIdentity } from "./mech.codec";
import type { ResolvedMechDef } from "./mech.schema";
import { mechDef, registerMech, registerMechs } from "./mech.schema";

/**
 * Unified catalog (`data/btlib10x.jsonl`): line 0 is the manifest below,
 * the remaining lines are packed 'Mech and map wire lines addressed by
 * absolute file line number. The whole text is held in memory once (fetch
 * on web, file read in tests/dev); sheets decode and register on demand,
 * so heap cost is O(roster), not O(catalog). Identity
 * (`model`/`name`/`techBase`/`tonnage`) lives only in the manifest entry —
 * the wire line carries the crunch, and each sheet is single-sourced.
 * Weight class is never stored — infer it with `weightClassForTonnage`.
 */
export interface MechManifestEntry extends MechIdentity {
  /** Absolute file line number of the sheet's wire line (line 0 is the manifest). */
  readonly line: number;
}

export interface MapManifestEntry {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Absolute file line number of the map's wire line (line 0 is the manifest). */
  readonly line: number;
}

/** Line-0 manifest shape; `version` gates the whole catalog format. */
export interface CatalogManifest {
  readonly version: 1;
  readonly mechs: readonly MechManifestEntry[];
  readonly maps: readonly MapManifestEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const CODE_TECHBASE: Readonly<Record<string, string>> = {
  "1": "Inner Sphere",
  "2": "Clan",
};

/**
 * Validate an untrusted catalog manifest payload (parsed JSONL line 0) and
 * return it typed. Throws on any shape mismatch.
 */
export function parseCatalogManifest(raw: unknown): CatalogManifest {
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
    const { m: model, n: name, b: techBase, t: tonnage, c: clanName, l: line } = raw;
    if (typeof model !== "string" || model.length === 0)
      throw new Error(`Invalid catalog manifest: ${label}.model must be a non-empty string`);
    if (typeof name !== "string" || name.length === 0)
      throw new Error(`Invalid catalog manifest: ${label}.name must be a non-empty string`);
    if (typeof techBase !== "number" || (techBase as number) === 0)
      throw new Error(`Invalid catalog manifest: ${label}.techBase must be 1 or 2`);
    if (!Number.isInteger(tonnage))
      throw new Error(`Invalid catalog manifest: ${label}.tonnage must be an integer`);
    if (clanName !== undefined && (typeof clanName !== "string" || clanName.length === 0))
      throw new Error(`Invalid catalog manifest: ${label}.clanName must be a non-empty string`);
    if (!Number.isInteger(line) || (line as number) <= 0)
      throw new Error(`Invalid catalog manifest: ${label}.line must be a positive integer`);
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
    if (!Number.isInteger(line) || (line as number) <= 0)
      throw new Error(`Invalid catalog manifest: ${label}.line must be a positive integer`);
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

/**
 * Load a catalog text (fetched on web, read from disk in dev/tests) into
 * the module store. Synchronous; call once before the ensure helpers.
 * Returns the parsed manifest.
 */
export function loadCatalog(text: string): CatalogManifest {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const first = lines[0];
  if (first === undefined) throw new Error("Invalid catalog: empty file");
  const manifest = parseCatalogManifest(JSON.parse(first));
  for (const entry of [...manifest.mechs, ...manifest.maps]) {
    if (entry.line >= lines.length) {
      throw new Error(`Invalid catalog: entry line ${entry.line} out of range`);
    }
  }
  CATALOG_LINES = lines;
  CATALOG = manifest;
  return manifest;
}

/** The loaded manifest; throws when `loadCatalog` has not run yet. */
export function catalogManifest(): CatalogManifest {
  if (CATALOG === null) throw new Error("Catalog not loaded: call loadCatalog first");
  return CATALOG;
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
  return registerMech(decodeMechLine(catalogLine(entry.line), entry));
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
  registerMechs(manifest.mechs.map((entry) => decodeMechLine(catalogLine(entry.line), entry)));
  registerMaps(manifest.maps.map((entry) => decodeMapLine(catalogLine(entry.line))));
}
