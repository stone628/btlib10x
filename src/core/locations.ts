import type { Location } from "./types.js";

export type TorsoLocation = "centerTorso" | "rightTorso" | "leftTorso";
export type SideTorsoLocation = "rightTorso" | "leftTorso";
export type ArmLocation = "rightArm" | "leftArm";
export type LegLocation = "rightLeg" | "leftLeg";

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

export function isLimb(loc: Location): loc is ArmLocation | LegLocation {
  return isArm(loc) || isLeg(loc);
}

export function isSideTorso(loc: Location): loc is SideTorsoLocation {
  return loc === "rightTorso" || loc === "leftTorso";
}

export function shoulderOf(loc: ArmLocation | LegLocation): SideTorsoLocation {
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
