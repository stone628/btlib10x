/**
 * Shared evaluation helpers and trace types for the persona player
 * (`web/persona.ts`). Everything here is a pure read of battle state: the
 * persona player never mutates the battle, it only types CLI commands.
 *
 * Expected values follow TW: hit chance is P(2D6 ≥ to-hit) (TW p. 106), range
 * brackets add 0/+2/+4 (TW p. 109), minimum range adds [min] − [range] + 1
 * (TW p. 110), and cluster weapons deal the Cluster Hits Table average
 * (TW p. 116).
 */
import {
  attackerMovementModifier,
  type BattleState,
  canFireMount,
  cellAt,
  damageForBracket,
  expectedClusterHits,
  type HexCoord,
  heatDissipation,
  hexDistance,
  hitProbability,
  isUnitAvailable,
  type Location,
  losClear,
  mechDefFor,
  pooledTotalsByWeaponName,
  type RangeBracket,
  terrainDef,
  toHitHeatModifier,
  type UnitState,
  type WeaponDef,
  weaponDefFor,
} from "btlib10x";
import type { MessageKey } from "./i18n/index";
import type { Persona, PersonaKey, RangeBand } from "./persona.data";

// ---------------------------------------------------------------- traces ----

/** Score terms of GDD §9.1 shown in the trace (weighted values). */
export type TermId =
  | "range"
  | "cover"
  | "tmm"
  | "flank"
  | "melee"
  | "charge"
  | "recoil"
  | "exposed"
  | "heat"
  | "crowd"
  | "ev"
  | "ammo";

export interface TraceTerm {
  readonly id: TermId;
  readonly value: number;
}

export interface TraceCandidate {
  /** Locale-neutral option label, e.g. `run (5,4) sw` or `fire 1,2 · kick left`. */
  readonly label: string;
  readonly score: number;
  readonly terms: readonly TraceTerm[];
  readonly commands: readonly string[];
}

