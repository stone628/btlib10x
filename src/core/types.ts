/**
 * Hexside a unit faces, named by compass point per the rulebook diagrams
 * (flat-top hexes: there is no east/west hexside). `FACINGS` runs clockwise
 * starting at north.
 */
export type Facing = "n" | "ne" | "se" | "s" | "sw" | "nw";

export const FACINGS: readonly Facing[] = ["n", "ne", "se", "s", "sw", "nw"];

export function rotateFacing(facing: Facing, clockwiseSteps: number): Facing {
  const n = FACINGS.length;
  const idx = (((FACINGS.indexOf(facing) + clockwiseSteps) % n) + n) % n;
  return FACINGS[idx]!;
}

export function oppositeFacing(facing: Facing): Facing {
  return rotateFacing(facing, 3);
}

export type BuildingTerrainType =
  | "lightBuilding"
  | "mediumBuilding"
  | "heavyBuilding"
  | "hardenedBuilding";

export type TerrainType =
  | "clear"
  | "lightWoods"
  | "heavyWoods"
  | "rough"
  | "rubble"
  | "water1"
  | "water2"
  | "water3"
  | BuildingTerrainType;

export const TERRAIN_TYPES: readonly TerrainType[] = [
  // Order is wire-stable (indexes are stored in packed JSONL map lines) — append only.
  "clear",
  "lightWoods",
  "heavyWoods",
  "rough",
  "rubble",
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

/** True for woods hex types (TW p. 100: woods rise 2 levels above hex). */
export function isWoodsTerrain(value: TerrainType): boolean {
  return value === "lightWoods" || value === "heavyWoods";
}

/** A coordinate on the hex grid (1-based column and row).
 *
 * Immutable: all fields are `readonly`, so instances are assigned (shared by reference), never copied.
 * Positions, event payloads and snapshots all alias one object safely. */
export interface HexCoord {
  readonly col: number;
  readonly row: number;
}

/** A single non-clear terrain hex on the board (map data and battle setup). */
export interface TerrainHexDef extends HexCoord {
  readonly type: TerrainType;
  /** Ground elevation in levels. Default 0. */
  readonly level?: number;
}

export function hexKey(hex: HexCoord): string {
  return `${hex.col},${hex.row}`;
}

/** Error messages show 1-based coordinates; positions are stored 1-based. */
export function msgHex(hex: HexCoord): string {
  return `${hex.col},${hex.row}`;
}

/** Terrain and elevation data for a single hex cell. */
export interface HexCell {
  readonly terrain: TerrainType;
  readonly level: number;
}

export type MoveMode = "standStill" | "walk" | "run" | "jump" | "prone";

export type SideTorsoLocation = "rightTorso" | "leftTorso";
export type TorsoLocation = SideTorsoLocation | "centerTorso";
export type ArmLocation = "rightArm" | "leftArm";
export type LegLocation = "rightLeg" | "leftLeg";
export type LimbLocation = ArmLocation | LegLocation;
export type Location = "head" | TorsoLocation | LimbLocation;
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

export const TORSO_LOCATIONS: readonly TorsoLocation[] = [
  "leftTorso",
  "centerTorso",
  "rightTorso",
] as const;

export function isTorso(loc: Location): loc is TorsoLocation {
  return loc === "centerTorso" || loc === "rightTorso" || loc === "leftTorso";
}

export function isCenterTorso(loc: Location): loc is "centerTorso" {
  return loc === "centerTorso";
}

export function isKillLocation(loc: Location): loc is "head" | "centerTorso" {
  return loc === "head" || loc === "centerTorso";
}

export function isArm(loc: Location): loc is ArmLocation {
  return loc === "rightArm" || loc === "leftArm";
}

export function isLeg(loc: Location): loc is LegLocation {
  return loc === "rightLeg" || loc === "leftLeg";
}

export function isLimb(loc: Location): loc is LimbLocation {
  return isArm(loc) || isLeg(loc);
}

export function isSideTorso(loc: Location): loc is SideTorsoLocation {
  return loc === "rightTorso" || loc === "leftTorso";
}

export function shoulderOf(loc: LimbLocation): SideTorsoLocation {
  return loc === "rightArm" || loc === "rightLeg" ? "rightTorso" : "leftTorso";
}

export function armFor(loc: Location): ArmLocation | undefined {
  if (loc === "rightTorso") return "rightArm";
  if (loc === "leftTorso") return "leftArm";
  return undefined;
}

export function damageTransferTo(loc: Location): Location | null {
  switch (loc) {
    case "rightArm":
    case "rightLeg":
    case "rightTorso":
      return loc === "rightTorso" ? "centerTorso" : "rightTorso";
    case "leftArm":
    case "leftLeg":
    case "leftTorso":
      return loc === "leftTorso" ? "centerTorso" : "leftTorso";
    case "centerTorso":
    case "head":
      return null;
  }
}

export interface Rng {
  d6(): number;
  snapshot(): string;
  load(snapshot: string): void;
}
