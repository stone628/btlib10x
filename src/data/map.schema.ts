import type { TerrainHexDef } from "../core/types";
import { isTerrainType, TERRAIN_TYPES, type TerrainType } from "../core/types";
import beginnerMap from "./maps/beginner";
import quickstartMap from "./maps/quickstart";
import testMap from "./maps/test";
import testgroundMap from "./maps/testground";

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

/** All battle maps shipped with the library, keyed by name; validated at load. */
export const MAP_DEFS: Readonly<Map<string, MapDef>> = new Map<string, MapDef>(
  [beginnerMap, quickstartMap, testMap, testgroundMap].map((m) => {
    return [m.name, loadMap(m)];
  }),
);

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
      const key = `${entry.col},${entry.row}`;
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
