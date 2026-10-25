import { bearingExact, isAdjacent, neighbor, sameHex } from "../../core/hex";
import { cellAt, groundLevel } from "../../core/terrain";
import { type ArmLocation, FACINGS, type Facing, type HexCoord } from "../../core/types";
import type { ResolvedMechDef } from "../../data/mech.schema";
import { type Arc, classifyArc, classifyArcWithBoundary, defenderArcChoice } from "../arcs";
import { PARTIAL_COVER_TERRAIN_MOD } from "../attack";
import { isBuildingTerrain } from "../building";
import {
  defenderLosSide,
  interveningHexes,
  type LosSide,
  type ProneEnds,
  unitLosLevel,
} from "../los";
import { DEFENDER_ARC_RANK } from "./constants";
import type { BattleState, UnitState, WeaponAttackDecl } from "./types";

/**
 * Partial-cover to-hit modifier against `target` from `attacker`:
 *  - water1 target hex: +1 for a standing 'Mech, regardless of relative
 *    elevation (TW p.102: water surrounds it, applies even when attacker higher).
 *  - building target hex: +1 for a standing 'Mech when attacker level ≤
 *    target level (target's own hex, attacker not firing downhill).
 *  - intervening higher hex (TW p.102): +1 for a standing 'Mech when an
 *    adjacent hex lies between attacker and target, is at least one level
 *    above the target's underlying hex, and attacker LOS level ≤ target LOS
 *    level (attacker not firing downhill).
 * Partial cover comes only from terrain (TW p.102): hulls and wreckage give
 * none. Leg hit-location rolls strike the cover under any non-zero value
 * (see `hitLocationCovered` in `src/rules/attack.ts`). On a hexside line the
 * intervening hex comes from the chain `losSideFor` locks in (LOS-02).
 */
export function partialCoverMod(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide = losSideFor(state, attacker, target),
): number {
  return partialCoverDetail(state, attacker, target, side).mod;
}

/** The building hex providing the terrain partial cover to `target`, if the
 *  cover is a building (TW p.102: leg hits strike it and damage it). */
export function partialCoverBuildingHex(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide = losSideFor(state, attacker, target),
): HexCoord | undefined {
  return partialCoverDetail(state, attacker, target, side).buildingHex;
}

/**
 * The hexside chain the defender locks in between `attacker` and `target`
 * (TW pp.99, 101): woods, partial cover, the to-hit preview and the attack
 * direction all read this one chain, so woods on one side never adds to
 * cover on the other (LOS-02). To-hit decides the pick; the attack direction
 * only breaks a tie. `prone` defaults to the pair's `losEnds`.
 */
export function losSideFor(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  prone: ProneEnds | undefined = losEnds(state, attacker, target),
): LosSide {
  return defenderLosSide(
    state,
    attacker.position,
    target.position,
    prone,
    (side) => partialCoverDetail(state, attacker, target, side).mod,
    (side) => DEFENDER_ARC_RANK[attackDirectionOnSide(attacker, target, side)],
  );
}

/**
 * Attack direction (TW p.119): the side of `target` that `attacker` strikes.
 * When the line meets the target's hex exactly at a corner between two
 * hexsides, it enters through the hexside facing the last hex of the chosen
 * chain (TW p.119 ties it to the TW p.99 LOS choice), so it follows
 * `losSideFor`.
 */
export function attackDirectionFor(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide = losSideFor(state, attacker, target),
): Arc {
  return attackDirectionOnSide(attacker, target, side);
}

export function attackDirectionOnSide(attacker: UnitState, target: UnitState, side: LosSide): Arc {
  const back = bearingExact(target.position, attacker.position)!;
  const dir = classifyArcWithBoundary(target.facing, back);
  if (dir.altArc === null) return dir.arc;
  const last = interveningHexes(attacker.position, target.position, side).at(-1);
  const entry = last !== undefined ? facingToward(target.position, last) : undefined;
  return entry !== undefined
    ? classifyArc(target.facing, entry)
    : defenderArcChoice(dir.arc, dir.altArc);
}

