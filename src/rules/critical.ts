/**
 * Critical hit resolution (BattleTech Total Warfare subset).
 *
 * Whenever a hit strips internal structure from a location — or the
 * hit-location roll is a 2 (through-armor critical, armor unbreached) —
 * the player rolls 2D6 on the Determining Critical Hits table:
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
 *     component only "soak"). Gauss-family / HAG weapons (`critExplosion`,
 *     TW p.135-136) additionally detonate on the first hit: the payload
 *     rides inside `weaponDestroyed.explosion`, applied directly to the
 *     mount location's IS (armor bypassed, CASE-contained, cascade roll,
 *     2 pilot hits) like an ammo explosion. Further slot hits on the
 *     powered-down mount soak with no second blast.
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
 *     Crit-slot flags for the blown-off location are NOT marked
 *     wholesale — per TW p.145 the limb "may be picked up and used as a
 *     club", so weapons/equipment inside ride along intact for salvage.
 *   - cockpit slot hit: the pilot is killed (the 'Mech is destroyed).
 *     Head crit-slot flags preserved for the same salvage reason.
 *   - leg actuator (upper/lower/foot) and hip: recorded as destroyed,
 *     accounted for by the effective-movement helper, and each forces its
 *     own PSR at the end of the phase (+1 / +2, TW p.60).
 *   - first gyro hit: forces a PSR at +3 at the end of the phase; a
 *     destroyed gyro drops the 'Mech automatically. All PSRs also take +3
 *     from a previously hit gyro (preexisting damage, TW p.60).
 *   - sensor slots: first destroyed sensor adds +2 to the unit's weapon
 *     to-hit numbers; a second destroyed sensor blinds the 'Mech (no weapon
 *     attacks at all, TW p.123).
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
 *   - arm actuators, shoulder, hand physical-attack effects (to-hit /
 *     damage / punch / club / push legality — deferred with the physical
 *     attack phase; the WEAPON-fire modifiers, TW p.125, live in
 *     `src/rules/actuators.ts`)
 *
 * The engine's rules functions are pure given their inputs and operate on
 * snapshots; the caller (game.ts) commits the resulting state onto UnitState.
 */

import { roll2D6, rollD6 } from "../core/dice";
import type { LimbLocation, Location, Rng } from "../core/types";
import { damageTransferTo, isLimb, isTorso, LOCATIONS, TORSO_LOCATIONS } from "../core/types";
import { type AmmoNameHolder, ammoDefFor } from "../data/ammo.schema";
import type { ResolvedCritSlot, ResolvedMechDef } from "../data/mech.schema";
import { CRIT_SLOT_COUNTS } from "../data/mech.schema";
import { weaponDefFor } from "../data/weapon.schema";
import { type AmmoBinState, type AmmoBins, ammoBinId, stripBinsInLocation } from "./ammo";
import {
  applyDamage,
  type DamageApplication,
  destroyedLegs,
  isUnitLocationDestroyed,
  structureStruck,
  type UnitDamageState,
} from "./damage";
import type { DestroyedReason } from "./game";
import { GYRO_DESTROYED_HITS, SENSOR_BLIND_HITS } from "./piloting";

export interface CritSource {
  /** Location where the original hit stripped at least 1 internal-structure point. */
  readonly location: Location;
  /** Damage value applied at the source location (used for ammo-explosion trace). */
  readonly damage: number;
  /** The hit itself damaged this location's internal structure. When it also
   *  destroyed the location, only explosive slots there can take the crit
   *  (TW p.124 Destroyed Location); nothing transfers inward. */
  readonly struck?: boolean;
  /** Hit-location (through-armor) critical chance. On an already-destroyed
   *  location the chance itself transfers inward (TW p.124). */
  readonly tac?: boolean;
  /** Crit count carried inward from an exhausted location: applied without a
   *  fresh Determining roll (TW pp.122, 125 Transferring Criticals). */
  readonly carried?: number;
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
      /** Gauss/HAG weapon-crit blast (TW p.135-136), handled like an ammo
       *  explosion: damage is applied directly to this location's IS
       *  (bypassing armor), with CASE containment and a cascade roll. */
      readonly explosion?: {
        readonly damage: number;
        readonly application: DamageApplication;
      };
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
      readonly kind: "limbBlownOff";
      readonly limb: LimbLocation;
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
      /** Three engine crit slots destroyed — 'Mech is killed (TW p.125). */
      readonly kind: "engineDestroyed";
      readonly location: Location;
      readonly slotIndex: number;
      readonly rolls: readonly number[];
      readonly transferred: boolean;
    }
  | {
      readonly kind: "noEffect";
      readonly rolls: readonly number[];
    };

