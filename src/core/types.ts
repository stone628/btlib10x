/**
 * Hexside a unit faces, named by compass point per the rulebook diagrams
 * (flat-top hexes: there is no east/west hexside). `FACINGS` runs clockwise
 * starting at north.
 */
export type Facing = "n" | "ne" | "se" | "s" | "sw" | "nw";

export const FACINGS: readonly Facing[] = ["n", "ne", "se", "s", "sw", "nw"];

export function isFacing(value: unknown): value is Facing {
  return typeof value === "string" && (FACINGS as readonly string[]).includes(value);
}

export function rotateFacing(facing: Facing, steps: number): Facing {
  const n = FACINGS.length;
  const idx = (((FACINGS.indexOf(facing) + steps) % n) + n) % n;
  return FACINGS[idx]!;
}

export function oppositeFacing(facing: Facing): Facing {
  return rotateFacing(facing, 3);
}

export type TerrainType = "clear" | "lightWoods" | "heavyWoods";

export const TERRAIN_TYPES: readonly TerrainType[] = ["clear", "lightWoods", "heavyWoods"];

export function isTerrainType(value: unknown): value is TerrainType {
  return typeof value === "string" && (TERRAIN_TYPES as readonly string[]).includes(value);
}

/** A single non-clear terrain hex on the board (map data and battle setup). */
export interface TerrainHexDef {
  readonly col: number;
  readonly row: number;
  readonly type: TerrainType;
  /** Ground elevation in levels. Default 0. */
  readonly level?: number;
}

/** A coordinate on the hex grid plus its ground elevation (default 0). */
export interface Hex {
  col: number;
  row: number;
  level?: number;
}

export type MoveMode = "standStill" | "walk" | "run" | "jump";

export type Location =
  | "head"
  | "centerTorso"
  | "rightTorso"
  | "leftTorso"
  | "rightArm"
  | "leftArm"
  | "rightLeg"
  | "leftLeg";

export const LOCATIONS: readonly Location[] = [
  "head",
  "centerTorso",
  "rightTorso",
  "leftTorso",
  "rightArm",
  "leftArm",
  "rightLeg",
  "leftLeg",
] as const;

export function isLocation(value: string): value is Location {
  return LOCATIONS.includes(value as Location);
}

export interface Rng {
  d6(): number;
}
