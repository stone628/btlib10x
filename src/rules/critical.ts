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
 * Empty slots, soak (endo steel / ferro-fibrous / CASE / TSM / stealth
 * systems: the slots TW pp.124, 134-143 say cannot take a critical) and
 * already-destroyed slots re-roll. Equipment the engine does not model yet
 * (structure type `equipment`: ECM, probes, Artemis, MASC, ...) is a valid
 * target: the hit destroys the slot with no further modelled effect (TW p.124). If the source location has no crit-hittable slot remaining
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
 *     damage / punch / club legality — deferred with the physical
 *     attack phase; the WEAPON-fire modifiers, TW p.125, live in
 *     `src/rules/actuators.ts`)
 *
 * The engine's rules functions are pure given their inputs and operate on
 * snapshots; the caller (game.ts) commits the resulting state onto UnitState.
 */

import { diceIndex, roll2D6, rollD6 } from "../core/dice";
import type { LimbLocation, Location, Rng } from "../core/types";
import { damageTransferTo, isLimb, isTorso, LOCATIONS, TORSO_LOCATIONS } from "../core/types";
import { type AmmoNameHolder, ammoDefFor } from "../data/ammo.schema";
import type { MechModelHolder, ResolvedCritSlot, ResolvedMechDef } from "../data/mech.schema";
import { CRIT_SLOT_COUNTS, mechDefFor } from "../data/mech.schema";
import { weaponDefFor } from "../data/weapon.schema";
import { type AmmoBinRef, type AmmoBins, ammoBinId } from "./ammo";
import {
  applyDamage,
  type DamageApplication,
  dealtOf,
  destroyedLegs,
  isUnitLocationDestroyed,
  structureStruck,
  type UnitDamageState,
  zeroLocationStructure,
} from "./damage";
import type { DestroyedReason } from "./game";
import { GYRO_DESTROYED_HITS, SENSOR_BLIND_HITS } from "./piloting";

// ---------------------------------------------------------------------------
// Destroyed crit-slot table: one bitmask per location (bit `i` = 0-based slot
// `i` destroyed). A location has at most 12 slots, so a mask is a small int
// and a whole table copies with an object spread. Slot counts and layout come
// from the mech def, never from the table. All helpers take 0-based slot
// indices; callers holding a 1-based slot number subtract 1 at the call site.
// ---------------------------------------------------------------------------

/** Destroyed-slot bitmask per location. */
export type CritMask = Record<Location, number>;

/**
 * The parts of a unit's state that critical hits read and write, always
 * passed and returned together so they come from one snapshot. Ammo bin
 * liveness is derived from all three (see `AmmoBins`).
 */
export interface CritState {
  readonly damage: UnitDamageState;
  readonly critSlotsDestroyed: CritMask;
  readonly ammoBins: AmmoBins;
}

/** Most crit slots a location can hold (TW record sheets). */
export const MAX_CRIT_SLOTS = 12;

/** Fresh table with nothing destroyed, keyed like `def.critSlots`. */
export function emptyCritTable(def: ResolvedMechDef): CritMask {
  const out = {} as CritMask;
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    if (def.critSlots[loc].length > MAX_CRIT_SLOTS) {
      throw new Error(`${def.model}: ${loc} has more than ${MAX_CRIT_SLOTS} crit slots`);
    }
    out[loc] = 0;
  }
  return out;
}

/** Independent copy of a table. */
export function cloneCritTable(table: Readonly<CritMask>): CritMask {
  return { ...table };
}

/** True when 0-based slot `slot` of `loc` is destroyed. */
export function isSlotDestroyed(table: Readonly<CritMask>, loc: Location, slot: number): boolean {
  return (((table[loc] ?? 0) >> slot) & 1) === 1;
}

/** Mark 0-based slot `slot` of `loc` destroyed, in place. */
export function setSlotDestroyed(table: CritMask, loc: Location, slot: number): void {
  table[loc] = (table[loc] ?? 0) | (1 << slot);
}

/**
 * Mark every non-empty slot of `loc` destroyed, in place. Empty slots hold no
 * component to destroy (TW p.124 rerolls them), so their bits stay clear: the
 * mask then round-trips through `UnitInitDamage.critsDestroyed`. Soak slots
 * are marked: their gear is lost with the location (refit/salvage record).
 */
