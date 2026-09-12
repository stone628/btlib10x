/**
 * Critical hit resolution (BattleTech Total Warfare subset).
 *
 * Whenever a hit strips internal structure from a location, the player rolls
 * 2D6 on the Determining Critical Hits table:
 *
 *   2 - 7  : no critical hit
 *   8 - 9  : 1 critical hit
 *   10 - 11: 2 critical hits
 *   12     : if the location is head / arm / leg, the limb is blown off;
 *            otherwise (torso) 3 critical hits
 *
 * For each critical hit, the player rolls the slot number:
 *   - head & legs (6 slots):  1D6
 *   - torso & arms (12 slots): 2D6 — first die selects the half
 *     (1-3 -> slots 1-6, 4-6 -> slots 7-12), second die the slot within
 *
 * Empty slots, soak (endo steel / CASE / ferro-fibrous) and already-destroyed
 * slots re-roll. If the source location has no crit-hittable slot remaining
 * (either because every slot was previously critted or because there is
 * literally no equipment to hit), the determining roll transfers to the next
 * inward location per the standard damage-transfer diagram. Head and center
 * torso do not transfer — excess crits on a terminal source are lost, and so
 * are excess crits when the source still has hittable slots left at the start
 * of this determining (the rules call these "lost", not transferred).
 *
 * Effects implemented in this subset:
 *   - weapon slot hit: that weapon is destroyed (multi-slot weapons:
 *     first hit disables the whole mount; further slot hits on the same
 *     component only "soak").
 *   - ammo slot hit: explosion damage = per-shot damage value x remaining
 *     shots in that bin, applied directly to the bin's location's internal
 *     structure (the armor pool is bypassed). Only the hit bin detonates;
 *     sibling bins of the same weapon are untouched. An ammo explosion that
 *     strips more IS triggers a fresh determining roll, recursively, and
 *     ammo in any location whose IS drops to 0 is gone. Every ammo explosion
 *     also injures the pilot (2 hits + consciousness rolls, TW p.41).
 *   - limb blown off (determining 12 on head/arm/leg): the location's armor
 *     and internal structure are zeroed, killing the head or immobilizing
 *     the leg. An arm is removed from play; its support torso's IS is not
 *     affected. A destroyed leg drops the 'Mech automatically (TW p.60).
 *   - cockpit slot hit: the pilot is killed (the 'Mech is destroyed).
 *   - leg actuator (upper/lower/foot) and hip: recorded as destroyed,
 *     accounted for by the effective-movement helper, and each forces its
 *     own PSR at the end of the phase (+1 / +2, TW p.60).
 *   - first gyro hit: forces a PSR at +3 at the end of the phase; a
 *     destroyed gyro drops the 'Mech automatically. All PSRs also take +3
 *     from a previously hit gyro (preexisting damage, TW p.60).
 *   - sensor slots: each destroyed sensor adds +1 to the unit's weapon
 *     to-hit numbers (TW p.123).
 *   - life-support slot: a destroyed life support injures the pilot at the
 *     end of any heat phase whose post-dissipation heat is 15+ (1 hit) or
 *     26+ (2 hits) (TW p.41).
 *   - jump jet slot: jump MP reduced by 1.
 *   - ammo explosions in CASE-protected locations: CASE (explicit slot, or
 *     implicit on Clan side torsos) contains the blast — it vents rest of
 *     damage out of the location if explosion damage exceeds internal
 *     structure point and never reaches the center torso; CASE II
 *     additionally caps the blast damage at 1 point total.
 *
 * Effects that exist in the official rules but are not modeled here because
 * the current engine subset lacks heat / physical attacks:
 *   - engine crits feed heat only (no eventual shutdown modeling beyond the
 *     heat scale)
 *   - arm actuators, shoulder, hand (to-hit / physical-attack penalties)
 *
 * The engine's rules functions are pure given their inputs and operate on
 * snapshots; the caller (game.ts) commits the resulting state onto UnitState.
 */

