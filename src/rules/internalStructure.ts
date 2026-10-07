import type { LocationValue } from "./damage";

export const HEAD_STRUCTURE = 3;

/**
 * Standard Total Warfare internal-structure table for a bipedal 'Mech with a
 * standard chassis. Head is always 3; the rest comes from a tonnage lookup.
 * Values verified against canonical mordel.net/MegaMek record sheets for the
 * tonnages this library ships (40, 50, 55, 90, 100); the remaining 5-ton rows
 * use the standard published table.
 */
export interface InternalStructureRow {
  readonly centerTorso: number;
  readonly sideTorso: number;
  readonly arm: number;
  readonly leg: number;
}

export const STANDARD_INTERNAL_STRUCTURE: Readonly<Record<number, InternalStructureRow>> = {
  20: { centerTorso: 6, sideTorso: 5, arm: 3, leg: 4 },
  25: { centerTorso: 8, sideTorso: 6, arm: 4, leg: 6 },
  30: { centerTorso: 10, sideTorso: 7, arm: 5, leg: 7 },
  35: { centerTorso: 11, sideTorso: 8, arm: 6, leg: 8 },
  40: { centerTorso: 12, sideTorso: 10, arm: 6, leg: 10 },
  45: { centerTorso: 14, sideTorso: 11, arm: 7, leg: 11 },
  50: { centerTorso: 16, sideTorso: 12, arm: 8, leg: 12 },
  55: { centerTorso: 18, sideTorso: 13, arm: 9, leg: 13 },
  60: { centerTorso: 20, sideTorso: 14, arm: 10, leg: 14 },
  65: { centerTorso: 21, sideTorso: 15, arm: 10, leg: 15 },
  70: { centerTorso: 22, sideTorso: 15, arm: 11, leg: 15 },
  75: { centerTorso: 23, sideTorso: 16, arm: 12, leg: 16 },
  80: { centerTorso: 25, sideTorso: 17, arm: 13, leg: 17 },
  85: { centerTorso: 27, sideTorso: 18, arm: 14, leg: 18 },
  90: { centerTorso: 29, sideTorso: 19, arm: 15, leg: 19 },
  95: { centerTorso: 30, sideTorso: 20, arm: 16, leg: 20 },
  100: { centerTorso: 31, sideTorso: 21, arm: 17, leg: 21 },
};

/** Internal structure hit points for a `tonnage` bipedal 'Mech. */
export function internalStructureForTonnage(tonnage: number): LocationValue {
  const row = STANDARD_INTERNAL_STRUCTURE[tonnage];
  if (!row) throw new Error(`No internal structure table entry for ${tonnage} tons`);
  return {
    head: HEAD_STRUCTURE,
    centerTorso: row.centerTorso,
    rightTorso: row.sideTorso,
    leftTorso: row.sideTorso,
    rightArm: row.arm,
    leftArm: row.arm,
    rightLeg: row.leg,
    leftLeg: row.leg,
  };
}