export function destroyAllSlots(
  table: CritMask,
  loc: Location,
  layout: readonly ResolvedCritSlot[],
): void {
  let mask = 0;
  for (let i = 0; i < layout.length; i++) {
    if (layout[i]?.kind !== "empty") mask |= 1 << i;
  }
  table[loc] = mask;
}

/** True when any slot of `loc` is destroyed. */
export function anySlotDestroyed(table: Readonly<CritMask>, loc: Location): boolean {
  return (table[loc] ?? 0) !== 0;
}

/** Merge `other` into `table` (slot-wise OR), in place. */
export function mergeCritTable(table: CritMask, other: Readonly<CritMask>): void {
  for (const loc of Object.keys(other) as Location[]) {
    table[loc] = (table[loc] ?? 0) | (other[loc] ?? 0);
  }
}

/** Ascending 0-based indices of the destroyed slots of `loc`. */
export function destroyedSlots(table: Readonly<CritMask>, loc: Location): number[] {
  const out: number[] = [];
  const mask = table[loc] ?? 0;
  for (let i = 0; i < MAX_CRIT_SLOTS; i++) if ((mask >> i) & 1) out.push(i);
  return out;
}

/** Slot bitmask per location for each weapon index, built once per def. */
type WeaponSlotMasks = ReadonlyMap<number, Readonly<Partial<Record<Location, number>>>>;
const WEAPON_SLOT_MASKS = new WeakMap<ResolvedMechDef, WeaponSlotMasks>();

function weaponSlotMasks(def: ResolvedMechDef): WeaponSlotMasks {
  const cached = WEAPON_SLOT_MASKS.get(def);
  if (cached !== undefined) return cached;
  const masks = new Map<number, Partial<Record<Location, number>>>();
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    def.critSlots[loc].forEach((slot, i) => {
      if (slot.kind !== "weapon") return;
      const entry = masks.get(slot.weaponIndex) ?? {};
      entry[loc] = (entry[loc] ?? 0) | (1 << i);
      masks.set(slot.weaponIndex, entry);
    });
  }
  WEAPON_SLOT_MASKS.set(def, masks);
  return masks;
}

/**
 * True when weapon `weaponIndex` is destroyed by a critical hit: any of its
 * slots (split weapons included) is flagged in `table` (TW p.124: one hit
 * on any slot destroys the whole mount). The slot flags are the only record,
 * so a catastrophic location wipe counts too. A location lost to plain
 * damage sets no flags; callers check `canFireMount` for that.
 */
export function isWeaponCritted(
  def: ResolvedMechDef,
  table: Readonly<CritMask>,
  weaponIndex: number,
): boolean {
  const entry = weaponSlotMasks(def).get(weaponIndex);
  if (entry === undefined) return false;
  for (const loc of Object.keys(entry) as Location[]) {
    if (((table[loc] ?? 0) & (entry[loc] ?? 0)) !== 0) return true;
  }
  return false;
}

/** Ascending indices of the weapons {@link isWeaponCritted} reports. */
export function crittedWeapons(def: ResolvedMechDef, table: Readonly<CritMask>): number[] {
  return [...weaponSlotMasks(def).keys()]
    .filter((index) => isWeaponCritted(def, table, index))
    .sort((a, b) => a - b);
}

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
      /** The structure type: "engine", "gyro", "heatSink", "doubleHeatSink", "shoulder", "equipment", etc. */
      readonly name: string;
      /** The slot's item name from the record sheet, when it carries one (e.g. "Guardian ECM Suite"). */
      readonly label?: string;
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

/** `critSlotsDestroyed` / `damage` / `ammoBins` (from {@link CritState}) are
 *  the unit's state after this resolution, ammo-explosion cascades included. */
export interface CriticalResolution extends CritState {
  readonly source: CritSource;
  /** Determining roll (2D6 sum) for the table itself. */
  readonly determiningRoll: number;
  /** True when the determining roll came from a through-armor hit-location
   *  roll of 2 rather than stripped internal structure (derived from
   *  `source.tac`; drives the display tag). */
  readonly throughArmor: boolean;
  /** Every effect, in order. The only record of a severed limb: see
   *  {@link critSeveredLimbs}. */
  readonly rows: readonly CriticalEffect[];
  /** Reason the unit is killed by these crits (null when it survives): head
   *  or CT IS to 0, cockpit destroyed, head blown off, or three engine
   *  crits. The first kill in the cascade wins; later ones do not overwrite
   *  it. See `DestroyedReason`. */
  readonly killedReason: DestroyedReason | null;
}