import { roll2D6, rollD6 } from "../core/dice.js";
import { damageTransferTo, isArm, isLeg, isLimb, isSideTorso } from "../core/locations.js";
import type { Location, Rng } from "../core/types.js";
import { type AmmoNameHolder, getAmmoDefFor } from "../data/ammo.schema.js";
import type {
  ResolvedCritSlot,
  ResolvedCritStructure,
  ResolvedMechDef,
} from "../data/mech.schema.js";
import { CRIT_SLOT_COUNTS } from "../data/mech.schema.js";
import { getWeaponDefFor } from "../data/weapon.schema.js";
import { type AmmoBinState, type AmmoBins, ammoBinId, stripBinsInLocation } from "./ammo.js";
import { applyDamage, type DamageApplication, type UnitDamageState } from "./damage.js";

export interface CritSource {
  /** Location where the original hit stripped at least 1 internal-structure point. */
  readonly location: Location;
  /** Damage value applied at the source location (used for ammo-explosion trace). */
  readonly damage: number;
}

export type CriticalEffect =
  | {
      readonly kind: "weaponDestroyed";
      readonly location: Location;
      readonly slotIndex: number;
      readonly rolls: readonly number[];
      readonly transferred: boolean;
      readonly weaponIndex: number;
      readonly weaponName: string;
    }
  | {
      readonly kind: "ammoExplosion";
      readonly location: Location;
      readonly slotIndex: number;
      readonly rolls: readonly number[];
      readonly transferred: boolean;
      readonly weaponIndex: number;
      readonly weaponName: string;
      readonly shotsRemaining: number;
      readonly damagePerShot: number;
      readonly damage: number;
      /** The damage application that hit the bin's location's IS directly. */
      readonly application: DamageApplication;
    }
  | {
      /** Crit hit a non-explosive ammo bin (e.g. gauss rifle). The slot
       *  still takes the crit, the bin empties, but no explosion damage. */
      readonly kind: "ammoNoExplosion";
      readonly location: Location;
      readonly slotIndex: number;
      readonly rolls: readonly number[];
      readonly transferred: boolean;
      readonly weaponIndex: number;
      readonly weaponName: string;
    }
  | {
      readonly kind: "headBlownOff";
      readonly rolls: readonly number[];
    }
  | {
      readonly kind: "armBlownOff";
      readonly arm: Location;
      readonly rolls: readonly number[];
    }
  | {
      readonly kind: "legBlownOff";
      readonly leg: Location;
      readonly rolls: readonly number[];
    }
  | {
      readonly kind: "cockpitDestroyed";
      readonly location: Location;
      readonly slotIndex: number;
      readonly rolls: readonly number[];
      readonly transferred: boolean;
    }
  | {
      readonly kind: "componentDestroyed";
      readonly location: Location;
      readonly slotIndex: number;
      readonly rolls: readonly number[];
      readonly transferred: boolean;
      /** A name like "engine", "gyro", "heatSink", "doubleHeatSink", "shoulder", etc. */
      readonly name: string;
    }
  | {
      readonly kind: "noEffect";
      readonly rolls: readonly number[];
    };

export interface CriticalResolution {
  readonly source: CritSource;
  /** Determining roll (2D6 sum) for the table itself. */
  readonly determiningRoll: number;
  readonly rows: readonly CriticalEffect[];
  /** Per-location per-slot destroyed flags after this resolution. */
  readonly critSlotsDestroyed: Record<Location, boolean[]>;
  /** Weapon indices destroyed (newly added) by these crits. */
  readonly destroyedWeapons: number[];
  /** Final damage state after any ammo-explosion cascades have applied. */
  readonly damage: UnitDamageState;
  /** Limbs blown off (after this determining's effects, in addition to those
   *  present in the input state). */
  readonly blownOffArms: readonly Location[];
  /** True if the unit is killed by these crits (head or CT IS to 0, or
   *  cockpit destroyed, or 12 on a head location). */
  readonly killed: boolean;
  /** Per-crit-slot ammo state after this resolution. */
  readonly ammoBins: AmmoBins;
}

