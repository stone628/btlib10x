import { cellAt, type HexGrid, hexCell } from "../core/terrain";
import { type BuildingTerrainType, type HexCell, type HexCoord, hexKey } from "../core/types";

/** Default building height in levels (TW pp. 166–167: an unspecified
 *  building is medium, Level 2). The engine tracks no multi-floor interiors,
 *  so every occupant counts as ground-floor with this many levels above. */
export const DEFAULT_BUILDING_LEVELS = 2;

/** Default Construction Factor by building terrain (TW pp. 166–167:
 *  unspecified-building defaults; hardened tops its 91–150 band at 150). */
const INITIAL_CF: Readonly<Record<BuildingTerrainType, number>> = {
  lightBuilding: 15,
  mediumBuilding: 40,
  heavyBuilding: 90,
  hardenedBuilding: 120,
};

/** Per-hex building damage track. The sub-type is the hex's terrain. */
export interface BuildingState {
  /** Current structural factor; building collapses at 0. */
  cf: number;
}

/** True when the terrain is a building hex of any sub-type. */
export function isBuildingTerrain(terrain: string): terrain is BuildingTerrainType {
  return Object.hasOwn(INITIAL_CF, terrain);
}

/** Initial CF for a building terrain. */
export function initialCf(terrain: BuildingTerrainType): number {
  return INITIAL_CF[terrain];
}

/** True when the building has collapsed (CF <= 0). */
export function isCollapsed(state: BuildingState): boolean {
  return state.cf <= 0;
}

/**
 * Apply weapon damage to a building hex. Returns the updated state; CF is
 * clamped at 0 (collapse).
 */
export function applyBuildingDamage(state: BuildingState, damage: number): BuildingState {
  const cf = Math.max(0, state.cf - damage);
  return { ...state, cf };
}

/**
 * Build the initial `BuildingState` for a building terrain using the default
 * CF for that terrain.
 */
export function createBuildingState(terrain: BuildingTerrainType): BuildingState {
  return { cf: INITIAL_CF[terrain] };
}

/** Return building state for a hex, or `undefined` if the hex is not a building. */
export function buildingAt(
  grid: HexGrid,
  hex: HexCoord,
  buildings: ReadonlyMap<string, BuildingState>,
): BuildingState | undefined {
  if (!isBuildingTerrain(cellAt(grid, hex).terrain)) return undefined;
  return buildings.get(hexKey(hex));
}

/**
 * Convert a building hex to rubble when it collapses. Returns the rubble cell
 * if the terrain was a building, or null if no change is needed.
 */
export function collapseToRubble(cell: HexCell): HexCell | null {
  if (!isBuildingTerrain(cell.terrain)) return null;
  return hexCell("rubble", cell.level);
}

/**
 * Throws unless the building map agrees with the cells: every building cell
 * has a standing entry (CF > 0), every entry sits on a building cell, and
 * every rubble origin is a building terrain recorded on a rubble cell.
 * `cells` is row-major, `width` cells per row.
 */
export function assertBuildingsMatchCells(
  cells: readonly HexCell[],
  width: number,
  buildings: Readonly<Record<string, BuildingState>>,
  rubbleOrigin: Readonly<Record<string, string>>,
): void {
  const keyAt = (i: number): string =>
    hexKey({ col: (i % width) + 1, row: Math.floor(i / width) + 1 });
  const cellOf = new Map<string, HexCell>();
  cells.forEach((cell, i) => {
    const key = keyAt(i);
    cellOf.set(key, cell);
    if (isBuildingTerrain(cell.terrain) && buildings[key] === undefined) {
      throw new Error(`Building hex ${key} has no building state`);
    }
  });
  for (const [key, building] of Object.entries(buildings)) {
    const cell = cellOf.get(key);
    if (cell === undefined || !isBuildingTerrain(cell.terrain)) {
      throw new Error(`Building state at ${key} is not on a building hex`);
    }
    if (!(building.cf > 0))
      throw new Error(`Building at ${key} has CF ${building.cf}; collapsed buildings are rubble`);
  }
  for (const [key, origin] of Object.entries(rubbleOrigin)) {
    if (!isBuildingTerrain(origin))
      throw new Error(`Rubble origin at ${key} is not a building terrain: ${origin}`);
    if (cellOf.get(key)?.terrain !== "rubble")
      throw new Error(`Rubble origin at ${key} is not on a rubble hex`);
  }
}
