import type { TerrainHexDef } from "../core/types";
import { hexKey, isTerrainType, TERRAIN_TYPES, type TerrainType } from "../core/types";

export interface MapDefSrc {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly TerrainHexDef[];
}

/**
 * Static definition of a battle map: board dimensions plus every non-clear
 * terrain hex. Map coordinates are 1-based, matching the printed mapsheet
 * labels (cols 1..width, rows 1..height) and the engine's internal hex
 * coordinates. Hexes not listed are clear ground. The engine accepts the
 * map definition directly (no conversion layer).
 */
export interface MapDef {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly TerrainHexDef[];
  readonly legends: readonly TerrainType[];
}

/**
 * Battle-map lookup helpers backed by a registry that starts empty.
 * Canonical map sources live in `data/maps/*.json` and ship packed in the
 * unified catalog (`data/btlib10x.jsonl`); call `registerMaps`,
 * `registerMap`, or the catalog loader before using the lookups.
 */
let MAP_REGISTRY = new Map<string, MapDef>();

/**
 * Validate raw map sources and load them into the lookup registry,
 * replacing any previous contents.
 */
export function registerMaps(srcs: readonly MapDefSrc[]): void {
  const next = new Map<string, MapDef>();
  for (const src of srcs) {
    if (next.has(src.name)) {
      throw new Error(`Duplicate map name ${JSON.stringify(src.name)}`);
    }
    next.set(src.name, loadMap(src));
  }
  MAP_REGISTRY = next;
}

/**
 * Validate one raw map source and add it to the lookup registry, keeping
 * any previously registered maps. Prefer this over `registerMaps` when only
 * the roster's map is needed. Throws on a duplicate name.
 */
export function registerMap(src: MapDefSrc): MapDef {
  if (MAP_REGISTRY.has(src.name)) {
    throw new Error(`Duplicate map name ${JSON.stringify(src.name)}`);
  }
  const def = loadMap(src);
  MAP_REGISTRY.set(def.name, def);
  return def;
}

export interface MapNameHolder {
  readonly mapName: string | null;
}

export function mapDefFor(h: MapNameHolder): MapDef {
  const key = h.mapName;
  if (key === null) throw new Error("Unknown map: <none>");
  const def = MAP_REGISTRY.get(key);
  if (!def) throw new Error(`Unknown map: ${key}`);
  return def;
}

export function mapDef(name: string): MapDef | undefined {
  return MAP_REGISTRY.get(name);
}

export function registeredMapDefs(): MapDef[] {
  return Array.from(MAP_REGISTRY.values());
}

export function listMapNames(): string[] {
  return Array.from(MAP_REGISTRY.keys());
}

function loadMap(src: MapDefSrc): MapDef {
  validateMapDef(src);
  const legends = [...new Set(src.terrain.map((h) => h.type))];
  return { ...src, legends };
}

/**
 * Validate a typed MapDef against board rules. TypeScript enforces the
 * structural shape at compile time; this catches runtime logical
 * inconsistencies (board bounds, duplicate hexes, terrain types).
 */
export function validateMapDef(def: MapDefSrc): void {
  const errors: string[] = [];
  const { width, height } = def;

  if (!Number.isInteger(width) || width <= 0) {
    errors.push("width must be a positive integer");
  }
  if (!Number.isInteger(height) || height <= 0) {
    errors.push("height must be a positive integer");
  }

  const seen = new Set<string>();
  for (const [i, entry] of def.terrain.entries()) {
    const label = `terrain[${i}]`;
    if (!Number.isInteger(entry.col)) {
      errors.push(`${label}.col must be an integer`);
    }
    if (!Number.isInteger(entry.row)) {
      errors.push(`${label}.row must be an integer`);
    }
    if (!isTerrainType(entry.type)) {
      errors.push(
        `${label}.type ${JSON.stringify(entry.type)} is not one of ${TERRAIN_TYPES.join("|")}`,
      );
    }
    if (entry.level !== undefined && (!Number.isInteger(entry.level) || entry.level < 0)) {
      errors.push(`${label}.level must be a non-negative integer when present`);
    }
    if (Number.isInteger(entry.col) && Number.isInteger(entry.row)) {
      if (entry.col < 1 || entry.col > width) {
        errors.push(`${label}.col ${entry.col} outside board bounds 1..${width}`);
      }
      if (entry.row < 1 || entry.row > height) {
        errors.push(`${label}.row ${entry.row} outside board bounds 1..${height}`);
      }
      const key = hexKey(entry);
      if (seen.has(key)) {
        errors.push(`${label} duplicates hex ${key}`);
      } else {
        seen.add(key);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid MapDef:\n  - ${errors.join("\n  - ")}`);
  }
}
