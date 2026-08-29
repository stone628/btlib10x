import type { Hex, TerrainType } from "./types.js";

/** Default ground elevation when no level is recorded. */
export const DEFAULT_LEVEL = 0;

/** Default per-level MP cost to climb to a higher ground elevation. */
export const MP_PER_LEVEL_CLIMB = 1;

/** Ground level of `hex` from a per-hex elevation map; missing entries are level 0. */
export function levelAt(elevation: Readonly<Record<string, number>>, hex: Hex): number {
  return elevation[`${hex.col},${hex.row}`] ?? DEFAULT_LEVEL;
}

export const MP_TO_ENTER_HEX = 1;

export function terrainMoveCost(terrain: TerrainType): number {
  switch (terrain) {
    case "clear":
      return 0;
    case "lightWoods":
      return 1;
    case "heavyWoods":
      return 2;
  }
}

/** Total MP to enter a hex of the given terrain (base entry + terrain surcharge). */
export function costToEnter(terrain: TerrainType): number {
  return MP_TO_ENTER_HEX + terrainMoveCost(terrain);
}

/** Extra MP to climb from `fromLevel` to `toLevel`; negative deltas are free. */
export function costToClimb(fromLevel: number, toLevel: number): number {
  return Math.max(0, toLevel - fromLevel) * MP_PER_LEVEL_CLIMB;
}

export const MP_PER_FACING_CHANGE = 1;

/** Woods points for LOS blocking/terrain modifiers: Light=1, Heavy=2. */
export function woodsPoints(terrain: TerrainType): number {
  switch (terrain) {
    case "clear":
      return 0;
    case "lightWoods":
      return 1;
    case "heavyWoods":
      return 2;
  }
}

export interface TerrainMap {
  /** Terrain for every non-clear hex; missing entries are clear. */
  get(hexCol: number, hexRow: number): TerrainType | undefined;
}