const LEG_ACTUATORS: ReadonlySet<string> = new Set([
  "upperLegActuator",
  "lowerLegActuator",
  "footActuator",
]);
const HIP = "hip";
const COCKPIT = "cockpit";
const JUMPJET = "jumpJet";

/**
 * Is the given static slot capable of taking a critical hit (i.e. its
 * component is a weapon, ammo, or structure — not empty, not soak)?
 */
function isCritHittableStatic(slot: ResolvedCritSlot): boolean {
  if (slot.kind === "empty") return false;
  if (slot.kind === "soak") return false;
  return true;
}

/** Is the location's hittable inventory exhausted (no non-empty non-soak slot remains undestroyed)? */
function isLocationExhausted(
  layout: readonly ResolvedCritSlot[],
  destroyed: readonly boolean[],
): boolean {
  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i] ?? { kind: "empty" };
    if (isCritHittableStatic(slot) && !(destroyed[i] ?? false)) return false;
  }
  return true;
}

/** 2D6 determining critical hits. */
function determiningResult(
  rng: Rng,
  sourceLoc: Location,
):
  | { kind: "none"; roll: number }
  | { kind: "hits"; count: number; roll: number }
  | { kind: "blownOff"; roll: number } {
  const r = roll2D6(rng);
  if (r <= 7) return { kind: "none", roll: r };
  if (r <= 9) return { kind: "hits", count: 1, roll: r };
  if (r <= 11) return { kind: "hits", count: 2, roll: r };
  // 12: blow off head/limb; otherwise 3 hits.
  if (sourceLoc === "head") return { kind: "blownOff", roll: r };
  if (isLimb(sourceLoc)) {
    return { kind: "blownOff", roll: r };
  }
  return { kind: "hits", count: 3, roll: r };
}

/**
 * Roll a 1-based slot number for the given location, using the official
 * procedure: 1D6 for head/legs, 2D6 (half + slot) for torso/arms. Returns
 * the dice rolls used so the effect can record them.
 */
function rollSlotNumber(rng: Rng, loc: Location): { slot: number; rolls: readonly number[] } {
  const count = CRIT_SLOT_COUNTS[loc];
  if (count === 6) {
    const r = rollD6(rng);
    return { slot: r, rolls: [r] };
  }
  // 12-slot location: 2D6, first die = half selector, second = slot within half.
  const first = rollD6(rng);
  const second = rollD6(rng);
  const half = first <= 3 ? 0 : 1; // 0 = slots 1-6, 1 = slots 7-12
  const slot = half * 6 + second;
  return { slot, rolls: [first, second] };
}

/**
 * Per-shot damage value used for an ammo explosion. Missiles multiply
 * per-missile damage by tube count; direct-fire weapons use their damage;
 * variable-damage weapons don't carry ammo so this never fires for them.
 */
export function ammoDamagePerShot(h: AmmoNameHolder): number {
  const w = getWeaponDefFor(h);
  if (w.missileDamage !== undefined && w.missiles !== undefined) {
    return w.missileDamage * w.missiles;
  }
  return w.damage ?? 0;
}

/**
 * Find a non-eligible slot in `layout` (one that is empty/soak/destroyed),
 * re-rolling the dice up to a generous cap. Returns the 1-based slot index
 * or null if every reroll hit a non-hittable slot.
 */
function findHittableSlot(
  rng: Rng,
  loc: Location,
  layout: readonly ResolvedCritSlot[],
  destroyed: readonly boolean[],
): { slotIndex: number; rolls: number[] } | null {
  const maxTries = 50;
  for (let i = 0; i < maxTries; i++) {
    const { slot, rolls } = rollSlotNumber(rng, loc);
    const i0 = slot - 1;
    if (i0 < 0 || i0 >= layout.length) continue;
    const staticSlot = layout[i0] ?? { kind: "empty" };
    if (!isCritHittableStatic(staticSlot)) continue;
    if (destroyed[i0]) continue;
    return { slotIndex: slot, rolls: [...rolls] };
  }
  return null;
}

export type CaseKind = "case" | "caseII";