/**
 * Limbs these crits severed, in order: a determining roll of 12 on an arm or
 * leg, and an arm lost with a side torso a crit blast destroyed (TW p.124).
 */
export function critSeveredLimbs(res: Pick<CriticalResolution, "rows">): LimbLocation[] {
  const out: LimbLocation[] = [];
  for (const row of res.rows) {
    if (row.kind === "limbBlownOff") out.push(row.limb);
    else if (row.kind === "ammoExplosion") out.push(...row.application.blownOffLimbs);
    else if (row.kind === "weaponDestroyed" && row.explosion !== undefined) {
      out.push(...row.explosion.application.blownOffLimbs);
    }
  }
  return out;
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
 * component is a weapon, ammo, or structure, unmodelled equipment included —
 * not empty, not soak)?
 */
function isCritHittableStatic(slot: ResolvedCritSlot): boolean {
  if (slot.kind === "empty") return false;
  if (slot.kind === "soak") return false;
  return true;
}

/** Is the location's hittable inventory exhausted (no non-empty non-soak slot remains undestroyed)? */
function isLocationExhausted(layout: readonly ResolvedCritSlot[], destroyed: number): boolean {
  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i] ?? { kind: "empty" };
    if (isCritHittableStatic(slot) && ((destroyed >> i) & 1) === 0) return false;
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
 * Per-shot damage value used for an ammo explosion. Ammo rows that set
 * `explosionDamagePerShot` (AMS, Narc: 2 per shot, TW p.130, p.139) use it;
 * otherwise missiles multiply per-missile damage by tube count and
 * direct-fire weapons use their damage. Variable-damage weapons don't carry
 * ammo so this never fires for them.
 */
export function ammoDamagePerShot(h: AmmoNameHolder): number {
  const blast = ammoDefFor(h).explosionDamagePerShot;
  if (blast !== undefined) return blast;
  const w = weaponDefFor(h);
  if (w.missileDamage !== undefined && w.missiles !== undefined) {
    return w.missileDamage * w.missiles;
  }
  return w.damage ?? 0;
}

/**
 * Find an eligible slot in `layout` (one that is hittable and not yet
 * destroyed), re-rolling the dice up to a generous cap. TW p.124 requires
 * re-rolling empty/soak/destroyed slots until a hittable slot lands, so when
 * the dice miss for the whole cap the fallback picks uniformly among the
 * live hittable slots — guaranteeing the critical lands whenever one
 * exists. Returns null only when the location is exhausted (no live
 * hittable slot remains). Returns the 1-based slot index.
 */
