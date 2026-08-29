import type { Location } from "../core/types.js";
import type { Arc } from "./arcs.js";

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

/**
 * Hit location for a given firing arc. Front and rear share the same column
 * (rear only changes which armor pool is depleted); left/right side arcs use
 * their own tables.
 */
export function hitLocationForArc(arc: Arc, roll2d6: number): Location {
  const table =
    arc === "leftSide"
      ? LEFT_SIDE_TABLE
      : arc === "rightSide"
        ? RIGHT_SIDE_TABLE
        : HIT_LOCATION_TABLE;
  const loc = table[roll2d6];
  if (loc === undefined) throw new Error(`Hit location roll out of range: ${roll2d6}`);
  return loc;
}