/**
 * returns if given location is protected by case.
 * "caseII" overrides any other case state.
 * Clan mech's have built-in case at all locations
 */
export function checkCASE(def: ResolvedMechDef, location: Location): CaseKind | undefined {
  let hasCase = false;
  for (const cs of def.critSlots[location] ?? []) {
    if (cs.kind === "soak") {
      if (cs.name === "caseII") return "caseII";
      if (cs.name === "case") {
        hasCase = true;
      }
    }
  }
  if (def.techBase === "Clan" || (hasCase && isSideTorso(location))) {
    return "case";
  }
  return undefined;
}

/**
 * Apply an ammo explosion's damage directly to a location's internal
 * structure (bypassing the armor pool per the rules), then let the standard
 * transfer graph apply for any overflow. Returns the resulting application.
 *
 * CASE protection (TW):
 *   - `caseII` — the blast is contained and capped at 1 point of damage to
 *     the location (no overflow, no extra containment damage).
 *   - `case` — the blast is contained: it may still shred the location's
 *     own IS, but it stops there — the excess vents out of the location and
 *     it never reaches the next location.
 */
export function applyAmmoExplosion(
  state: UnitDamageState,
  location: Location,
  amount: number,
  caseKind?: CaseKind,
): DamageApplication {
  if (!Number.isInteger(amount) || amount <= 0) {
    // No-op application: `state` is returned unchanged, so `pre` may alias it.
    return {
      after: state,
      before: state as UnitDamageState,
      steps: [],
      newlyDestroyed: [],
      blownOffArms: [],
      killed: false,
    };
  }
  // Ammo explosions bypass armor at every location in the transfer chain
  // (TW p.125): the blast hits IS directly, and any overflow transfers to
  // the next location's IS — armor is never touched, anywhere.
  return applyDamage(state, location, amount, "front", { caseKind, bypassArmor: true });
}

export interface ResolveCriticalsInput {
  readonly rng: Rng;
  readonly def: ResolvedMechDef;
  readonly source: CritSource;
  /** Pre-damage destroyed-slot flags. */
  readonly critSlotsDestroyed: Record<Location, boolean[]>;
  /** Pre-damage destroyed-weapon indices. */
  readonly destroyedWeapons: readonly number[];
  /** Pre-damage damage state. */
  readonly damage: UnitDamageState;
  /** Current per-crit-slot ammo state. */
  readonly ammoBins: Readonly<AmmoBins>;
}

interface MutableCritState {
  destroyed: Record<Location, boolean[]>;
  destroyedWeapons: number[];
  damage: UnitDamageState;
  ammoBins: AmmoBins;
  rows: CriticalEffect[];
  blownOffArms: Location[];
  killed: boolean;
  /** Guard against pathological recursion in ammo-explosion cascades. */
  depth: number;
}

const MAX_RECURSION = 4;

export function resolveCriticalHits(input: ResolveCriticalsInput): CriticalResolution {
  const state: MutableCritState = {
    destroyed: cloneDestroyed(input.critSlotsDestroyed),
    destroyedWeapons: [...input.destroyedWeapons],
    damage: {
      armor: { ...input.damage.armor },
      armorRear: { ...input.damage.armorRear },
      internalStructure: { ...input.damage.internalStructure },
    },
    ammoBins: { ...input.ammoBins },
    rows: [],
    blownOffArms: [],
    killed: false,
    depth: 0,
  };
  const topRoll = runDetermining(input.rng, input.def, input.source, state);
  // Ammo in a location whose IS has dropped to 0 (explosion transfer,
  // blow-off, cockpit kill) can no longer detonate; remove those bins so
  // subsequent crits and the committed state stay consistent.
  stripBinsInZeroedLocations(input.def, state);
  return {
    source: input.source,
    determiningRoll: topRoll ?? 0,
    rows: state.rows,
    critSlotsDestroyed: state.destroyed,
    destroyedWeapons: state.destroyedWeapons,
    damage: state.damage,
    blownOffArms: state.blownOffArms,
    killed: state.killed,
    ammoBins: state.ammoBins,
  };
}