function findHittableSlot(
  rng: Rng,
  loc: Location,
  layout: readonly ResolvedCritSlot[],
  destroyed: number,
): { slotIndex: number; rolls: number[] } | null {
  const maxTries = SLOT_REROLL_CAP;
  for (let i = 0; i < maxTries; i++) {
    const { slot, rolls } = rollSlotNumber(rng, loc);
    const i0 = slot - 1;
    if (i0 < 0 || i0 >= layout.length) continue;
    const staticSlot = layout[i0] ?? { kind: "empty" };
    if (!isCritHittableStatic(staticSlot)) continue;
    if ((destroyed >> i0) & 1) continue;
    return { slotIndex: slot, rolls: [...rolls] };
  }
  // Dice missed every try despite a hittable slot existing (probability
  // (1-k/12)^50 for k live slots on a 12-slot location). Fall back to a
  // uniform pick so the critical is never silently lost.
  const live: number[] = [];
  for (let i = 0; i < layout.length; i++) {
    const staticSlot = layout[i] ?? { kind: "empty" };
    if (!isCritHittableStatic(staticSlot)) continue;
    if ((destroyed >> i) & 1) continue;
    live.push(i + 1);
  }
  if (live.length === 0) return null;
  const slot = live[diceIndex(rng, live.length)] ?? live[0] ?? 1;
  if (CRIT_SLOT_COUNTS[loc] === HEAD_LEG_SLOTS) {
    return { slotIndex: slot, rolls: [slot] };
  }
  const within = slot <= TORSO_ARM_HALF ? slot : slot - TORSO_ARM_HALF;
  const first = slot <= TORSO_ARM_HALF ? 1 : 4;
  return { slotIndex: slot, rolls: [first, within] };
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
 * CASE protection (TW), read from `def` via {@link checkCASE}:
 *   - `case` — the blast is contained: it may still shred the location's
 *     own IS, but it stops there — the excess vents out of the location and
 *     it never reaches the next location.
 *   - `caseII` — the blast is contained and capped at 1 point of damage to
 *     the location (no overflow, no extra containment damage).
 *   - A blast that transfers into a location with CASE damages that
 *     location's IS as normal, then the excess vents there (TW p.134).
 */
export function applyAmmoExplosion(
  state: UnitDamageState,
  def: ResolvedMechDef,
  location: Location,
  amount: number,
): DamageApplication {
  if (!Number.isInteger(amount) || amount <= 0) {
    // No-op application: `state` is returned unchanged, so `pre` may alias it.
    return {
      after: state,
      before: state as UnitDamageState,
      steps: [],
      newlyDestroyed: [],
      blownOffLimbs: [],
      mechDestroyed: false,
    };
  }
  // Ammo explosions bypass armor at every location in the transfer chain
  // (TW p.125): the blast hits IS directly, and any overflow transfers to
  // the next location's IS — surviving armor is never ablated, but a
  // location the blast destroys still loses its remaining armor with it
  // (TW p.122 step 5, via `applyDamage`).
  return applyDamage(state, location, amount, "front", {
    caseAt: (l) => checkCASE(def, l),
    bypassArmor: true,
  });
}

/** The unit's {@link CritState} before these crits, plus the roll context. */
export interface ResolveCriticalsInput extends CritState, MechModelHolder {
  readonly rng: Rng;
  readonly source: CritSource;
  /** Phase-start destroyed-slot flags for the step-4 test (TW p.122: "at the
   *  beginning of the current phase, did the location contain components
   *  that could take a critical hit?"). Defaults to `critSlotsDestroyed`. */
  readonly baseCritSlotsDestroyed?: CritMask;
}

interface MutableCritState {
  destroyed: CritMask;
  damage: UnitDamageState;
  ammoBins: AmmoBins;
  rows: CriticalEffect[];
  killedReason: DestroyedReason | null;
  /** Phase-start slot flags for the exhaustion (transfer) test. */
  base: CritMask | undefined;
}

export function resolveCriticalHits(input: ResolveCriticalsInput): CriticalResolution {
  const state: MutableCritState = {
    destroyed: cloneCritTable(input.critSlotsDestroyed),
    damage: {
      armor: { ...input.damage.armor },
      armorRear: { ...input.damage.armorRear },
      internalStructure: { ...input.damage.internalStructure },
    },
    ammoBins: { ...input.ammoBins },
    rows: [],
    killedReason: null,
    base: input.baseCritSlotsDestroyed,
  };
  const topRoll = runDetermining(input.rng, mechDefFor(input), input.source, state);
  return {
    source: input.source,
    determiningRoll: topRoll ?? 0,
    throughArmor: input.source.tac === true,
    rows: state.rows,
    critSlotsDestroyed: state.destroyed,
    damage: state.damage,
    killedReason: state.killedReason,
    ammoBins: state.ammoBins,
  };
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
  // A hit-location critical chance on an already destroyed location moves
  // inward unchanged, one Determining roll in the next location (TW p.124).
  if (
    source.tac === true &&
    source.carried === undefined &&
    source.struck !== true &&
    isUnitLocationDestroyed(state.damage, source.location)
  ) {
    const next = damageTransferTo(source.location);
    const moved =
      next === null
        ? null
        : runDetermining(rng, def, { ...source, location: next, struck: false }, state);
    return moved;
  }
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
      state.killedReason ??= "headBlownOff";
      state.rows.push({ kind: "headBlownOff", rolls: [det.roll] });
    } else if (isLimb(source.location)) {
      // TW p.145: blown-off arm rides away intact ("may be picked up and
      // used as a club"). Salvage sees weapons, heat sinks, etc. as
      // salvageable on the severed limb — do not mass-mark slot flags.
      zeroLocationStructure(state.damage, source.location);
      state.rows.push({ kind: "limbBlownOff", limb: source.location, rolls: [det.roll] });
    }
    return det.roll;
  }
  if (det.kind === "none") {
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
      return det.roll;
    }
    // The crit count carries inward.
    const { carried: _carried, ...rest } = source;
    runDetermining(rng, def, { ...rest, location: next, struck: false, carried: det.count }, state);
    return det.roll;
  }
  let remaining = det.count;
  while (remaining > 0) {
    const live = state.destroyed[source.location];
    const found = isLocationExhausted(sourceLayout, live)
      ? null
      : findHittableSlot(rng, source.location, sourceLayout, live);
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
 * damage directly to IS (armor bypassed, CASE-contained), record the kill,
 * and cascade a fresh determining roll per newly-destroyed
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
  const app = applyAmmoExplosion(state.damage, def, loc, amount);
  state.damage = app.after;
  if (app.mechDestroyed) {
    state.killedReason ??=
      state.damage.internalStructure.head <= 0 ? "headDestroyed" : "centerTorsoDestroyed";
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
    // An arm blown off with its torso is lost, not destroyed: its slots stay
    // as they were, as on the plain-damage and Determining-12 paths.
    if (app.blownOffLimbs.some((arm) => arm === newlyLost)) continue;
    markLocationCatastrophicallyDestroyed(def, state.damage, state.destroyed, newlyLost);
  }
  return app;
}