export interface CriticalResolution {
  readonly source: CritSource;
  /** Determining roll (2D6 sum) for the table itself. */
  readonly determiningRoll: number;
  /** True when the determining roll came from a through-armor hit-location
   *  roll of 2 rather than stripped internal structure. */
  readonly throughArmor: boolean;
  readonly rows: readonly CriticalEffect[];
  /** Per-location per-slot destroyed flags after this resolution. */
  readonly critSlotsDestroyed: Record<Location, boolean[]>;
  /** Weapon indices destroyed (newly added) by these crits. */
  readonly destroyedWeapons: number[];
  /** Final damage state after any ammo-explosion cascades have applied. */
  readonly damage: UnitDamageState;
  /** Limbs blown off (after this determining's effects, in addition to those
   *  present in the input state). */
  readonly blownOffLimbs: readonly LimbLocation[];
  /** Reason the unit is killed by these crits (null when it survives): head
   *  or CT IS to 0, cockpit destroyed, head blown off, or three engine
   *  crits. See `DestroyedReason`. */
  readonly killedReason: DestroyedReason | null;
  /** Per-crit-slot ammo state after this resolution. */
  readonly ammoBins: AmmoBins;
}

const LEG_ACTUATORS: ReadonlySet<string> = new Set([
  "upperLegActuator",
  "lowerLegActuator",
  "footActuator",
]);
export const ENGINE = "engine";
export const GYRO = "gyro";
export const HIP = "hip";
export const LIFE_SUPPORT = "lifeSupport";
export const SENSORS = "sensors";
export const COCKPIT = "cockpit";
export const JUMPJET = "jumpJet";

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

/** 2D6 determining roll at or below this: no critical hit. */
const CRIT_NONE_MAX = 7;
/** 2D6 determining roll at or below this: one critical hit. */
const CRIT_ONE_MAX = 9;
/** 2D6 determining roll at or below this: two critical hits (12 blows off / three hits). */
const CRIT_TWO_MAX = 11;

/** 2D6 determining critical hits. */
type DeterminingResult =
  | { kind: "none"; roll: number }
  | { kind: "hits"; count: number; roll: number }
  | { kind: "blownOff"; roll: number };

function determiningResult(rng: Rng, sourceLoc: Location): DeterminingResult {
  const r = roll2D6(rng);
  if (r <= CRIT_NONE_MAX) return { kind: "none", roll: r };
  if (r <= CRIT_ONE_MAX) return { kind: "hits", count: 1, roll: r };
  if (r <= CRIT_TWO_MAX) return { kind: "hits", count: 2, roll: r };
  // 12: blow off head/limb; otherwise 3 hits.
  if (sourceLoc === "head") return { kind: "blownOff", roll: r };
  if (isLimb(sourceLoc)) {
    return { kind: "blownOff", roll: r };
  }
  return { kind: "hits", count: 3, roll: r };
}

/** Slot count on head/leg locations (rolled with 1D6). */
const HEAD_LEG_SLOTS = 6;
/** Slots per half on 12-slot torso/arm locations. */
const TORSO_ARM_HALF = 6;
/** First-die roll at or below this picks the lower half (slots 1-6). */
const HALF_SELECT_MAX = 3;
/** Reroll cap when hunting a crit-hittable slot. */
const SLOT_REROLL_CAP = 50;
/** Destroyed engine slots that kill the 'Mech (TW p.125). */
export const ENGINE_SLOTS_KILL = 3;
/** Running MP numerator over walking MP (run = ceil(walk * 3 / 2)). */
export const RUN_WALK_NUMERATOR = 3;
/** Running MP denominator over walking MP. */
export const RUN_WALK_DENOMINATOR = 2;

/**
 * Roll a 1-based slot number for the given location, using the official
 * procedure: 1D6 for head/legs, 2D6 (half + slot) for torso/arms. Returns
 * the dice rolls used so the effect can record them.
 */
