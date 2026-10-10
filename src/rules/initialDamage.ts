/**
 * Starting damage for a unit (`UnitInit.damage`): armor / structure already
 * lost, crit slots already destroyed, ammo already fired, pilot hits taken.
 *
 * `resolveInitialDamage` is pure. It turns the description into the starting
 * `UnitState` pieces, validating it against the 'Mech definition, and rejects
 * states in which the unit would already be out of play (the same kill
 * conditions the runtime applies: head or center torso structure gone, a
 * cockpit slot destroyed, three engine slots destroyed, a dead pilot).
 * Crippled-but-alive states (destroyed gyro, both legs, no arms) are legal;
 * a unit that lost a leg or its gyro starts prone, as it would have fallen
 * (TW p.122 for legs, the gyro row of the critical-hit table for gyros).
 */

import type { Location } from "../core/types";
import { armFor, isLocation, isTorso, LOCATIONS } from "../core/types";
import type { ResolvedMechDef } from "../data/mech.schema";
import { type AmmoBins, ammoBinId, loadAmmoBins, stripBinsInLocation } from "./ammo";
import {
  COCKPIT,
  type CritMask,
  countDestroyedEngine,
  countDestroyedGyro,
  ENGINE_SLOTS_KILL,
  emptyCritTable,
  isSlotDestroyed,
  setSlotDestroyed,
} from "./critical";
import {
  destroyedLegs,
  type LocationValue,
  type TorsoLocationValue,
  type UnitDamageState,
} from "./damage";
import { GYRO_DESTROYED_HITS } from "./piloting";

/** Starting damage of one unit. Every field is optional; absent = pristine. */
export interface UnitInitDamage {
  /** Pilot hits already taken (`0 <= n < pilotHitMax`). */
  pilotHits?: number;
  /** Damage TAKEN per pool relative to the model default (not remaining). */
  damageTaken?: {
    /** Front armor (torso = front pool). */
    armor?: Partial<LocationValue>;
    /** Rear torso armor. */
    armorRear?: Partial<TorsoLocationValue>;
    internalStructure?: Partial<LocationValue>;
  };
  /** Destroyed crit slots per location, as 1-based slot numbers. */
  critsDestroyed?: Partial<Record<Location, number[]>>;
  /** Shots already used per ammo bin, keyed by `AmmoBinId` (`"leftTorso:1"`). */
  ammoUsed?: Record<string, number>;
}

/** Everything `createBattle` needs to seed a unit with its starting damage. */
export interface ResolvedInitialDamage {
  damage: UnitDamageState;
  critSlotsDestroyed: CritMask;
  ammoBins: AmmoBins;
  destroyedWeapons: number[];
  pilotHits: number;
  prone: boolean;
}

function fail(id: string, msg: string): never {
  throw new Error(`Starting damage for ${id}: ${msg}`);
}

function requireCount(id: string, what: string, n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    fail(id, `${what} must be an integer >= 0`);
  }
  return n;
}

function requireLocation(id: string, key: string): Location {
  if (!isLocation(key)) fail(id, `unknown location ${JSON.stringify(key)}`);
  return key;
}

/**
 * Subtract `taken` from one pool. `limit` is the model default for the pool,
 * so a location missing from it (rear armor off the torsos) has no such pool.
 */
function takeFromPool(
  id: string,
  what: string,
  pool: Record<string, number>,
  limit: Readonly<Record<string, number>>,
  taken: object | undefined,
): void {
  for (const [key, raw] of Object.entries(taken ?? {})) {
    const loc = requireLocation(id, key);
    const max = limit[loc];
    if (max === undefined) fail(id, `${loc} has no ${what}`);
    const n = requireCount(id, `${what} taken at ${loc}`, raw);
    if (n > max) fail(id, `${what} taken at ${loc} (${n}) exceeds ${max}`);
    pool[loc] = max - n;
  }
}

