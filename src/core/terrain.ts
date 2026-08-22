import type { TerrainType } from "./types.js";

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
