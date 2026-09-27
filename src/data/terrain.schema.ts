import { TERRAIN_TYPES, type TerrainType } from "../core/types";
import { TERRAIN_DATA } from "./terrain.data";

/**
 * Properties of a terrain type that drive the rules engine: movement cost
 * surcharge, screening value (LOS blocking), target to-hit modifier, and
 * optional flags for partial cover and targeting restriction.
 */
export interface TerrainDef {
  /** Additional MP surcharge on top of the base 1 MP to enter a hex. */
  readonly moveCost: number;
  /** LOS screening points: summed across intervening hexes; >= 3 blocks LOS. */
  readonly screeningValue: number;
  /** To-hit modifier when the target is inside this terrain hex. */
  readonly terrainMod: number;
  /** When true, units inside this terrain receive partial cover (+3 to-hit). */
  readonly partialCover?: boolean;
  /** When true, units cannot fire into or out of this terrain hex. */
  readonly blocksTargeting?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTerrainDef(raw: unknown, key: string, errors: string[]): TerrainDef | null {
  if (!isRecord(raw)) {
    errors.push(`${key} must be an object`);
    return null;
  }
  let valid = true;
  for (const numField of ["moveCost", "screeningValue", "terrainMod"]) {
    const v = raw[numField];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      errors.push(`${key}.${numField} must be an integer`);
      valid = false;
    }
  }
  for (const boolField of ["partialCover", "blocksTargeting"]) {
    const v = raw[boolField];
    if (v !== undefined && typeof v !== "boolean") {
      errors.push(`${key}.${boolField} must be a boolean when present`);
      valid = false;
    }
  }
  if (!valid) return null;
  const def: TerrainDef = {
    moveCost: raw.moveCost as number,
    screeningValue: raw.screeningValue as number,
    terrainMod: raw.terrainMod as number,
    ...(raw.partialCover === true ? { partialCover: true } : {}),
    ...(raw.blocksTargeting === true ? { blocksTargeting: true } : {}),
  };
  return def;
}

/**
 * Hand-rolled structural validator (zero-dependency policy).
 * Validates the terrain catalog JSON against {@link TerrainDef} and builds a
 * lookup map. Throws with all accumulated problems on bad data.
 */
export function parseTerrainData(data: unknown): ReadonlyMap<string, TerrainDef> {
  if (!isRecord(data)) {
    throw new Error("terrain catalog must be a JSON object");
  }
  const errors: string[] = [];
  const map = new Map<string, TerrainDef>();
  for (const key of Object.keys(data)) {
    if (!(TERRAIN_TYPES as readonly string[]).includes(key)) {
      errors.push(`unknown terrain key ${JSON.stringify(key)}`);
      continue;
    }
    const def = parseTerrainDef(data[key], key, errors);
    if (def !== null) map.set(key, def);
  }
  for (const t of TERRAIN_TYPES) {
    if (!map.has(t)) {
      errors.push(`missing catalog entry for terrain type ${JSON.stringify(t)}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid terrain catalog:\n  - ${errors.join("\n  - ")}`);
  }
  return map;
}

const TERRAIN_CATALOG: ReadonlyMap<string, TerrainDef> = TERRAIN_DATA;

export function terrainDef(type: TerrainType): TerrainDef | undefined {
  return TERRAIN_CATALOG.get(type);
}

export function allTerrainDefs(): ReadonlyMap<string, TerrainDef> {
  return TERRAIN_CATALOG;
}
