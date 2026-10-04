import type { Location } from "../core/types";
import type { Arc } from "./arcs";

/** Bipedal 'Mech hit location table (front arc / rear arc), identical in both booklets. */
export const HIT_LOCATION_TABLE: Readonly<Record<number, Location>> = {
  2: "centerTorso",
  3: "rightArm",
  4: "rightArm",
  5: "rightLeg",
  6: "rightTorso",
  7: "centerTorso",
  8: "leftTorso",
  9: "leftLeg",
  10: "leftArm",
  11: "leftArm",
  12: "head",
};

/** Hit location table used when a target is in an attacker's LEFT side arc. */
export const LEFT_SIDE_TABLE: Readonly<Record<number, Location>> = {
  2: "leftTorso",
  3: "leftLeg",
  4: "leftArm",
  5: "leftArm",
  6: "leftLeg",
  7: "leftTorso",
  8: "centerTorso",
  9: "rightTorso",
  10: "rightArm",
  11: "rightLeg",
  12: "head",
};

/** Hit location table used when a target is in an attacker's RIGHT side arc. */
export const RIGHT_SIDE_TABLE: Readonly<Record<number, Location>> = {
  2: "rightTorso",
  3: "rightLeg",
  4: "rightArm",
  5: "rightArm",
  6: "rightLeg",
  7: "rightTorso",
  8: "centerTorso",
  9: "leftTorso",
  10: "leftArm",
  11: "leftLeg",
  12: "head",
};

export function hitLocation(roll2d6: number): Location {
  const loc = HIT_LOCATION_TABLE[roll2d6];
  if (loc === undefined) throw new Error(`Hit location roll out of range: ${roll2d6}`);
  return loc;
}

/** Bipedal 'Mech Punch Location Table, Front/Rear column (TW p. 145).
 *  Also used alone for collapse damage on 'Mechs inside a building, which
 *  always rolls the Front column (TW p. 176). */
export const PUNCH_LOCATION_TABLE: Readonly<Record<number, Location>> = {
  1: "leftArm",
  2: "leftTorso",
  3: "centerTorso",
  4: "rightTorso",
  5: "rightArm",
  6: "head",
};

/** Bipedal 'Mech Punch Location Table, Left Side column (TW p. 145). */
export const PUNCH_LEFT_SIDE_TABLE: Readonly<Record<number, Location>> = {
  1: "leftTorso",
  2: "leftTorso",
  3: "centerTorso",
  4: "leftArm",
  5: "leftArm",
  6: "head",
};

/** Bipedal 'Mech Punch Location Table, Right Side column (TW p. 145). */
export const PUNCH_RIGHT_SIDE_TABLE: Readonly<Record<number, Location>> = {
  1: "rightTorso",
  2: "rightTorso",
  3: "centerTorso",
  4: "rightArm",
  5: "rightArm",
  6: "head",
};

/** Front/Rear column of the Punch Location Table (building collapse, TW p. 176). */
export function punchHitLocation(roll1d6: number): Location {
  const loc = PUNCH_LOCATION_TABLE[roll1d6];
  if (loc === undefined) throw new Error(`Punch location roll out of range: ${roll1d6}`);
  return loc;
}

const ARC_PUNCH_TABLE: Record<Arc, Readonly<Record<number, Location>>> = {
  front: PUNCH_LOCATION_TABLE,
  rear: PUNCH_LOCATION_TABLE,
  leftSide: PUNCH_LEFT_SIDE_TABLE,
  rightSide: PUNCH_RIGHT_SIDE_TABLE,
};

/**
 * Punch Location Table (TW p. 145) column chosen by attack direction:
 * front and rear share the Front/Rear column, side attacks use their own.
 */
export function punchHitLocationForArc(arc: Arc, roll1d6: number): Location {
  const loc = ARC_PUNCH_TABLE[arc][roll1d6];
  if (loc === undefined) throw new Error(`Punch location roll out of range: ${roll1d6}`);
  return loc;
}

const ARC_HIT_TABLE: Record<Arc, Readonly<Record<number, Location>>> = {
  front: HIT_LOCATION_TABLE,
  rear: HIT_LOCATION_TABLE,
  leftSide: LEFT_SIDE_TABLE,
  rightSide: RIGHT_SIDE_TABLE,
};
/**
 * Hit location for a given firing arc. Front and rear share the same column
 * (rear only changes which armor pool is depleted); left/right side arcs use
 * their own tables.
 */
export function hitLocationForArc(arc: Arc, roll2d6: number): Location {
  const loc = ARC_HIT_TABLE[arc][roll2d6];
  if (loc === undefined) throw new Error(`Hit location roll out of range: ${roll2d6}`);
  return loc;
}
