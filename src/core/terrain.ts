import { terrainDef } from "../data/terrain.schema";
import type { HexCell, HexCoord, TerrainType } from "./types";

/** Per-level MP cost to change elevation (up or down). */
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

/** Replace the cell at `hex` with a new value. Mutates the grid in place. */
export function setCell(grid: HexGrid, hex: HexCoord, cell: HexCell): void {
  const { col, row } = hex;
  if (col < 1 || col > grid.width || row < 1 || row > grid.height) return;
  (grid.cells as HexCell[])[col - 1 + (row - 1) * grid.width] = cell;
}

export const MP_TO_ENTER_HEX = 1;

export function terrainMoveCost(terrain: TerrainType): number {
  return terrainDef(terrain).moveCost ?? 0;
}

/** Total MP to enter a hex of the given terrain (base entry + terrain surcharge). */
export function costToEnter(terrain: TerrainType): number {
  return MP_TO_ENTER_HEX + terrainMoveCost(terrain);
}

/** Extra MP to change level from `fromLevel` to `toLevel`; costs both ways (TW). */
export function costToClimb(fromLevel: number, toLevel: number): number {
  return Math.abs(toLevel - fromLevel) * MP_PER_LEVEL_CLIMB;
}

export const MP_PER_FACING_CHANGE = 1;

/** Screening points for LOS blocking: summed across intervening hexes; >= 3 blocks LOS. */
export function screeningPoints(terrain: TerrainType): number {
  return terrainDef(terrain).screeningValue;
}

/** To-hit modifier when the target is inside a hex of the given terrain. */
export function terrainTargetMod(terrain: TerrainType): number {
  return terrainDef(terrain).terrainMod;
}

/** True when units inside this terrain type receive partial cover. */
export function hasPartialCover(terrain: TerrainType): boolean {
  return terrainDef(terrain).partialCover === true;
}

/** True when units cannot fire into or out of this terrain type. */
export function blocksTargeting(terrain: TerrainType): boolean {
  return terrainDef(terrain).blocksTargeting === true;
}

export function waterDepth(terrain: TerrainType): number {
  return terrainDef(terrain).waterDepth;
}

export function ejectionLandingMod(terrain: TerrainType, level: number): number {
  return terrainDef(terrain).ejectLandMod(level);
}

/**
 * Level a ground unit stands at in `hex`: the hex level, minus water depth
 * (a water hex has a surface at its level and a bed `depth` levels below,
 * TW p.32). Movement level changes (TW p.48-49) measure these.
 */
export function groundLevel(grid: HexGrid, hex: HexCoord): number {
  const cell = cellAt(grid, hex);
  return cell.level - waterDepth(cell.terrain);
}