/** Remove bins in any location whose internal structure has reached zero. */
function stripBinsInZeroedLocations(def: ResolvedMechDef, state: MutableCritState): void {
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    if ((state.damage.internalStructure[loc] ?? 0) <= 0) {
      stripBinsInLocation(state.ammoBins, loc);
    }
  }
}

/**
 * Internal: run a single determining-roll against the source (or its
 * transfer target when the source is exhausted) and apply its effects.
 * Returns the 2D6 sum at the top-level call so callers can show it.
 */
function runDetermining(
  rng: Rng,
  def: ResolvedMechDef,
  source: CritSource,
  state: MutableCritState,
): number | null {
  if (state.depth > MAX_RECURSION) return null;
  state.depth += 1;
  const det = determiningResult(rng, source.location);
  // 12 on head/arm/leg = blown off; arms/legs/head are handled here, the
  // source is the original hit location in this determining's call chain.
  if (det.kind === "blownOff") {
    if (source.location === "head") {
      zeroLocation(state, "head");
      state.damage.armor.head = 0;
      state.damage.internalStructure.head = 0;
      state.killed = true;
      state.rows.push({ kind: "headBlownOff", rolls: [det.roll] });
    } else if (isArm(source.location)) {
      zeroLocation(state, source.location);
      state.damage.armor[source.location] = 0;
      state.damage.internalStructure[source.location] = 0;
      state.blownOffArms.push(source.location);
      state.rows.push({ kind: "armBlownOff", arm: source.location, rolls: [det.roll] });
    } else if (isLeg(source.location)) {
      zeroLocation(state, source.location);
      state.damage.armor[source.location] = 0;
      state.damage.internalStructure[source.location] = 0;
      state.rows.push({ kind: "legBlownOff", leg: source.location, rolls: [det.roll] });
    }
    state.depth -= 1;
    return det.roll;
  }
  if (det.kind === "none") {
    state.depth -= 1;
    return det.roll;
  }
  // det.count hits: walk the determining against the source. If the source
  // is exhausted (no hittable slot remaining at the start of THIS
  // determining), the whole thing transfers inward; otherwise excess is
  // lost.
  const sourceLayout = def.critSlots[source.location];
  const sourceDestroyed = state.destroyed[source.location];
  const exhausted = isLocationExhausted(sourceLayout, sourceDestroyed);
  if (exhausted) {
    const next = damageTransferTo(source.location);
    if (next === null) {
      for (let i = 0; i < det.count; i++) {
        state.rows.push({ kind: "noEffect", rolls: [] });
      }
      state.depth -= 1;
      return det.roll;
    }
    runDetermining(rng, def, { ...source, location: next }, state);
    state.depth -= 1;
    return det.roll;
  }
  let remaining = det.count;
  while (remaining > 0) {
    const found = findHittableSlot(rng, source.location, sourceLayout, sourceDestroyed);
    if (!found) {
      for (let i = 0; i < remaining; i++) {
        state.rows.push({ kind: "noEffect", rolls: [] });
      }
      remaining = 0;
      break;
    }
    applySlotHit(rng, def, source.location, found.slotIndex, found.rolls, state, false);
    remaining -= 1;
  }
  state.depth -= 1;
  return det.roll;
}

/**
 * Apply a single crit hit at `slotIndex` in `loc`. Dispatches on the slot's
 * component to produce the appropriate effect. Marks the slot destroyed and
 * mutates ammo / damage / destroyed-weapons / blownOffArms / killed.
 */
