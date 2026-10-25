import { damageTransferTo, isArm, isTorso, LOCATIONS, type Location } from "../../core/types";
import type { ResolvedMechDef } from "../../data/mech.schema";
import { type CritMask, isSlotDestroyed } from "../critical";
import type { UnitDamageState } from "../damage";
import type { BattleState, KillCredit, NewStructureHit, UnitState } from "./types";

/**
 * Record `n` marked points `target` took, from `attackerId` (null: no
 * attacker, e.g. its own fall, recoil, heat or a collapse). They count toward
 * the window's 20-point total only when `target` is in the window's scope;
 * an attacker's points go to the battle-long `damageTakenFrom` and to the
 * window's kill credit.
 */
export function creditDealt(
  state: BattleState,
  target: UnitState,
  attackerId: string | null,
  n: number,
): void {
  if (n <= 0) return;
  const window = state.currentDealt;
  if (window !== undefined && window.before.damage[target.id] !== undefined) {
    window.total[target.id] = (window.total[target.id] ?? 0) + n;
  }
  if (attackerId === null || attackerId === target.id) return;
  target.damageTakenFrom[attackerId] = (target.damageTakenFrom[attackerId] ?? 0) + n;
  if (window === undefined) return;
  const dealt = window.byAttacker[target.id] ?? {};
  dealt[attackerId] = (dealt[attackerId] ?? 0) + n;
  window.byAttacker[target.id] = dealt;
}

/**
 * Kill credit for `unit` as it leaves play: every enemy that damaged it in
 * the damage window that removed it (the weapon or physical sub-pass, with
 * its piloting sweep, or the move whose accidental fall hit it), by share of
 * the armor + structure points each dealt there. Attacks in a sub-pass
 * resolve simultaneously, so every hit in it shares the kill, not only the
 * last one resolved. Empty when no enemy dealt damage in it (heat, a
 * unit's own fall, ejection, abandonment). Largest share first, then unit
 * id.
 */
export function killCredit(state: BattleState, unit: UnitState): KillCredit[] {
  const dealt: [string, number][] = [];
  let total = 0;
  for (const [id, points] of Object.entries(state.currentDealt?.byAttacker[unit.id] ?? {})) {
    const attacker = state.units[id];
    if (attacker === undefined || attacker.team === unit.team || points <= 0) continue;
    dealt.push([id, points]);
    total += points;
  }
  return dealt
    .map(([unitId, damage]) => ({ unitId, damage, share: damage / total }))
    .sort((a, b) => b.damage - a.damage || (a.unitId < b.unitId ? -1 : 1));
}

/**
 * Total armor + structure points lost between two damage states. Fallback
 * for the 20-point PSR trigger when the window's totals miss the unit
 * (a window filled by hand, damage outside any window):
 * unlike the ledger it also counts step-5 wiped armor (TW p.122), since a
 * before/after diff cannot tell wiped pools from hit ones.
 */
export function damageTaken(before: UnitDamageState, after: UnitDamageState): number {
  let n = 0;
  for (const loc of LOCATIONS) {
    // An arm lost with its side torso is blown off, not damaged point by
    // point (TW p.121): its remaining armor and structure do not count.
    if (isArm(loc)) {
      const torso = damageTransferTo(loc);
      if (
        torso !== null &&
        before.internalStructure[torso] > 0 &&
        after.internalStructure[torso] <= 0
      )
        continue;
    }
    n += Math.max(0, before.armor[loc] - after.armor[loc]);
    if (isTorso(loc)) {
      n += Math.max(0, (before.armorRear[loc] ?? 0) - (after.armorRear[loc] ?? 0));
    }
    n += Math.max(0, before.internalStructure[loc] - after.internalStructure[loc]);
  }
  return n;
}

/** Structure slots destroyed now that were intact in the phase snapshot. */
export function newlyDestroyedStructures(
  def: ResolvedMechDef,
  before: Readonly<CritMask>,
  now: Readonly<CritMask>,
): NewStructureHit[] {
  const out: NewStructureHit[] = [];
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    const layout = def.critSlots[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind !== "structure") continue;
      if (isSlotDestroyed(now, loc, i) && !isSlotDestroyed(before, loc, i)) {
        out.push({ location: loc, name: slot.type });
      }
    }
  }
  return out;
}
