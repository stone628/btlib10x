import { sameHex } from "../../core/hex";
import { type HexCoord, hexKey } from "../../core/types";
import { type MechModelHolder, mechDefFor } from "../../data/index";
import type { UnitDamageState } from "../damage";
import * as mv from "../movement";
import type { BattleState, Phase, TeamId, UnitState, WreckageEntry } from "./types";

/** True when `n` is a legal team id (1 or 2). */
export function isValidTeam(n: number): n is TeamId {
  return n === 1 || n === 2;
}

export function requireUnit(state: BattleState, unitId: string): UnitState {
  const unit = state.units[unitId];
  if (!unit) throw new Error(`Unknown unit id: ${unitId}`);
  return unit;
}

/** Tonnage of the unit's mech chassis. Reads the catalog def; throws on
 *  unknown models. TW weight class boundaries run 20/35/55/75/100; rule code
 *  using tonnage (e.g. the wreckage threshold, `WRECKAGE_TONNAGE_MIN`) keys
 *  off the raw `tonnage` field, not the human-friendly `weightClass` label. */
export function unitTonnage(h: MechModelHolder): number {
  return mechDefFor(h).tonnage;
}

export function isNominal(unit: UnitState) {
  return unit.shutdown === "not";
}

export function isShutdown(unit: UnitState) {
  return unit.shutdown !== "not";
}

/** Out of play as an actor: destroyed, or its pilot gone (a hull still sits
 *  on the board, see `isUnitOnBoard`). */
export function isUnitRemoved(unit: UnitState): boolean {
  return unit.removed !== "not";
}

/** Active on the board: can move, attack and make heat choices. */
export function isUnitAvailable(unit: UnitState): boolean {
  return unit.removed === "not";
}

/** An abandoned 'Mech (TO:AR pp.184-185): the pilot is gone (ejected,
 *  killed or stepped out) and the frame is intact. It stays on the board as
 *  a neutral, permanently shut-down unit that both sides may target, that
 *  any unit may move through but none may end movement on, and that never
 *  rolls a PSR (an event that would call for one drops it, TW p.60). */
export function isHull(unit: UnitState): boolean {
  return (
    (unit.removed === "pilotEjected" ||
      unit.removed === "pilotKilled" ||
      unit.removed === "pilotAbandoned") &&
    unit.destroyed === "not"
  );
}

/** On the board: an active unit or a hull. Destroyed units are not. */
export function isUnitOnBoard(unit: UnitState): boolean {
  return unit.removed === "not" || isHull(unit);
}

/** True when `unit` may be the target of `attacker`'s weapon or physical
 *  attack as far as sides go: any enemy, or a hull of either team. */
export function isTargetableBy(attacker: UnitState, target: UnitState): boolean {
  return isHull(target) || target.team !== attacker.team;
}

export function requirePhase(state: BattleState, phase: Phase): void {
  if (state.phase !== phase) {
    throw new Error(`Expected phase ${phase}, but battle is in ${state.phase}`);
  }
}

/** Unit on the board in `hex` (an active unit or a hull), if any. */
export function occupantAt(
  state: BattleState,
  hex: HexCoord,
  excludeId?: string,
): UnitState | undefined {
  for (const unit of Object.values(state.units)) {
    if (!isUnitOnBoard(unit) || unit.id === excludeId) continue;
    if (sameHex(unit.position, hex)) return unit;
  }
  return undefined;
}

/** Stacking view of `hex` for `reachableLandings`: the occupant's team, or
 *  `mv.NEUTRAL_TEAM` for a hull (passable by all, landable by none), or
 *  undefined when empty. */
export function occupantTeamAt(
  state: BattleState,
  hex: HexCoord,
  excludeId?: string,
): number | undefined {
  const occupant = occupantAt(state, hex, excludeId);
  if (occupant === undefined) return undefined;
  return isHull(occupant) ? mv.NEUTRAL_TEAM : occupant.team;
}

export function cloneDamage(damage: UnitDamageState): UnitDamageState {
  return {
    armor: { ...damage.armor },
    armorRear: { ...damage.armorRear },
    internalStructure: { ...damage.internalStructure },
  };
}

/** The destroyed 'Mechs whose wreckage lies in `hex` (TO:AR p.155), in
 *  order; empty when the hex holds none. */
export function wreckageAt(state: BattleState, hex: HexCoord): readonly WreckageEntry[] {
  return state.wreckage[hexKey(hex)] ?? [];
}

/** True when battlefield wreckage lies in `hex`: ground entry pays its Rough
 *  surcharge (TO:AR p.155; `wreckageMoveCost`). */
export function hasWreckage(state: BattleState, hex: HexCoord): boolean {
  return wreckageAt(state, hex).length > 0;
}
