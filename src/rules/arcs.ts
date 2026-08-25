import { type Facing, rotateFacing } from "../core/types.js";

/** Quick-start firing arcs: every weapon fires into the front arc only. */
export function isInFrontArc(unitFacing: Facing, bearingToTarget: Facing): boolean {
  return (
    bearingToTarget === unitFacing ||
    bearingToTarget === rotateFacing(unitFacing, 1) ||
    bearingToTarget === rotateFacing(unitFacing, -1)
  );
}