/** A note with a catalog key, rendered in the reader's locale on display. */
export interface TraceNote {
  readonly key: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Long-term stance carried across turns in {@link StrategyMemory}. */
export type Posture = "approach" | "engage" | "hold" | "recover" | "yield";

export interface DecisionTrace {
  readonly turn: number;
  readonly phase: "movement" | "attack";
  readonly actorId: string;
  readonly targetId: string | null;
  readonly persona: PersonaKey;
  readonly posture: Posture;
  readonly targetHeld: number;
  /** Heat the unit plans against, and the persona's ceiling this turn. */
  readonly heat: number;
  readonly heatCeiling: number;
  /** Every scored option, best first; empty for scripted prompts. */
  readonly candidates: readonly TraceCandidate[];
  /** Notes on scripted prompts, skipped options and strategy changes. */
  readonly notes: readonly TraceNote[];
  readonly commands: readonly string[];
}

// ---------------------------------------------------------------- weapons ----

/** To-hit range modifiers by bracket (TW p. 109). */
export const RANGE_MOD: Readonly<Record<RangeBracket, number>> = { short: 0, medium: 2, long: 4 };

export interface UsableWeapon {
  readonly index: number;
  readonly mount: {
    readonly weapon: string;
    readonly location: Location;
    readonly rearFacing?: boolean;
  };
  readonly def: WeaponDef;
  /** Pooled shots left, or null for weapons without ammunition. */
  readonly shots: number | null;
}

/** Weapons that can still fire at all: location intact, not destroyed or jammed, ammo left. */
export function usableWeapons(unit: UnitState): UsableWeapon[] {
  const def = mechDefFor(unit);
  const pools = pooledTotalsByWeaponName(def, unit.ammoBins);
  const result: UsableWeapon[] = [];
  for (const [key, mount] of Object.entries(def.weapons)) {
    const index = Number(key);
    if (unit.destroyedWeapons.includes(index) || unit.jammedWeapons.includes(index)) continue;
    if (!canFireMount(unit.damage, mount)) continue;
    const wdef = weaponDefFor(mount);
    if (wdef.physicalWeapon === true) continue;
    const shots = mount.shots !== undefined ? (pools[mount.weapon] ?? 0) : null;
    if (shots !== null && shots <= 0) continue;
    result.push({ index, mount, def: wdef, shots });
  }
  return result;
}

export function bracketAt(w: WeaponDef, distance: number): RangeBracket | null {
  if (distance <= w.short) return "short";
  if (distance <= w.medium) return "medium";
  if (distance <= w.long) return "long";
  return null;
}

/** Expected damage of one hit, using the cluster average for missile weapons. */
export function expectedHitDamage(w: WeaponDef, bracket: RangeBracket): number {
  if (w.missiles !== undefined) {
    const per = w.missileDamage ?? 1;
    return (w.streak === true ? w.missiles : expectedClusterHits(w.missiles)) * per;
  }
  return damageForBracket(w, bracket);
}

/** To-hit for `w` at `distance` on top of `tnBase`, or null when out of range. */
export function weaponTn(w: WeaponDef, distance: number, tnBase: number): number | null {
  const bracket = bracketAt(w, distance);
  if (bracket === null) return null;
  const minPen = w.minRange !== undefined && distance <= w.minRange ? w.minRange - distance + 1 : 0;
  return tnBase + RANGE_MOD[bracket] + minPen + (w.toHitMod ?? 0);
}

/** Σ P(hit) × damage over `weapons` at `distance` (no arc or LOS check). */
export function expectedDamageAt(
  weapons: readonly UsableWeapon[],
  distance: number,
  tnBase: number,
): number {
  let sum = 0;
  for (const w of weapons) {
    const tn = weaponTn(w.def, distance, tnBase);
    if (tn === null) continue;
    sum += hitProbability(tn) * expectedHitDamage(w.def, bracketAt(w.def, distance)!);
  }
  return sum;
}

export interface RangeProfile {
  readonly maxShort: number;
  readonly maxMedium: number;
  readonly maxLong: number;
  /** Distance the persona wants to hold, judged against the 'Mech's own weapons. */
  readonly preferred: number;
}

/** Bracket limits of the unit's usable weapons and the persona's preferred distance. */
export function rangeProfile(unit: UnitState, band: RangeBand): RangeProfile {
  const weapons = usableWeapons(unit);
  const maxShort = Math.max(1, ...weapons.map((w) => w.def.short));
  const maxMedium = Math.max(maxShort, ...weapons.map((w) => w.def.medium));
  const maxLong = Math.max(maxMedium, ...weapons.map((w) => w.def.long));
  const span: Readonly<Record<RangeBand, readonly [number, number]>> = {
    short: [1, maxShort],
    medium: [maxShort + 1, maxMedium],
    long: [maxMedium + 1, maxLong],
    mediumLong: [maxShort + 1, maxLong],
    any: [1, maxLong],
  };
  let [lo, hi] = span[band];
  if (lo > hi) [lo, hi] = [1, maxLong];
  const tnBase = unit.gunnery + 2;
  let preferred = lo;
  let best = -1;
  for (let d = lo; d <= hi; d++) {
    const ev = expectedDamageAt(weapons, d, tnBase);
    // Ties keep the nearer distance for short personas, the farther one otherwise.
    if (ev > best || (ev === best && band !== "short")) {
      best = ev;
      preferred = d;
    }
  }
  return { maxShort, maxMedium, maxLong, preferred };
}

// --------------------------------------------------------- state readers ----

/** Fraction of armor + structure left (front, rear and internal). */
export function remainingFraction(unit: UnitState): number {
  const def = mechDefFor(unit);
  const sum = (v: Readonly<Record<string, number>>) =>
    Object.values(v).reduce((a, b) => a + Math.max(0, b), 0);
  const max = sum(def.armor) + sum(def.armorRear) + sum(def.internalStructure);
  const now =
    sum(unit.damage.armor) + sum(unit.damage.armorRear) + sum(unit.damage.internalStructure);
  return max > 0 ? now / max : 0;
}

export function enemiesOf(battle: BattleState, unit: UnitState): UnitState[] {
  return Object.values(battle.units).filter((u) => isUnitAvailable(u) && u.team !== unit.team);
}

/** Heat the unit dissipates in the coming heat phase. */
export function dissipationOf(unit: UnitState): number {
  return heatDissipation(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed);
}

/** The persona's heat ceiling this turn (Hull-Down warms up once engaged). */
export function heatCeilingFor(
  persona: Persona,
  unit: UnitState,
  target: UnitState | null,
): number {
  if (target === null || persona.heatCeiling === persona.heatCeilingEngaged) {
    return persona.heatCeiling;
  }
  const profile = rangeProfile(unit, "any");
  return hexDistance(unit.position, target.position) <= profile.maxMedium
    ? persona.heatCeilingEngaged
    : persona.heatCeiling;
}

/** Target-hex to-hit modifier: terrain (woods) plus partial cover (TW pp. 107–108). */
export function hexDefenseMod(battle: BattleState, hex: HexCoord): number {
  const t = terrainDef(cellAt(battle, hex).terrain);
  return t.terrainMod + (t.partialCover ? 1 : 0);
}

/** An enemy and its usable weapons, computed once per decision. */
export interface Threat {
  readonly unit: UnitState;
  readonly weapons: readonly UsableWeapon[];
}

export function threatsTo(battle: BattleState, unit: UnitState): Threat[] {
  return enemiesOf(battle, unit).map((e) => ({ unit: e, weapons: usableWeapons(e) }));
}

/**
 * Damage the enemies can expect to deal to a unit standing at `hex` with
 * target movement modifier `tmm`. An enemy that has not moved yet is assumed
 * to walk (+1); arcs are ignored because enemies can still turn. LOS is checked.
 */
export function exposureAt(
  battle: BattleState,
  threats: readonly Threat[],
  hex: HexCoord,
  tmm: number,
): number {
  const defense = tmm + hexDefenseMod(battle, hex);
  let sum = 0;
  for (const { unit: e, weapons } of threats) {
    if (!losClear(battle, e.position, hex, battle.wrecks)) continue;
    const d = Math.max(1, hexDistance(e.position, hex));
    const attackerMod = e.moveMode === null ? 1 : attackerMovementModifier(e.moveMode);
    const tnBase = e.gunnery + attackerMod + defense + toHitHeatModifier(e.heat);
    sum += expectedDamageAt(weapons, d, tnBase);
  }
  return sum;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