function applySlotHit(
  rng: Rng,
  def: ResolvedMechDef,
  loc: Location,
  slotIndex: number,
  rolls: readonly number[],
  state: MutableCritState,
  transferred: boolean,
): void {
  const i0 = slotIndex - 1;
  const layout = def.critSlots[loc];
  const slot = layout[i0] ?? { kind: "empty" };
  if (slot.kind === "empty" || slot.kind === "soak") {
    state.rows.push({ kind: "noEffect", rolls: rolls.slice() });
    return;
  }
  state.destroyed[loc][i0] = true;
  if (slot.kind === "weapon") {
    // Disable the linked mount. First hit on any of a multi-slot weapon's
    // slots destroys the whole mount; further hits on this same mount are
    // recorded as noEffect soaks.
    if (!state.destroyedWeapons.includes(slot.weaponIndex)) {
      state.destroyedWeapons.push(slot.weaponIndex);
      state.rows.push({
        kind: "weaponDestroyed",
        location: loc,
        slotIndex,
        rolls: rolls.slice(),
        transferred,
        weaponIndex: slot.weaponIndex,
        weaponName: slot.weapon,
      });
    } else {
      state.rows.push({ kind: "noEffect", rolls: rolls.slice() });
    }
    return;
  }
  if (slot.kind === "ammo") {
    const weaponName = slot.weapon;
    const weaponIndex = slot.weaponIndex;
    const binId = ammoBinId(loc, slotIndex);
    const emptyBin = (): AmmoBinState => ({
      id: binId,
      location: loc,
      slotIndex,
      weaponIndex: slot.weaponIndex,
      weapon: slot.weapon,
      shots: 0,
    });
    // Non-explosive ammo (e.g. gauss rifle rounds) cannot detonate. The crit
    // still destroys the slot and empties the bin (slugs spill), but no
    // damage roll and no cascade.
    if (!getAmmoDefFor(slot).explosive) {
      state.ammoBins[binId] = emptyBin();
      state.rows.push({
        kind: "ammoNoExplosion",
        location: loc,
        slotIndex,
        rolls: rolls.slice(),
        transferred,
        weaponIndex,
        weaponName,
      });
      return;
    }
    // Only the hit bin detonates; sibling bins of the same weapon stay.
    const shotsRemaining = state.ammoBins[binId]?.shots ?? 0;
    const damagePerShot = ammoDamagePerShot(slot);
    const amount = shotsRemaining * damagePerShot;
    if (amount > 0) {
      const app = applyAmmoExplosion(state.damage, loc, amount, checkCASE(def, loc));
      state.damage = app.after;
      if (app.killed) state.killed = true;
      for (const arm of app.blownOffArms) {
        state.blownOffArms.push(arm);
      }
      // Cascade a fresh determining roll for each location that lost IS
      // during the explosion (the official rule: "Because an ammunition
      // explosion damages the internal structure of the location where it
      // explodes, a roll to determine critical hits is necessary").
      for (const newlyLost of app.newlyDestroyed) {
        stripBinsInLocation(state.ammoBins, newlyLost);
        runDetermining(rng, def, { location: newlyLost, damage: amount }, state);
      }
      state.rows.push({
        kind: "ammoExplosion",
        location: loc,
        slotIndex,
        rolls: rolls.slice(),
        transferred,
        weaponIndex,
        weaponName,
        shotsRemaining,
        damagePerShot,
        damage: amount,
        application: app,
      });
    } else {
      // Empty bin: the slot still takes the crit (and soaks), but no
      // explosion.
      state.rows.push({ kind: "noEffect", rolls: rolls.slice() });
    }
    // The bin's contents exploded or the bin was empty.
    state.ammoBins[binId] = emptyBin();
    return;
  }
  // structure component
  const name = slot.name;
  if (name === COCKPIT) {
    // Cockpit crit kills the 'Mech (pilot killed).
    state.killed = true;
    state.damage.armor.head = 0;
    state.damage.internalStructure.head = 0;
    zeroLocation(state, "head");
    state.rows.push({
      kind: "cockpitDestroyed",
      location: loc,
      slotIndex,
      rolls: rolls.slice(),
      transferred,
    });
    return;
  }
  if (name === "doubleHeatSink") {
    // Group destruction: mark all slots in the same DHS group as destroyed.
    const group = (slot as { group: readonly number[] }).group;
    for (const idx of group) {
      const j = idx - 1;
      if (j >= 0 && j < state.destroyed[loc].length) state.destroyed[loc][j] = true;
    }
  }
  state.rows.push({
    kind: "componentDestroyed",
    location: loc,
    slotIndex,
    rolls: rolls.slice(),
    transferred,
    name,
  });
}

