import type { Location } from "../core/types.js";

/** Bipedal 'Mech hit location table (front arc), identical in both booklets. */
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

export function hitLocation(roll2d6: number): Location {
  const loc = HIT_LOCATION_TABLE[roll2d6];
  if (loc === undefined) throw new Error(`Hit location roll out of range: ${roll2d6}`);
  return loc;
}
