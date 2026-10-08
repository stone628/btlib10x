import { cellAt, type HexGrid, hexCell } from "../core/terrain";
import { type HexCell, type HexCoord, hexKey, type TerrainType } from "../core/types";

/** Building types recognized by the core rulebook. */
export type BuildingType = "light" | "medium" | "heavy" | "hardened";

/** Maps terrain type string to the corresponding building sub-type. */
const BUILDING_TERRAIN_MAP: Readonly<Record<string, BuildingType>> = {
  lightBuilding: "light",
  mediumBuilding: "medium",
  heavyBuilding: "heavy",
  hardenedBuilding: "hardened",
};

/** Default building height in levels (TW pp. 166–167: an unspecified
 *  building is medium, Level 2). The engine tracks no multi-floor interiors,
 *  so every occupant counts as ground-floor with this many levels above. */
export const DEFAULT_BUILDING_LEVELS = 2;

/** Default Construction Factor by building type (TW pp. 166–167:
 *  unspecified-building defaults; hardened tops its 91–150 band at 150). */
const INITIAL_CF: Readonly<Record<BuildingType, number>> = {
  light: 15,
  medium: 40,
  heavy: 90,
  hardened: 120,
};

export interface BuildingState {
  /** Current structural factor; building collapses at 0. */
  cf: number;
  /** Building sub-type. */
  type: BuildingType;
}

/** Returns the building sub-type for a terrain type, or `undefined` if the
 *  terrain is not a building. */
export function buildingTypeOf(terrain: TerrainType): BuildingType | undefined {
  return BUILDING_TERRAIN_MAP[terrain];
}

/** True when the terrain is a building hex of any sub-type. */
export function isBuildingTerrain(terrain: TerrainType): boolean {
  return buildingTypeOf(terrain) !== undefined;
}

/** Initial CF for a building sub-type. */
export function initialCf(type: BuildingType): number {
  return INITIAL_CF[type];
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
 * Build the initial `BuildingState` for a building terrain type using the
 * default CF for that type.
 */
export function createBuildingState(type: BuildingType): BuildingState {
  return { cf: INITIAL_CF[type], type };
}

/** Return building state for a hex, or `undefined` if the hex is not a building. */
export function buildingAt(
  grid: HexGrid,
  hex: HexCoord,
  buildings: ReadonlyMap<string, BuildingState>,
): BuildingState | undefined {
  const terrain = cellAt(grid, hex).terrain;
  const bt = buildingTypeOf(terrain);
  if (bt === undefined) return undefined;
  const key = hexKey(hex);
  return buildings.get(key);
}

/**
 * Convert a building hex to rubble when it collapses. Returns the rubble cell
 * if the terrain was a building, or null if no change is needed.
 */
export function collapseToRubble(cell: HexCell): HexCell | null {
  if (buildingTypeOf(cell.terrain) === undefined) return null;
  return hexCell("rubble", cell.level);
}
