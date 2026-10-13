import type { Bearing } from "../core/hex";
import {
  FACINGS,
  type Facing,
  type HexCoord,
  isArm,
  isTorso,
  type Location,
  oppositeFacing,
  rotateFacing,
} from "../core/types";
import type { WeaponMount } from "../data/mech.schema";

/** Firing arc of a target relative to a unit. */
export type Arc = "front" | "rear" | "leftSide" | "rightSide";

/**
 * Hexside-sector classification (bearing offset from a facing). Offset 0
 * (front) and offset 3 (rear) are one hexside wide, while the two side arcs
 * each span two hexsides.
 *
 * Used for TW p.119 attack direction (which hexside of the target the attack
 * crosses, locked in via the LOS choice). It is NOT the weapon firing-arc
 * rule — firing arcs use the TW p.105 hex template (`classifyFiringArc`),
 * whose forward arc is twice as wide. Side/left/right arcs drive the side
 * hit-location tables; the rear arc drives the rear armor pool.
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

/**
 * TW p.105 weapon firing-arc template. Unlike attack direction (a
 * center-to-center bearing sector), firing arcs are regions of the hex grid
 * bounded by the two lines through the rear edge-center of the attacker's
 * hex, parallel to the two diagonal hex axes 60° off the facing axis. Every
 * hex falls wholly in one arc — there are no boundary hexes.
 *
 * Implementation: translate to cube-relative (dx, dy, dz), rotate so the
 * facing reads as north (clockwise cube step `(x,y,z)->(-z,-x,-y)`, applied
 * once per clockwise facing step to invert), then test the two half-integer
 * boundaries `dz <= 0` and `dx+dz <= 0` (integer-safe form of the
 * `0.5`-offset apex):
 * front iff both hold; rear iff neither holds; otherwise the mixed side
 * (north half = right, south half = left).
 *
 * Ground truth (attacker on 0509 facing north, radius <= 2): front =
 * 0507/0407/0607/0308/0508/0708/0408/0608, left = 0309/0409/0310, right =
 * 0709/0609/0710, rear = 0510/0410/0610/0511.
 *
 * Returns null when attacker and target share a hex (arc undefined).
 */
export function classifyFiringArc(from: HexCoord, to: HexCoord, facing: Facing): Arc | null {
  if (from.col === to.col && from.row === to.row) return null;
  const steps = FACINGS.indexOf(facing);
  let dx = to.col - from.col;
  let dz = to.row - (to.col + (to.col & 1)) / 2 - (from.row - (from.col + (from.col & 1)) / 2);
  let dy = -dx - dz;
  for (let i = 0; i < steps; i++) {
    const nx = -dy;
    const ny = -dz;
    const nz = -dx;
    dx = nx;
    dy = ny;
    dz = nz;
  }
  const forwardZ = dz <= 0;
  const forwardY = dx + dz <= 0;
  if (forwardZ && forwardY) return "front";
  if (!forwardZ && !forwardY) return "rear";
  return forwardZ ? "rightSide" : "leftSide";
}

/** Arc classification plus the alternate arc when the bearing lies exactly
 *  on an arc-boundary line (`altArc`); otherwise `altArc` is null. */
export interface ArcClass {
  readonly arc: Arc;
  readonly altArc: Arc | null;
}

/** Classify a `Bearing` into hexside sectors, carrying the boundary ambiguity
 *  through when the center-to-center line runs exactly along a sector edge.
 *  Used for TW p.119 attack direction; weapon firing arcs use the
 *  boundary-free `classifyFiringArc` template instead. */
export function classifyArcWithBoundary(unitFacing: Facing, b: Bearing): ArcClass {
  return {
    arc: classifyArc(unitFacing, b.facing),
    altArc: b.boundary !== null ? classifyArc(unitFacing, b.boundary) : null,
  };
}