function rollSlotNumber(rng: Rng, loc: Location): { slot: number; rolls: readonly number[] } {
  const count = CRIT_SLOT_COUNTS[loc];
  if (count === HEAD_LEG_SLOTS) {
    const r = rollD6(rng);
    return { slot: r, rolls: [r] };
  }
  // 12-slot location: 2D6, first die = half selector, second = slot within half.
  const first = rollD6(rng);
  const second = rollD6(rng);
  const half = first <= HALF_SELECT_MAX ? 0 : 1; // 0 = slots 1-6, 1 = slots 7-12
  const slot = half * TORSO_ARM_HALF + second;
  return { slot, rolls: [first, second] };
}

/**
 * Per-shot damage value used for an ammo explosion. Missiles multiply
 * per-missile damage by tube count; direct-fire weapons use their damage;
 * variable-damage weapons don't carry ammo so this never fires for them.
 */
export function ammoDamagePerShot(h: AmmoNameHolder): number {
  const w = weaponDefFor(h);
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
  const maxTries = SLOT_REROLL_CAP;
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
 * CASE functions wherever it is mounted (TW p.133). Clan mech's have
 * built-in case at all locations (TacOps / stock Clan sheets).
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
  if (def.techBase === "Clan" || hasCase) {
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
 *   - `case` — the blast is contained: it may still shred the location's
 *     own IS, but it stops there — the excess vents out of the location and
 *     it never reaches the next location.
 *   - `caseII` — the blast is contained and capped at 1 point of damage to
 *     the location (no overflow, no extra containment damage).
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
      blownOffLimbs: [],
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
  /** True when triggered by a through-armor hit-location roll of 2 (armor
   *  unbreached); echoed into the resolution as a tag. Defaults false. */
  readonly throughArmor?: boolean;
  /** Pre-damage destroyed-slot flags. */
  readonly critSlotsDestroyed: Record<Location, boolean[]>;
  /** Pre-damage destroyed-weapon indices. */
  readonly destroyedWeapons: readonly number[];
  /** Pre-damage damage state. */
  readonly damage: UnitDamageState;
  /** Current per-crit-slot ammo state. */
  readonly ammoBins: Readonly<AmmoBins>;
  /** Phase-start destroyed-slot flags for the step-4 test (TW p.122: "at the
   *  beginning of the current phase, did the location contain components
   *  that could take a critical hit?"). Defaults to `critSlotsDestroyed`. */
  readonly baseCritSlotsDestroyed?: Record<Location, boolean[]>;
}

interface MutableCritState {
  destroyed: Record<Location, boolean[]>;
  destroyedWeapons: number[];
  damage: UnitDamageState;
  ammoBins: AmmoBins;
  rows: CriticalEffect[];
  blownOffLimbs: LimbLocation[];
  killedReason: DestroyedReason | null;
  /** Guard against pathological recursion in ammo-explosion cascades. */
  depth: number;
  /** Phase-start slot flags for the exhaustion (transfer) test. */
  base: Record<Location, boolean[]> | undefined;
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
    blownOffLimbs: [],
    killedReason: null,
    depth: 0,
    base: input.baseCritSlotsDestroyed,
  };
  const topRoll = runDetermining(input.rng, input.def, input.source, state);
  // Ammo in a location whose IS has dropped to 0 (explosion transfer,
  // blow-off, cockpit kill) can no longer detonate; remove those bins so
  // subsequent crits and the committed state stay consistent.
  stripBinsInZeroedLocations(input.def, state);
  return {
    source: input.source,
    determiningRoll: topRoll ?? 0,
    throughArmor: input.throughArmor ?? false,
    rows: state.rows,
    critSlotsDestroyed: state.destroyed,
    destroyedWeapons: state.destroyedWeapons,
    damage: state.damage,
    blownOffLimbs: state.blownOffLimbs,
    killedReason: state.killedReason,
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
  const det: DeterminingResult =
    source.carried !== undefined
      ? { kind: "hits", count: source.carried, roll: 0 }
      : determiningResult(rng, source.location);
  // 12 on head/arm/leg = blown off; arms/legs/head are handled here, the
  // source is the original hit location in this determining's call chain.
  if (det.kind === "blownOff") {
    if (source.location === "head") {
      // Pilot dies — head is destroyed as side-effect. Per salvage design
      // the head's components (sensors, life support) remain readable
      // from `def.critSlots.head` and `state.destroyed.head`; only the
      // structural pools are wiped here. `critSlotsDestroyed[head]` flags
      // are NOT set to true en masse.
      zeroLocationStructure(state.damage, "head");
      state.killedReason = "headBlownOff";
      state.rows.push({ kind: "headBlownOff", rolls: [det.roll] });
    } else if (isLimb(source.location)) {
      // TW p.145: blown-off arm rides away intact ("may be picked up and
      // used as a club"). Salvage sees weapons, heat sinks, etc. as
      // salvageable on the severed limb — do not mass-mark slot flags.
      zeroLocationStructure(state.damage, source.location);
      state.blownOffLimbs.push(source.location);
      state.rows.push({ kind: "limbBlownOff", limb: source.location, rolls: [det.roll] });
    }
    state.depth -= 1;
    return det.roll;
  }
  if (det.kind === "none") {
    state.depth -= 1;
    return det.roll;
  }
  // det.count hits: walk the determining against the source. If the source
  // was already destroyed, or held no hittable slot at the start of the
  // phase (TW p.122 step 4), the crits transfer inward; otherwise excess is
  // lost. A location destroyed by this very hit keeps its crits, but only
  // explosive slots there take effect (TW p.124 Destroyed Location).
  const sourceLayout = def.critSlots[source.location];
  const sourceDestroyed = state.destroyed[source.location];
  const sourceLocationLost = isUnitLocationDestroyed(state.damage, source.location);
  const justDestroyed = sourceLocationLost && source.struck === true;
  const exhausted =
    !justDestroyed &&
    (sourceLocationLost ||
      isLocationExhausted(sourceLayout, state.base?.[source.location] ?? sourceDestroyed));
  if (exhausted) {
    const next = damageTransferTo(source.location);
    if (next === null) {
      for (let i = 0; i < det.count; i++) {
        state.rows.push({ kind: "noEffect", rolls: [] });
      }
      state.depth -= 1;
      return det.roll;
    }
    // The crit count carries inward; only a hit-location crit chance on an
    // already-destroyed location re-rolls there (TW p.124).
    const chanceOnly = source.tac === true && sourceLocationLost && source.carried === undefined;
    const { carried: _carried, ...rest } = source;
    runDetermining(
      rng,
      def,
      chanceOnly
        ? { ...rest, location: next, struck: false }
        : { ...rest, location: next, struck: false, carried: det.count },
      state,
    );
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
    if (justDestroyed && !isExplosiveSlot(sourceLayout[found.slotIndex - 1])) {
      state.rows.push({ kind: "noEffect", rolls: found.rolls.slice() });
    } else {
      applySlotHit(rng, def, source.location, found.slotIndex, found.rolls, state, false);
    }
    remaining -= 1;
  }
  state.depth -= 1;
  return det.roll;
}

/** Explosive ammo, or a weapon that detonates when critted (Gauss family). */
function isExplosiveSlot(slot: ResolvedCritSlot | undefined): boolean {
  if (slot === undefined) return false;
  if (slot.kind === "ammo") return ammoDefFor(slot).explosive;
  if (slot.kind === "weapon") return (weaponDefFor(slot).critExplosion ?? 0) > 0;
  return false;
}

/**
 * Detonate a crit blast (ammo bin or explosive weapon) at `loc`: apply the
 * damage directly to IS (armor bypassed, CASE-contained), record blown-off
 * arms / kill, and cascade a fresh determining roll per newly-destroyed
 * location (TW p.124-125). Mutates `state` and returns the application for
 * the effect payload.
 */
function detonateCritBlast(
  rng: Rng,
  def: ResolvedMechDef,
  loc: Location,
  amount: number,
  state: MutableCritState,
): DamageApplication {
  const app = applyAmmoExplosion(state.damage, loc, amount, checkCASE(def, loc));
  state.damage = app.after;
  if (app.killed) {
    state.killedReason =
      state.damage.internalStructure.head <= 0 ? "headDestroyed" : "centerTorsoDestroyed";
  }
  for (const arm of app.blownOffLimbs) {
    state.blownOffLimbs.push(arm);
  }
  // Roll once for every location whose internal structure the blast reached
  // (TW p.125 "a further critical roll is required"; p.124 one roll per
  // location damaged). Rolled before the lost locations are marked so a
  // second explosive slot in a dying location can still detonate (TW p.124
  // Destroyed Location).
  for (const critLoc of structureStruck(app)) {
    runDetermining(rng, def, { location: critLoc, damage: amount, struck: true }, state);
  }
  for (const newlyLost of app.newlyDestroyed) {
    markLocationCatastrophicallyDestroyed(state.damage, state.destroyed, state.ammoBins, newlyLost);
  }
  return app;
}

/**
 * Apply a single crit hit at `slotIndex` in `loc`. Dispatches on the slot's
 * component to produce the appropriate effect. Marks the slot destroyed and
 * mutates ammo / damage / destroyed-weapons / blownOffLimbs / killed.
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
    // recorded as noEffect soaks (the rifle powers down: no second blast,
    // TW p.135).
    if (!state.destroyedWeapons.includes(slot.weaponIndex)) {
      state.destroyedWeapons.push(slot.weaponIndex);
      const blast = weaponDefFor(slot).critExplosion ?? 0;
      if (blast > 0) {
        const application = detonateCritBlast(rng, def, loc, blast, state);
        state.rows.push({
          kind: "weaponDestroyed",
          location: loc,
          slotIndex,
          rolls: rolls.slice(),
          transferred,
          weaponIndex: slot.weaponIndex,
          weaponName: slot.weapon,
          explosion: { damage: blast, application },
        });
      } else {
        state.rows.push({
          kind: "weaponDestroyed",
          location: loc,
          slotIndex,
          rolls: rolls.slice(),
          transferred,
          weaponIndex: slot.weaponIndex,
          weaponName: slot.weapon,
        });
      }
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
    if (!ammoDefFor(slot).explosive) {
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
      const app = detonateCritBlast(rng, def, loc, amount, state);
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
    // Cockpit crit kills the 'Mech (pilot killed). Structural pools wipe;
    // salvaged head components (sensors, life-support slots) ride away
    // on the head — leave `state.destroyed.head` flags intact for the
    // salvage reader.
    zeroLocationStructure(state.damage, "head");
    state.killedReason = "cockpitDestroyed";
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
  if (name === ENGINE) {
    // ENGINE_SLOTS_KILL engine crit slots destroyed = 'Mech killed (TW p.125).
    const engineCount = countDestroyedEngine(def, state.damage, state.destroyed);
    if (engineCount >= ENGINE_SLOTS_KILL) {
      state.killedReason = "engineDestroyed";
      state.rows.push({
        kind: "engineDestroyed",
        location: loc,
        slotIndex,
        rolls: rolls.slice(),
        transferred,
      });
      return;
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

export function zeroLocationStructure(damage: UnitDamageState, loc: Location): void {
  damage.armor[loc] = 0;
  if (isTorso(loc)) damage.armorRear[loc] = 0;
  damage.internalStructure[loc] = 0;
}

/**
 * Mark a location fully destroyed by a catastrophic event (ammo-explosion
 * cascade). Zero front armor, rear armor, and internal structure; mark
 * every crit slot in the location destroyed; strip any ammo bins there.
 * Per TW p.121 the location and "remaining armor there (front or rear)"
 * are wiped together.
 *
 * Two callers:
 *   - `applySlotHit` on an exploding ammo bin (crit path) — fires before
 *     the cascade `runDetermining`, so cascade rolls into the location
 *     see it as exhausted and (correctly per TW p.124) re-route to the
 *     next inward location rather than re-rolling on already-destroyed
 *     components.
 *   - `resolveHeatPhase` heat-triggered ammo explosion — no cascade; just
 *     keeps `critSlotsDestroyed` and `ammoBins` aligned with the IS=0
 *     state so counters (`countDestroyedEngine`, `heatSinksOperational`,
 *     `effectiveMovement`) report the destruction truthfully.
 *
 * Plain-damage destruction (overflow, building collapse) does NOT go
 * through here — see the asymmetry note in `src/rules/damage.ts:140`.
 */
export function markLocationCatastrophicallyDestroyed(
  damage: UnitDamageState,
  destroyed: Record<Location, boolean[]>,
  ammoBins: AmmoBins,
  loc: Location,
): void {
  damage.armor[loc] = 0;
  if (isTorso(loc)) damage.armorRear[loc] = 0;
  damage.internalStructure[loc] = 0;
  destroyed[loc] = destroyed[loc].map(() => true);
  stripBinsInLocation(ammoBins, loc);
}

function cloneDestroyed(src: Record<Location, boolean[]>): Record<Location, boolean[]> {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  (Object.keys(src) as Location[]).forEach((loc) => {
    out[loc] = src[loc].slice();
  });
  return out;
}

/** Intact jump jets mounted outside the legs (TW p.53: depth 1 water). */
function intactNonLegJumpJets(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
): number {
  let n = 0;
  for (const loc of LOCATIONS) {
    if (loc === "leftLeg" || loc === "rightLeg") continue;
    if (isUnitLocationDestroyed(damage, loc)) continue;
    const layout = def.critSlots[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind === "structure" && slot.name === JUMPJET && !(destroyed[loc]?.[i] ?? false)) {
        n += 1;
      }
    }
  }
  return n;
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
 *
 * `prone` is the unit's posture at call time; when `false` and exactly one
 * leg is destroyed, walking is clamped to 1 (TW p.122, "overriding all MP
 * increases"). When `true`, both-legs-gone clamps to 0; one-leg-destroyed
 * still walks 1 (the 'Mech may stand on one leg).
 */
export interface EffectiveMovement {
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
}

/** TSM walking-MP bonus while active (TW p.143); running recomputes from it. */
export const TSM_WALK_BONUS = 2;

export function destroyedStructures(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
  loc: Location,
): string[] {
  return [...iterateDestoyedStructures(def, damage, critSlotsDestroyed, [loc])];
}

export function effectiveMovement(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
  tsmActive = false,
  waterDepth = 0,
): EffectiveMovement {
  const legMovePenalty = (
    loc: "rightLeg" | "leftLeg",
  ): { movePenalty: number; jumpPenalty: number; hipHit: boolean } => {
    // Hip on this leg?
    let hipHit = false;
    let movePenalty = 0;
    let jumpPenalty = 0;
    for (const n of iterateDestoyedStructures(def, damage, critSlotsDestroyed, [loc])) {
      if (n === HIP) {
        hipHit = true;
      } else if (n === JUMPJET) {
        jumpPenalty += 1;
      } else if (LEG_ACTUATORS.has(n)) {
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
  // TSM (TW p.143): +2 Walking MP on the base rating before damage; the
  // one-leg clamp below still overrides all MP increases (TW p.122).
  let walk = def.walking + (tsmActive ? TSM_WALK_BONUS : 0);
  if (leftHip && rightHip) {
    walk = 0;
  } else if (!leftHip && !rightHip) {
    walk = Math.max(0, walk - mpl - mpr);
  } else if (leftHip) {
    // TW p.125 Hip: halve first, then subtract the other leg's actuator losses.
    walk = Math.max(0, Math.ceil(walk / 2) - mpr);
  } else {
    // rightHip only
    walk = Math.max(0, Math.ceil(walk / 2) - mpl);
  }
  let jump = Math.max(0, def.jumping - jpl - jpr);
  if (jump > 0) {
    // Jump MP: each destroyed jump jet slot reduces jump MP by 1.
    // jumpjets from legs are already counted.
    for (const n of iterateDestoyedStructures(def, damage, critSlotsDestroyed, TORSO_LOCATIONS)) {
      if (n === JUMPJET) {
        jump = Math.max(0, jump - 1);
      }
    }
  }
  // Leg-destroyed clamps (TW p.122). One-leg 'Mech: walking MP 1 (overrides
  // all MP increases); cannot run. Two legs gone: 0 walk. Jump MP unchanged —
  // one-leg may still jump with a PSR each landing. The clamp applies
  // regardless of posture: a prone one-leg unit's walking budget is the MP
  // it will have once it stands, used for the stand attempt and prone-turn
  // costs alike.
  // Water (TW p.53): no jumping from depth 2+; at depth 1 only non-leg jets fire.
  if (waterDepth >= 2) {
    jump = 0;
  } else if (waterDepth === 1) {
    jump = Math.min(jump, intactNonLegJumpJets(def, damage, critSlotsDestroyed));
  }
  const legsGone = destroyedLegs(damage);
  if (legsGone >= 2) {
    walk = 0;
  } else if (legsGone === 1) {
    walk = Math.min(walk, 1);
  }
  const run = legsGone >= 1 ? 0 : Math.ceil((walk * RUN_WALK_NUMERATOR) / RUN_WALK_DENOMINATOR);
  return { walking: walk, running: run, jumping: jump };
}

/** Number of destroyed `engine` crit slots on the 'Mech. */
export function countDestroyedEngine(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
): number {
  let destroyed = 0;
  for (const name of iterateDestoyedStructures(def, damage, critSlotsDestroyed, TORSO_LOCATIONS)) {
    if (name === ENGINE) destroyed += 1;
  }
  return destroyed;
}

function countDestroyedHeadStructure(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
  name: string,
): number {
  let destroyed = 0;
  for (const n of iterateDestoyedStructures(def, damage, critSlotsDestroyed, ["head"])) {
    if (n === name) destroyed += 1;
  }
  return destroyed;
}

export function countDestroyedSensor(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
): number {
  return countDestroyedHeadStructure(def, damage, critSlotsDestroyed, SENSORS);
}

export function countDestroyedLifeSupport(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
): number {
  return countDestroyedHeadStructure(def, damage, critSlotsDestroyed, LIFE_SUPPORT);
}

export function countDestroyedGyro(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
): number {
  let destroyed = 0;
  for (const name of iterateDestoyedStructures(def, damage, critSlotsDestroyed, ["centerTorso"])) {
    if (name === GYRO) destroyed += 1;
  }
  return destroyed;
}

export function countDestroyedHip(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
): number {
  let destroyed = 0;
  for (const name of iterateDestoyedStructures(def, damage, critSlotsDestroyed, [
    "leftLeg",
    "rightLeg",
  ])) {
    if (name === HIP) destroyed += 1;
  }
  return destroyed;
}

function* iterateDestoyedStructures(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<Record<Location, readonly boolean[]>>,
  locations: Readonly<Location[]>,
): Generator<string> {
  for (const loc of locations) {
    const ld = isUnitLocationDestroyed(damage, loc);
    const layout = def.critSlots[loc];
    const flags = destroyed[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind === "structure" && (ld || (flags?.[i] ?? false))) {
        yield slot.name;
      }
    }
  }
}

/**
 * Aggregate crit-slot counts for the four components whose mechanical impact
 * is surfaceable in 'Mech status: engine (kill threshold 3), gyro (PSR/cannot
 * stand), sensors (to-hit / blind), life support (pilot hits at heat 15+/26+).
 * Engine `total` is fixed at 3 per TW (matches the destroy threshold in
 * `applySlotHit`); the other totals derive from the def's crit layout.
 */
export interface ComponentHitStatus {
  readonly engine: number;
  readonly gyro: number;
  readonly sensors: number;
  readonly lifeSupport: number;
}

export function componentHitStatus(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>,
): ComponentHitStatus {
  let engineDestoryed = 0;
  let gyroDestroyed = 0;
  let sensorDestroyed = 0;
  let lifeSupportDestroyed = 0;
  for (const name of iterateDestoyedStructures(def, damage, critSlotsDestroyed, ["head"])) {
    switch (name) {
      case SENSORS: {
        sensorDestroyed += 1;
        break;
      }
      case LIFE_SUPPORT: {
        lifeSupportDestroyed += 1;
        break;
      }
    }
  }
  for (const name of iterateDestoyedStructures(def, damage, critSlotsDestroyed, TORSO_LOCATIONS)) {
    switch (name) {
      case ENGINE: {
        engineDestoryed += 1;
        break;
      }
      case GYRO: {
        gyroDestroyed += 1;
        break;
      }
    }
  }
  return {
    engine: Math.min(engineDestoryed, ENGINE_SLOTS_KILL),
    gyro: Math.min(gyroDestroyed, GYRO_DESTROYED_HITS),
    sensors: Math.min(sensorDestroyed, SENSOR_BLIND_HITS),
    lifeSupport: Math.min(lifeSupportDestroyed, 1),
  };
}