function zeroLocation(state: MutableCritState, loc: Location): void {
  state.damage.armor[loc] = 0;
  state.damage.internalStructure[loc] = 0;
  state.destroyed[loc] = state.destroyed[loc].map(() => true);
}

function cloneDestroyed(src: Record<Location, boolean[]>): Record<Location, boolean[]> {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  (Object.keys(src) as Location[]).forEach((loc) => {
    out[loc] = src[loc].slice();
  });
  return out;
}

/**
 * Effective movement ratings derived from a unit's crit state. Leg
 * actuators (upper/lower/foot) and hip reduce walking MP; jump jets reduce
 * jumping MP. Running is recomputed as `ceil(walk * 1.5)`. A destroyed
 * hip on a leg zeroes the other actuator penalties on that leg per the
 * official rules ("After a hip critical hit, ignore all modifiers from
 * previous critical hits on that leg"). Two destroyed hips reduce walking
 * MP to 0 but do not render the unit immobile (the leg-destroyed rule
 * still applies; this only affects MP).
 */
export interface EffectiveMovement {
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
}

function destroyedStructures(
  def: ResolvedMechDef,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
  loc: Location,
): ResolvedCritStructure[] {
  const layout = def.critSlots[loc];
  const destroyed = critSlotsDestroyed[loc];
  const result: ResolvedCritStructure[] = [];
  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i];
    if (slot === undefined) continue;
    if (slot.kind === "structure" && (destroyed[i] ?? false)) {
      result.push(slot);
    }
  }
  return result;
}

export function effectiveMovement(
  def: ResolvedMechDef,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
): EffectiveMovement {
  const legMovePenalty = (
    loc: "rightLeg" | "leftLeg",
  ): { movePenalty: number; jumpPenalty: number; hipHit: boolean } => {
    // Hip on this leg?
    let hipHit = false;
    let movePenalty = 0;
    let jumpPenalty = 0;
    for (const slot of destroyedStructures(def, critSlotsDestroyed, loc)) {
      if (slot.name === HIP) {
        hipHit = true;
      } else if (slot.name === JUMPJET) {
        jumpPenalty += 1;
      } else if (LEG_ACTUATORS.has(slot.name)) {
        movePenalty += 1;
      }
    }
    return { movePenalty, jumpPenalty, hipHit };
  };
  // Hip damage halves walking on each affected leg (round up each leg
  // independently, then combine). Per the rules, when a hip is hit, the
  // other actuator penalties on that leg are ignored; we already drop them
  // by returning 0 above and halving here.
  // two hip damages lead to 0 MP
  const { movePenalty: mpl, jumpPenalty: jpl, hipHit: leftHip } = legMovePenalty("leftLeg");
  const { movePenalty: mpr, jumpPenalty: jpr, hipHit: rightHip } = legMovePenalty("rightLeg");
  let walk = def.walking;
  if (leftHip && rightHip) {
    walk = 0;
  } else if (!leftHip && !rightHip) {
    walk = Math.max(0, walk - mpl - mpr);
  } else if (leftHip) {
    walk = Math.ceil(Math.max(0, walk - mpr) / 2);
  } else {
    // rightHip only
    walk = Math.ceil(Math.max(0, walk - mpl) / 2);
  }
  let jump = Math.max(0, def.jumping - jpl - jpr);
  if (jump > 0) {
    // Jump MP: each destroyed jump jet slot reduces jump MP by 1.
    for (const loc of ["leftTorso", "rightTorso", "centerTorso"] as const) {
      for (const slot of destroyedStructures(def, critSlotsDestroyed, loc)) {
        if (slot.name === JUMPJET) {
          jump = Math.max(0, jump - 1);
        }
      }
    }
  }
  const run = Math.ceil((walk * 3) / 2); // ceil(walk * 1.5)
  return { walking: walk, running: run, jumping: jump };
}