export function partialCoverDetail(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide,
): { mod: number; buildingHex?: HexCoord } {
  const targetTerrain = cellAt(state, target.position).terrain;
  const targetLevel = cellAt(state, target.position).level;
  const targetStandingGround = !target.prone;

  let terrain = 0;
  let buildingHex: HexCoord | undefined;
  if (targetStandingGround) {
    if (targetTerrain === "water1") {
      // TW p.102: water1 surrounds the 'Mech, applies even when attacker higher.
      terrain = PARTIAL_COVER_TERRAIN_MOD;
    } else {
      // Intervening higher hex (TW p.102): adjacent to target, between
      // attacker and target, at least one level above target's underlying
      // hex, attacker not firing downhill.
      const attackerLos = unitLosLevel(state, attacker.position, attacker.prone);
      const targetLos = unitLosLevel(state, target.position, false);
      if (attackerLos <= targetLos) {
        // On a hexside line only the chain the defender chose counts
        // (TW p.101).
        for (const h of interveningHexes(attacker.position, target.position, side)) {
          if (!isAdjacent(h, target.position)) continue;
          const cell = cellAt(state, h);
          const effectiveLevel = isBuildingTerrain(cell.terrain) ? cell.level + 2 : cell.level;
          if (effectiveLevel >= targetLevel + 1) {
            terrain = PARTIAL_COVER_TERRAIN_MOD;
            if (isBuildingTerrain(cell.terrain)) buildingHex = { ...h };
            break;
          }
        }
      }
    }
  }

  return buildingHex !== undefined ? { mod: terrain, buildingHex } : { mod: terrain };
}

/**
 * Whether `attacker` fires at `target` through a hex that gives the attacker
 * itself partial cover: the shooter-side mirror of `partialCoverDetail`, on
 * the same locked hexside chain. Leg-mounted weapons may not fire through
 * such a hex (TW p.105). Depth 1 water around the shooter counts: a 'Mech
 * standing in it fires its leg weapons only underwater (TW p.102), which is
 * not modeled (VISION §4).
 */
export function shooterInPartialCover(
  state: BattleState,
  attacker: UnitState,
  target: UnitState,
  side: LosSide = losSideFor(state, attacker, target),
): boolean {
  if (attacker.prone) return false;
  const cell = cellAt(state, attacker.position);
  if (cell.terrain === "water1") return true;
  // A target whose LOS level is above the shooter's is fired at uphill: the
  // shooter is not behind cover from it (TW p.102, mirrored).
  const attackerLos = unitLosLevel(state, attacker.position, false);
  const targetLos = unitLosLevel(state, target.position, target.prone);
  if (targetLos > attackerLos) return false;
  for (const h of interveningHexes(attacker.position, target.position, side)) {
    if (!isAdjacent(h, attacker.position)) continue;
    const c = cellAt(state, h);
    const effectiveLevel = isBuildingTerrain(c.terrain) ? c.level + 2 : c.level;
    if (effectiveLevel >= cell.level + 1) return true;
  }
  return false;
}

/** Facing from `from` to the adjacent hex `to`, or undefined when not adjacent. */
/** LOS endpoint postures for an attack from `from` against `to`. A unit that
 *  declared a DFA is in the air until the physical phase: for LOS it sits two
 *  levels above the higher of its own hex and its target's hex (TW p.149). */
export function losEnds(state: BattleState, from: UnitState, to: UnitState): ProneEnds {
  const level = (u: UnitState): number | undefined => {
    const charge = u.meleeCharge;
    if (charge?.kind !== "dfa") return undefined;
    return Math.max(groundLevel(state, u.position), groundLevel(state, charge.hex)) + 2;
  };
  const fromLevel = level(from);
  const toLevel = level(to);
  return {
    from: from.prone,
    to: to.prone,
    ...(fromLevel !== undefined ? { fromLevel } : {}),
    ...(toLevel !== undefined ? { toLevel } : {}),
  };
}

export function facingToward(from: HexCoord, to: HexCoord): Facing | undefined {
  return FACINGS.find((f) => sameHex(neighbor(from, f), to));
}

/**
 * Arm a prone volley props itself up on, inferred from its declared weapons:
 * a volley with left-arm weapons props on the right arm and vice versa.
 * Null when standing, or when a prone volley fires no arm-mounted weapons.
 */
export function inferPronePropArm(
  def: ResolvedMechDef,
  decls: readonly WeaponAttackDecl[],
  prone: boolean,
): ArmLocation | null {
  if (!prone) return null;
  let hasLeft = false;
  let hasRight = false;
  for (const decl of decls) {
    const loc = def.weapons[decl.weaponIndex]?.location;
    if (loc === "leftArm") hasLeft = true;
    if (loc === "rightArm") hasRight = true;
  }
  if (hasLeft && hasRight) return null;
  if (hasLeft) return "rightArm";
  if (hasRight) return "leftArm";
  return null;
}
