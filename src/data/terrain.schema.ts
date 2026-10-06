import type { TerrainType } from "../core/types";
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
  readonly partialCover: boolean;
  /** When true, units cannot fire into or out of this terrain hex. */
  readonly blocksTargeting: boolean;
  readonly waterDepth: number;
  /** Ejection Modifiers Table landing-terrain term (TO p.165) for the hex
   *  behind the 'Mech: clear/pavement -2, water -1, rough/rubble 0, light woods
   *  +2, heavy woods +3, +1 per level of building. */
  readonly ejectLandMod: (level: number) => number;
}

export function terrainDef(type: TerrainType): TerrainDef {
  return TERRAIN_DATA.get(type)!;
}

export function allTerrainDefs(): ReadonlyMap<TerrainType, TerrainDef> {
  return TERRAIN_DATA;
}
