import type { TerrainHexDef } from "../core/types.js";
import { isTerrainType, TERRAIN_TYPES } from "../core/types.js";

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Hand-rolled structural validator (zero-dependency policy).
 * Throws with all accumulated problems when `data` is not a valid MapDef.
 */
export function validateMapDef(data: unknown): MapDef {
  const errors: string[] = [];
  if (!isRecord(data)) {
    throw new Error("MapDef must be a JSON object");
  }

  const width = data.width;
  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
    errors.push("width must be a positive integer");
  }
  const height = data.height;
  if (typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
    errors.push("height must be a positive integer");
  }

  const seen = new Set<string>();
  const raw = data.terrain;
  if (!Array.isArray(raw)) {
    errors.push("terrain must be an array");
  } else {
    for (const [i, entry] of raw.entries()) {
      const label = `terrain[${i}]`;
      if (!isRecord(entry)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      const col = entry.col;
      const row = entry.row;
      const type = entry.type;
      if (typeof col !== "number" || !Number.isInteger(col)) {
        errors.push(`${label}.col must be an integer`);
      }
      if (typeof row !== "number" || !Number.isInteger(row)) {
        errors.push(`${label}.row must be an integer`);
      }
      if (!isTerrainType(type)) {
        errors.push(
          `${label}.type ${JSON.stringify(type)} is not one of ${TERRAIN_TYPES.join("|")}`,
        );
      }
      const level = entry.level;
      if (
        level !== undefined &&
        (typeof level !== "number" || !Number.isInteger(level) || level < 0)
      ) {
        errors.push(`${label}.level must be a non-negative integer when present`);
      }
      if (
        typeof col === "number" &&
        typeof row === "number" &&
        typeof width === "number" &&
        typeof height === "number"
      ) {
        if (col < 1 || col > width) {
          errors.push(`${label}.col ${col} outside board bounds 1..${width}`);
        }
        if (row < 1 || row > height) {
          errors.push(`${label}.row ${row} outside board bounds 1..${height}`);
        }
        const key = `${col},${row}`;
        if (seen.has(key)) {
          errors.push(`${label} duplicates hex ${key}`);
        } else {
          seen.add(key);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid MapDef:\n  - ${errors.join("\n  - ")}`);
  }

  return data as unknown as MapDef;
}