/**
 * Apply a single crit hit at `slotIndex` in `loc`. Dispatches on the slot's
 * component to produce the appropriate effect. Marks the slot destroyed and
 * mutates ammo / damage / destroyed-weapons / killed.
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
  // Read before this slot's flag is set: was the mount already destroyed?
  const mountAlreadyDestroyed =
    slot.kind === "weapon" && isWeaponCritted(def, state.destroyed, slot.weaponIndex);
  setSlotDestroyed(state.destroyed, loc, i0);
  if (slot.kind === "weapon") {
    // Disable the linked mount. First hit on any of a multi-slot weapon's
    // slots destroys the whole mount; further hits on this same mount are
    // recorded as noEffect soaks (the rifle powers down: no second blast,
    // TW p.135).
    if (!mountAlreadyDestroyed) {
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
    // Non-explosive ammo (e.g. gauss rifle rounds) cannot detonate. The crit
    // still destroys the slot and empties the bin (slugs spill), but no
    // damage roll and no cascade.
    if (!ammoDefFor(slot).explosive) {
      emptyDestroyedBin(state.ammoBins, binId);
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
    // Only the hit bin detonates; sibling bins of the same weapon stay. The
    // raw count: a bin in a location this very hit destroyed still blows
    // (TW p.124 Destroyed Location).
    const shotsRemaining = Math.max(0, state.ammoBins[binId] ?? 0);
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
    emptyDestroyedBin(state.ammoBins, binId);
    return;
  }
  // structure component
  const name = slot.type;
  if (name === COCKPIT) {
    // Cockpit crit kills the 'Mech (pilot killed) by destroying the slot
    // only (TW p.125). The head location's armor and structure pools stay
    // intact — unlike a head blow-off — so salvage readers see a killed
    // cockpit slot in a surviving head. Kill flows via `killedReason`,
    // not via IS<=0.
    state.killedReason ??= "cockpitDestroyed";
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
    // One critical destroys the device; further hits on its other slots soak
    // (TW pp.124-125). Only the struck slot is marked.
    const group = (slot as { group: readonly number[] }).group;
    if (group.some((idx) => idx - 1 !== i0 && isSlotDestroyed(state.destroyed, loc, idx - 1))) {
      state.rows.push({ kind: "noEffect", rolls: rolls.slice() });
      return;
    }
  }
  if (name === ENGINE) {
    // ENGINE_SLOTS_KILL engine crit slots destroyed = 'Mech killed (TW p.125).
    const engineCount = countDestroyedEngine(def, state.damage, state.destroyed);
    if (engineCount >= ENGINE_SLOTS_KILL) {
      state.killedReason ??= "engineDestroyed";
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
    ...(slot.name !== undefined && { label: slot.name }),
  });
}

/** Damage points this resolution spent marking circles: the blast
 *  applications its rows carry (ammo-explosion and weapon-explosion rows).
 *  Blow-offs, cockpit kills and slot destruction spend no points, so they
 *  contribute nothing here — matching `dealtOf` in `damage.ts`. */
export function critDamageDealt(res: Pick<CriticalResolution, "rows">): number {
  let n = 0;
  for (const row of res.rows) {
    if (row.kind === "ammoExplosion") n += dealtOf(row.application);
    else if (row.kind === "weaponDestroyed" && row.explosion !== undefined) {
      n += dealtOf(row.explosion.application);
    }
  }
  return n;
}

