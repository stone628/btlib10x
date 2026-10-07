/**
 * Arm actuator weapon-fire modifiers (BattleTech Total Warfare, p.125).
 *
 *   - shoulder destroyed in the firing arm: +4 to all weapon attacks from
 *     that arm, ignoring any other weapon-fire modifiers from crits in it.
 *   - upper / lower arm actuator destroyed: +1 each to weapons in that arm
 *     (cumulative when the shoulder is intact).
 *   - hand actuator: no weapon-fire effect (physical attacks only, deferred).
 *   - non-arm mounts: 0.
 *
 * A 'Mech built without an actuator carries no slot for it, so there is
 * nothing to destroy and no weapon modifier — matching TW p.145 ("suffers
 * no weapon modifier"). Physical-attack effects of actuators are deferred
 * with the physical attack phase.
 */

import type { ArmLocation, Location } from "../core/types";
import { isArm, LOCATIONS } from "../core/types";
import type { ResolvedMechDef } from "../data/mech.schema";
import { destroyedStructures } from "./critical";
import type { WeaponDef } from "../data/weapon.schema";
import { isUnitLocationDestroyed, type UnitDamageState } from "./damage";

/** Weapon to-hit penalty for a destroyed shoulder in the firing arm (TW p.125). */
export const SHOULDER_WEAPON_MOD = 4;
/** Weapon to-hit penalty per destroyed upper/lower arm actuator (TW p.125). */
export const ARM_ACTUATOR_WEAPON_MOD = 1;

export interface ArmActuatorCounts {
  readonly shoulder: number;
  readonly upper: number;
  readonly lower: number;
  readonly hand: number;
}

/** Destroyed-actuator counts in one arm location. */
export function countArmActuators(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
  arm: ArmLocation,
): ArmActuatorCounts {
  let shoulder = 0;
  let upper = 0;
  let lower = 0;
  let hand = 0;
  for (const n of destroyedStructures(def, damage, destroyed, arm)) {
    switch (n) {
      case "shoulder": {
        shoulder += 1;
        break;
      }
      case "upperArmActuator": {
        upper += 1;
        break;
      }
      case "lowerArmActuator": {
        lower += 1;
        break;
      }
      case "handActuator": {
        hand += 1;
        break;
      }
    }
  }
  return { shoulder, upper, lower, hand };
}

/**
 * Weapon to-hit modifier for a mount in `location`: +4 when its arm's
 * shoulder is destroyed (other arm-crit weapon mods suppressed), else +1
 * per destroyed upper/lower actuator in that arm. Non-arm mounts score 0.
 */
/**
 * Arm actuators the design never had. A 'Mech without a lower arm actuator
 * or hand punches as if it were damaged (TW p.145): an absent upper/lower
 * actuator adds +2 and halves the damage like a destroyed one, an absent
 * hand adds +1; a club needs a hand (TW p.146).
 */
export function absentArmActuators(
  def: ResolvedMechDef,
  arm: ArmLocation,
): { upper: number; lower: number; hand: number } {
  const names = new Set<string>();
  for (const s of def.critSlots[arm]) if (s.kind === "structure") names.add(s.name);
  return {
    upper: names.has("upperArmActuator") ? 0 : 1,
    lower: names.has("lowerArmActuator") ? 0 : 1,
    hand: names.has("handActuator") ? 0 : 1,
  };
}

export function armWeaponToHitModifier(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
  location: Location,
): number {
  if (!isArm(location)) return 0;
  const counts = countArmActuators(def, damage, destroyed, location);
  if (counts.shoulder > 0) return SHOULDER_WEAPON_MOD;
  return (counts.upper + counts.lower) * ARM_ACTUATOR_WEAPON_MOD;
}

/** To-hit bonus of a targeting computer for an eligible weapon (TW p.143). */
export const TARGETING_COMPUTER_MOD = -1;

/**
 * -1 for direct-fire energy and ballistic weapons (flamers and machine guns
 * excepted, TW p.113) when the 'Mech carries a targeting computer whose
 * slots are all intact and whose location still stands. Aimed shots (the
 * +3 alternative) belong to the aimed-shot system, which is not modelled.
 */
export function targetingComputerModifier(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
  weapon: WeaponDef,
): number {
  if (weapon.category !== "ENERGY" && weapon.category !== "BALLISTIC") return 0;
  if (/Flamer|Machine Gun/.test(weapon.name)) return 0;
  let fitted = false;
  for (const loc of LOCATIONS) {
    const slots = def.critSlots[loc];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot?.kind !== "structure" || slot.name !== "targetingComputer") continue;
      fitted = true;
      if (destroyed[loc]?.[i] === true || isUnitLocationDestroyed(damage, loc)) return 0;
    }
  }
  return fitted ? TARGETING_COMPUTER_MOD : 0;
}
