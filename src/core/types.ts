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

export type TerrainType =
  | "clear"
  | "lightWoods"
  | "heavyWoods"
  | "rough"
  | "rubble"
  | "pavement"
  | "water1"
  | "water2"
  | "water3"
  | "lightBuilding"
  | "mediumBuilding"
  | "heavyBuilding"
  | "hardenedBuilding";

export const TERRAIN_TYPES: readonly TerrainType[] = [
  "clear",
  "lightWoods",
  "heavyWoods",
  "rough",
  "rubble",
  "pavement",
  "water1",
  "water2",
  "water3",
  "lightBuilding",
  "mediumBuilding",
  "heavyBuilding",
  "hardenedBuilding",
];

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

/** A coordinate on the hex grid (1-based column and row). */
export interface HexCoord {
  readonly col: number;
  readonly row: number;
}

/** Terrain and elevation data for a single hex cell. */
export interface HexCell {
  readonly terrain: TerrainType;
  readonly level: number;
}

/** A 'Mech wreck left behind by an ejected or pilot-killed unit. A
 *  permanent obstacle: blocks the hex against all movement (TW; entry
 *  remains forbidden — TO rough/severe-rough MP + PSR surcharge on entry
 *  is deferred), and provides partial cover to an adjacent target (see
 *  `partialCoverMod` in `src/rules/game.ts`).
 *  Level meaning (Tactical Operations):
 *   - 1 = light 'Mech (<40 t) wreck, or prone 'Mech with killed/ejected
 *         pilot. Does NOT block LOS between standard ground 'Mechs; +1
 *         partial cover to standing ground 'Mechs behind it.
 *   - 2 = standard TW wreck. Blocks LOS entirely between standard ground
 *         'Mechs; +2 partial cover to adjacent targets, or +1 to elevated
 *         / Level 3+ targets.
 *  Wreck level is computed by `wreckLevelFor` in `src/rules/game.ts` when
 *  the wreck is spawned (`ejectPilot`, `removePilotKilled`). */
export interface WreckState {
  /** Unit that ejected and left the wreck. */
  readonly unitId: string;
  /** Obstacle height in levels (1 or 2; see Tactical Operations block above). */
  readonly level: number;
}

export type MoveMode = "standStill" | "walk" | "run" | "jump" | "prone";

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
  snapshot(): string;
  load(snapshot: string): void;
}
