import type { Bearing } from "../core/hex.js";
import {
  FACINGS,
  type Facing,
  type Location,
  oppositeFacing,
  rotateFacing,
} from "../core/types.js";

/** Firing arc of a target relative to a unit. */
export type Arc = "front" | "rear" | "leftSide" | "rightSide";

/**
 * Quick-start firing arc: every weapon fires into the front arc only. The
 * booklet's front arc spans the hexside faced and its two neighbors.
 */
export function isInFrontArc(unitFacing: Facing, bearingToTarget: Facing): boolean {
  return (
    bearingToTarget === unitFacing ||
    bearingToTarget === rotateFacing(unitFacing, 1) ||
    bearingToTarget === rotateFacing(unitFacing, -1)
  );
}

/**
 * Total Warfare firing-arc classification. The target's bearing is
 * measured as a clockwise offset from the unit's facing: offset 0 (front) and
 * offset 3 (rear) are one hexside wide, while the two side arcs each span two
 * hexsides. Side/left/right arcs drive the side hit-location tables; the rear
 * arc drives the rear armor pool.
 */
export function classifyArc(unitFacing: Facing, bearingToTarget: Facing): Arc {
  if (bearingToTarget === unitFacing) return "front";
  if (bearingToTarget === oppositeFacing(unitFacing)) return "rear";
  const fromIdx = FACINGS.indexOf(unitFacing);
  const toIdx = FACINGS.indexOf(bearingToTarget);
  const clockwise = (((toIdx - fromIdx) % 6) + 6) % 6;
  // Clockwise offsets 1..2 lie on the right side; 4..5 on the left.
  return clockwise <= 2 ? "rightSide" : "leftSide";
}

/** Arc classification plus the alternate arc when the bearing lies exactly
 *  on an arc-boundary line (`altArc`); otherwise `altArc` is null. */
export interface ArcClass {
  readonly arc: Arc;
  readonly altArc: Arc | null;
}

/** Classify a `Bearing`, carrying the boundary ambiguity through when the
 *  center-to-center line runs exactly along a sector edge. */
export function classifyArcWithBoundary(unitFacing: Facing, b: Bearing): ArcClass {
  return {
    arc: classifyArc(unitFacing, b.facing),
    altArc: b.boundary !== null ? classifyArc(unitFacing, b.boundary) : null,
  };
}

/**
 * TW p.107 attack direction: when the attack line crosses the target's hex
 * exactly along the intersection of two hexsides, the TARGET chooses which
 * side is hit. The engine cannot ask mid-resolution, so it applies the
 * defender's dominant choice deterministically: never rear when an
 * alternative exists, and front over a side.
 */
export function defenderArcChoice(arc: Arc, altArc: Arc | null): Arc {
  if (altArc === null) return arc;
  if (arc === "front" || altArc === "front") return "front";
  return arc === "rear" ? altArc : arc;
}

/**
 * Per-weapon firing arcs for a biped 'Mech (TW p.105). Head-, leg- and
 * front-torso-mounted weapons fire into the front arc only; arm-mounted
 * weapons add their own side arc (right arm → right side); torso weapons
 * mounted rear-facing (`rearFacing` on the mount) fire into the rear arc
 * only. The arc input is the attacker's *effective* facing — call
 * `effectiveFacingForTwist` first when the 'Mech is twisting its torso, so
 * the side arms cover matches the twisted direction.
 */
export function weaponCanFireIntoArc(location: Location, rearFacing: boolean, arc: Arc): boolean {
  if (rearFacing) return arc === "rear";
  switch (arc) {
    case "front":
      return true;
    case "rear":
      return false;
    case "leftSide":
      return location === "leftArm";
    case "rightSide":
      return location === "rightArm";
  }
}

/**
 * Hexside offset a torso twist applies to the attacker's effective facing
 * (TW p.62): `left` rotates one hexside counter-clockwise (so the left arm
 * covers the left side of the twisted torso), `right` one hexside
 * clockwise, `front` is untwisted. Used to translate a session-side twist
 * state into an input for `classifyArcWithBoundary` /
 * `weaponCanFireIntoArc`.
 */
export function twistDelta(twist: Arc): -1 | 0 | 1 {
  switch (twist) {
    case "leftSide":
      return -1;
    case "rightSide":
      return 1;
    case "front":
      return 0;
    case "rear":
      return 0;
  }
}

/**
 * Effective attacker facing after applying a torso twist (TW p.62). The
 * 'Mech's body keeps its `facing`; arm and front-torso weapons fire as if
 * the torso pointed `twist` hexsides off. `front` is a no-op.
 */
export function effectiveFacingForTwist(facing: Facing, twist: Arc | null | undefined): Facing {
  const delta = twist === null || twist === undefined ? 0 : twistDelta(twist);
  return delta === 0 ? facing : rotateFacing(facing, delta);
}