export function resolveInitialDamage(
  def: ResolvedMechDef,
  id: string,
  init: UnitInitDamage | undefined,
  pilotHitMax: number,
): ResolvedInitialDamage {
  const taken = init?.damageTaken;
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear: { ...def.armorRear },
    internalStructure: { ...def.internalStructure },
  };

  // 1. Pools.
  takeFromPool(id, "armor", damage.armor, def.armor, taken?.armor);
  takeFromPool(id, "rear armor", damage.armorRear, def.armorRear, taken?.armorRear);
  takeFromPool(
    id,
    "structure",
    damage.internalStructure,
    def.internalStructure,
    taken?.internalStructure,
  );

  // 2. Structure is only reachable through depleted armor, and a lost side
  //    torso takes its arm with it (mirrors `applyDamage`).
  for (const loc of LOCATIONS) {
    if (damage.internalStructure[loc] < def.internalStructure[loc]) {
      const frontGone = damage.armor[loc] === 0;
      const rearGone = isTorso(loc) && damage.armorRear[loc] === 0;
      if (!frontGone && !rearGone) {
        fail(id, `${loc} lost structure while its armor is not depleted`);
      }
    }
    const arm = armFor(loc);
    if (
      arm !== undefined &&
      damage.internalStructure[loc] === 0 &&
      (damage.internalStructure[arm] > 0 || damage.armor[arm] > 0)
    ) {
      fail(id, `${loc} is destroyed but ${arm} is not`);
    }
  }

  // 3. Crit slots (1-based numbers in, 0-based flag arrays out).
  const critSlotsDestroyed = emptyCritTable(def);
  const destroyedWeapons = new Set<number>();
  const destroyedAmmo: string[] = [];
  for (const [key, nums] of Object.entries(init?.critsDestroyed ?? {})) {
    const loc = requireLocation(id, key);
    const layout = def.critSlots[loc];
    const seen = new Set<number>();
    for (const n of nums ?? []) {
      if (!Number.isInteger(n) || n < 1 || n > layout.length) {
        fail(id, `${loc} has no crit slot ${n}`);
      }
      if (seen.has(n)) fail(id, `${loc} crit slot ${n} listed twice`);
      seen.add(n);
      const slot = layout[n - 1]!;
      if (slot.kind === "empty") fail(id, `${loc} crit slot ${n} is empty`);
      setSlotDestroyed(critSlotsDestroyed, loc, n - 1);
      if (slot.kind === "weapon") {
        destroyedWeapons.add(slot.weaponIndex);
      } else if (slot.kind === "ammo") {
        destroyedAmmo.push(ammoBinId(loc, n));
      }
    }
  }

  // 4. Ammo: used shots come off the loaded count; a destroyed bin is empty.
  const ammoBins = loadAmmoBins(def);
  for (const [binId, raw] of Object.entries(init?.ammoUsed ?? {})) {
    const shots = ammoBins[binId];
    if (shots === undefined) fail(id, `no ammo bin ${JSON.stringify(binId)}`);
    const used = requireCount(id, `ammo used in ${binId}`, raw);
    if (used > shots) fail(id, `ammo used in ${binId} (${used}) exceeds ${shots}`);
    ammoBins[binId] = shots - used;
  }
  for (const binId of destroyedAmmo) ammoBins[binId] = 0;
  // A destroyed location loses its bins, as in play (TW p.123).
  for (const loc of LOCATIONS) {
    if (damage.internalStructure[loc] <= 0) stripBinsInLocation(ammoBins, loc);
  }

  // 5. Pilot.
  const pilotHits = requireCount(id, "pilotHits", init?.pilotHits ?? 0);

  // 6. Gates: states that would already be out of play (reasons match
  //    `DestroyedReason`; the counters are the ones the runtime uses).
  const unplayable = (reason: string): never => fail(id, `unit would start destroyed (${reason})`);
  if (damage.internalStructure.head <= 0) unplayable("headDestroyed");
  if (damage.internalStructure.centerTorso <= 0) unplayable("centerTorsoDestroyed");
  const cockpit = def.critSlots.head.some(
    (slot, i) =>
      slot.kind === "structure" &&
      slot.name === COCKPIT &&
      isSlotDestroyed(critSlotsDestroyed, "head", i),
  );
  if (cockpit) unplayable("cockpitDestroyed");
  if (countDestroyedEngine(def, damage, critSlotsDestroyed) >= ENGINE_SLOTS_KILL) {
    unplayable("engineDestroyed");
  }
  if (pilotHits >= pilotHitMax) fail(id, `pilotHits (${pilotHits}) must be below ${pilotHitMax}`);

  // 7. Posture: a lost leg or gyro means the 'Mech has already fallen.
  const prone =
    destroyedLegs(damage) > 0 ||
    countDestroyedGyro(def, damage, critSlotsDestroyed) >= GYRO_DESTROYED_HITS;

  return {
    damage,
    critSlotsDestroyed,
    ammoBins,
    destroyedWeapons: [...destroyedWeapons],
    pilotHits,
    prone,
  };
}