/**
 * TW p.119 attack direction (locked-in LOS hexside).
 *
 * When the attack line crosses the target's hex exactly along the
 * intersection of two hexsides, the side hit is the LOS hexside chosen
 * at the *first* attack declaration between those two units this phase.
 * Per TW p. 99, when the center-to-center line passes between two hexes
 * it is the target's controlling player who picks which hex lies along
 * the LOS, and that choice locks for every attack between those two
 * units for the rest of the turn.
 *
 * Engine policy: the engine never re-asks the target's controller, so
 * this helper picks the defender-favouring member of the boundary pair
 * deterministically — `front` always wins; otherwise drop `rear`. This
 * only matches the rule when the real locked-in choice would have
 * landed on the same arc; treat as engine behaviour, not a paraphrase
 * of the rule.
 */
export function defenderArcChoice(arc: Arc, altArc: Arc | null): Arc {
  if (altArc === null) return arc;
  if (arc === "front" || altArc === "front") return "front";
  return arc === "rear" ? altArc : arc;
}

/**
 * Per-weapon firing arcs for a biped 'Mech (TW p.105). Head-, leg- and
 * front-torso-mounted weapons fire into the front arc only; arm-mounted
 * weapons add their own side arc (right arm → right side); torso and head weapons
 * mounted rear-facing (`rearFacing` on the mount) fire into the rear arc
 * only. The arc input is a TW p.105 template arc (`classifyFiringArc` of the
 * attacker's *effective* facing — call `effectiveFacingForTwist` first when
 * the 'Mech is twisting its torso, so the side arms cover matches the
 * twisted direction.
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
 * Location whose firing arc a mount uses: a weapon split between an arm and
 * a torso uses the torso arc (TW pp.105-106), so a split arm AC/20 fires
 * forward only. It is also the location for the arm actuator to-hit
 * modifiers, which a split weapon does not take.
 */
export function mountArcLocation(mount: Pick<WeaponMount, "location" | "splitLocation">): Location {
  const split = mount.splitLocation;
  return split !== undefined && isArm(mount.location) && isTorso(split) ? split : mount.location;
}

/** `weaponCanFireIntoArc` for a mount, honoring split and rear-facing mounts. */
export function mountCanFireIntoArc(
  mount: Pick<WeaponMount, "location" | "splitLocation" | "rearFacing">,
  arc: Arc,
): boolean {
  return weaponCanFireIntoArc(mountArcLocation(mount), mount.rearFacing === true, arc);
}

/**
 * Hexside offset a torso twist applies to the attacker's effective facing
 * (TW pp.105-106): `left` rotates one hexside counter-clockwise (so the left arm
 * covers the left side of the twisted torso), `right` one hexside
 * clockwise, `front` is untwisted. Used to translate a session-side twist
 * state into an input for `classifyFiringArc` / `weaponCanFireIntoArc`.
 */
export function twistDelta(twist: Arc): -1 | 0 | 1 {
  switch (twist) {
    case "leftSide":
      return -1;
    case "rightSide":
      return 1;
    case "front":
      return 0;
  }
  throw new Error(`cannot twist to ${twist}`);
}

/**
 * Effective attacker facing after applying a torso twist (TW pp.105-106). The
 * 'Mech's body keeps its `facing`; arm and front-torso weapons fire as if
 * the torso pointed `twist` hexsides off. `front` is a no-op.
 */
export function effectiveFacingForTwist(facing: Facing, twist: Arc | null | undefined): Facing {
  const delta = twist === null || twist === undefined ? 0 : twistDelta(twist);
  return delta === 0 ? facing : rotateFacing(facing, delta);
}

/** Multiple-targets to-hit modifier for a secondary target (TW p.108). */
export type SecondaryTargetMod = 1 | 2;

/**
 * To-hit modifier for a secondary target: +1 when it lies in the attacker's
 * forward arc (after torso twist), +2 in a side or rear arc. Callers apply it
 * only to targets other than the primary. Returns 2 when the hexes coincide
 * (no arc), which cannot occur for a legal declaration.
 */
export function secondaryTargetModifier(
  from: HexCoord,
  to: HexCoord,
  facing: Facing,
  twist: Arc | null | undefined,
): SecondaryTargetMod {
  return classifyFiringArc(from, to, effectiveFacingForTwist(facing, twist)) === "front" ? 1 : 2;
}
