import type { HexCell, HexCoord, TerrainType } from "./types.js";

/** Per-level MP cost to climb to a higher ground elevation. */
export const MP_PER_LEVEL_CLIMB = 1;

/** Default cell returned for out-of-bounds coordinates. */
const DEFAULT_CELL: Readonly<HexCell> = { terrain: "clear", level: 0 };

export interface HexGrid {
  readonly cells: readonly HexCell[];
  readonly width: number;
  readonly height: number;
}

/** Look up the cell at `hex`; returns a default clear/level-0 cell for out-of-bounds coords. */
export function cellAt(grid: HexGrid, hex: HexCoord): HexCell {
  const { col, row } = hex;
  if (col < 1 || col > grid.width || row < 1 || row > grid.height) {
    return DEFAULT_CELL as HexCell;
  }
  return grid.cells[col - 1 + (row - 1) * grid.width]!;
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