/**
 * Mark a location fully destroyed by a catastrophic event (ammo-explosion
 * cascade). Zero front armor, rear armor, and internal structure; mark
 * every non-empty crit slot (soak included) in the location destroyed; strip
 * any ammo bins there.
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
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: CritMask,
  loc: Location,
): void {
  damage.armor[loc] = 0;
  if (isTorso(loc)) damage.armorRear[loc] = 0;
  damage.internalStructure[loc] = 0;
  // Flagging every slot is the whole record: the location's bins read as
  // destroyed (no shots, no salvage) without touching their counts.
  destroyAllSlots(destroyed, loc, def.critSlots[loc]);
}

/** A destroyed bin holds nothing: its contents exploded or spilled. The slot
 *  flag is the record that it is destroyed; this only clears the count. */
function emptyDestroyedBin(ammoBins: AmmoBins, binId: string): void {
  ammoBins[binId] = 0;
}

/**
 * Destroy an ammo bin outside a crit roll (the heat-phase explosion, TW
 * p.159): flag its slot and empty it, as a critical hit on it would. Returns
 * the new crit table; `ammoBins` is updated in place.
 */
export function destroyAmmoBin(
  critSlotsDestroyed: Readonly<CritMask>,
  ammoBins: AmmoBins,
  bin: AmmoBinRef,
): CritMask {
  const next = cloneCritTable(critSlotsDestroyed);
  setSlotDestroyed(next, bin.location, bin.slotIndex - 1);
  emptyDestroyedBin(ammoBins, bin.id);
  return next;
}

/** Intact jump jets mounted outside the legs (TW p.53: depth 1 water). */
function intactNonLegJumpJets(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  destroyed: Readonly<CritMask>,
): number {
  let n = 0;
  for (const loc of LOCATIONS) {
    if (loc === "leftLeg" || loc === "rightLeg") continue;
    if (isUnitLocationDestroyed(damage, loc)) continue;
    const layout = def.critSlots[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (
        slot?.kind === "structure" &&
        slot.type === JUMPJET &&
        !isSlotDestroyed(destroyed, loc, i)
      ) {
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
  critSlotsDestroyed: Readonly<CritMask>,
  loc: Location,
): string[] {
  return [...iterateDestoyedStructures(def, damage, critSlotsDestroyed, [loc])];
}

export function effectiveMovement(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<CritMask>,
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
  critSlotsDestroyed: Readonly<CritMask>,
): number {
  let destroyed = 0;
  for (const name of iterateDestoyedStructures(def, damage, critSlotsDestroyed, TORSO_LOCATIONS)) {
    if (name === ENGINE) destroyed += 1;
  }
  return destroyed;
}

/** A cockpit slot is destroyed: the MechWarrior is killed (TW p.125). */
export function isCockpitDestroyed(
  def: ResolvedMechDef,
  critSlotsDestroyed: Readonly<CritMask>,
): boolean {
  return def.critSlots.head.some(
    (slot, i) =>
      slot.kind === "structure" &&
      slot.type === COCKPIT &&
      isSlotDestroyed(critSlotsDestroyed, "head", i),
  );
}

function countDestroyedHeadStructure(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<CritMask>,
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
  critSlotsDestroyed: Readonly<CritMask>,
): number {
  return countDestroyedHeadStructure(def, damage, critSlotsDestroyed, SENSORS);
}

export function countDestroyedLifeSupport(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<CritMask>,
): number {
  return countDestroyedHeadStructure(def, damage, critSlotsDestroyed, LIFE_SUPPORT);
}

export function countDestroyedGyro(
  def: ResolvedMechDef,
  damage: UnitDamageState,
  critSlotsDestroyed: Readonly<CritMask>,
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
  critSlotsDestroyed: Readonly<CritMask>,
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
  destroyed: Readonly<CritMask>,
  locations: Readonly<Location[]>,
): Generator<string> {
  for (const loc of locations) {
    const ld = isUnitLocationDestroyed(damage, loc);
    const layout = def.critSlots[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i];
      if (slot?.kind === "structure" && (ld || isSlotDestroyed(destroyed, loc, i))) {
        yield slot.type;
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
  critSlotsDestroyed: Readonly<CritMask>,
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
