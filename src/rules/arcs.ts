import { FACINGS, type Facing, oppositeFacing, rotateFacing } from "../core/types.js";

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
 * Classic Total Warfare firing-arc classification. The target's bearing is
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
