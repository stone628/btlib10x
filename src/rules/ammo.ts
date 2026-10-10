/**
 * Per-bin ammunition depletion and per-unit depletion policies.
 *
 * Ammo is tracked per crit slot ("bin") as its remaining shot count, keyed by
 * `AmmoBinId` = `${location}:${slotIndex}` in `UnitState.ammoBins`. A bin's
 * static identity (location, slot, linked weapon) comes from the mech def via
 * `collectAmmoBins`; a missing key means the bin was stripped along with its
 * location. Per-weapon totals (`ammoWeaponTotals`, `pooledShotsLeft`,
 * `pooledTotalsByWeaponName`) are derived on demand and never stored.
 *
 * A unit's `ammoPolicy` orders the bins it draws a shot from, chosen between
 * equal-priority bins at random via the injected rng:
 *
 *   exposed (default)  arms -> legs -> side torsos -> head -> center torso
 *   core               center torso -> head -> side torsos -> legs -> arms
 *   spread             the fullest bin holds the next shot
 *   leastFirst         the emptiest bin holds the next shot
 *
 * Each bin starts loaded with `shotsPerBin` from the ammo table. If any mount
 * of a weapon declares `shots`, the sum of the declared shots across all its
 * mounts is spread evenly over every bin of that weapon (matching the existing
 * name-based pooling), with any remainder distributed one per bin in slot
 * order.
 */

import type { Location, Rng } from "../core/types";
import { type AmmoNameHolder, shotsPerBinFor } from "../data/ammo.schema";
import type { ResolvedMechDef } from "../data/mech.schema";

/** Stable identity of one ammo bin: `${location}:${slotIndex}` (1-based slot). */
export type AmmoBinId = string;

/** One ammo bin: a single `{kind:"ammo"}` crit slot linked to a weapon mount. */
export interface AmmoBin extends AmmoNameHolder {
  readonly id: AmmoBinId;
  readonly location: Location;
  readonly slotIndex: number;
  readonly weaponIndex: number;
}

/**
 * Unit-level ammo state, keyed by `AmmoBinId`. The sign of a bin tells its fate:
 * `n > 0` is live ammo with n shots; `0` is spent, exploded or lost with an
 * exploded location; `n < 0` is a bin stripped with a location lost to plain
 * damage, still holding `-n` shots that no weapon can draw (salvage value).
 * Read live shots with `liveShots`, salvage with `strandedShots`.
 */
export type AmmoBins = Record<AmmoBinId, number>;

/** Shots a weapon can draw from a bin value (negative = stranded = 0). */
export function liveShots(n: number | undefined): number {
  return n !== undefined && n > 0 ? n : 0;
}

/** Shots left in a bin stripped with its location (0 for any other bin). */
export function strandedShots(n: number | undefined): number {
  return n !== undefined && n < 0 ? -n : 0;
}

export const AMMO_POLICIES: AmmoPolicy[] = ["exposed", "core", "spread", "leastFirst"] as const;

/** Per-unit ammo depletion policy. */
export type AmmoPolicy = "exposed" | "core" | "spread" | "leastFirst";

export function isAmmoPolicy(value: unknown): value is AmmoPolicy {
  return typeof value === "string" && (AMMO_POLICIES as readonly string[]).includes(value);
}

/** Canonical bin id for a 1-based crit slot index in a location. */
export function ammoBinId(loc: Location, slotIndex: number): AmmoBinId {
  return `${loc}:${slotIndex}`;
}

/** Enumerate every ammo bin in a 'Mech's crit layout, in slot order. */
export function collectAmmoBins(def: ResolvedMechDef): AmmoBin[] {
  const bins: AmmoBin[] = [];
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    const layout = def.critSlots[loc];
    for (let i = 0; i < layout.length; i++) {
      const slot = layout[i]!;
      if (slot.kind !== "ammo") continue;
      bins.push({
        id: ammoBinId(loc, i + 1),
        location: loc,
        slotIndex: i + 1,
        weaponIndex: slot.weaponIndex,
        weapon: slot.weapon,
      });
    }
  }
  return bins;
}

/** The ammo bins that back a given weapon mount index. */
export function binsForWeapon(def: ResolvedMechDef, weaponIndex: number): AmmoBin[] {
  return collectAmmoBins(def).filter((b) => b.weaponIndex === weaponIndex);
}

/** Mount indices carrying a weapon name (1-based keys, ascending). */
function mountIndicesForWeapon(def: ResolvedMechDef, weaponName: string): number[] {
  const out: number[] = [];
  for (const [key, mount] of Object.entries(def.weapons)) {
    if (mount.weapon === weaponName) out.push(Number(key));
  }
  return out.sort((a, b) => a - b);
}

/**
 * Every ammo bin backing any mount of a weapon name. Mounts of one weapon
 * share a shot pool, but bins link per mount index — a mount with no linked
 * bins still draws from the shared pool through this helper.
 */
export function binsForWeaponName(def: ResolvedMechDef, weaponName: string): AmmoBin[] {
  const indices = new Set(mountIndicesForWeapon(def, weaponName));
  return collectAmmoBins(def).filter((b) => indices.has(b.weaponIndex));
}

/** Shots left across the whole shared pool of a weapon name. */
export function pooledShotsLeft(
  def: ResolvedMechDef,
  bins: Readonly<AmmoBins>,
  weaponName: string,
): number {
  let total = 0;
  for (const bin of binsForWeaponName(def, weaponName)) {
    total += liveShots(bins[bin.id]);
  }
  return total;
}

/** Remaining shots per weapon name across the whole bin map, pooling every
 *  bin feeding every mount of that name. */
export function pooledTotalsByWeaponName(
  def: ResolvedMechDef,
  bins: Readonly<AmmoBins>,
): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const bin of collectAmmoBins(def)) {
    totals[bin.weapon] = (totals[bin.weapon] ?? 0) + liveShots(bins[bin.id]);
  }
  return totals;
}

/**
 * Starting ammo state: every bin of a weapon loads from the ammo table's
 * per-bin capacity. If any mount of the weapon declares `shots`, the declared
 * sum (across all mounts of that weapon name) is instead spread evenly over
 * every bin, leftover shots landing one per bin in slot order.
 */
export function loadAmmoBins(def: ResolvedMechDef): AmmoBins {
  const loaded = loadAmmoCounts(def);
  const bins: AmmoBins = {};
  for (const bin of collectAmmoBins(def)) {
    bins[bin.id] = loaded[bin.id] ?? 0;
  }
  return bins;
}

/** Starting per-bin shot counts (shared by `loadAmmoBins`). */
function loadAmmoCounts(def: ResolvedMechDef): Record<AmmoBinId, number> {
  const bins: Record<AmmoBinId, number> = {};
  const binsOf = new Map<string, AmmoBin[]>();
  for (const bin of collectAmmoBins(def)) {
    const list = binsOf.get(bin.weapon) ?? [];
    list.push(bin);
    binsOf.set(bin.weapon, list);
  }
  const declaredShots = (weaponName: string): number => {
    let sum = 0;
    for (const mount of Object.values(def.weapons)) {
      if (mount.weapon === weaponName && mount.shots !== undefined) sum += mount.shots;
    }
    return sum;
  };
  for (const [weaponName, list] of binsOf) {
    const declaredTotal = declaredShots(weaponName);
    const perBin =
      declaredTotal > 0 ? Math.floor(declaredTotal / list.length) : (shotsPerBinFor(list[0]!) ?? 0);
    let remainder = declaredTotal > 0 ? declaredTotal % list.length : 0;
    for (const bin of list) {
      const amount = perBin + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      bins[bin.id] = amount;
    }
  }
  return bins;
}

/** Per-weapon totals (sum over each mount's bins), for out-of-ammo checks. */
export function ammoWeaponTotals(
  def: ResolvedMechDef,
  bins: Readonly<AmmoBins>,
): Record<number, number> {
  const totals: Record<number, number> = {};
  for (const bin of collectAmmoBins(def)) {
    const n = bins[bin.id] ?? 0;
    if (n > 0) totals[bin.weaponIndex] = (totals[bin.weaponIndex] ?? 0) + n;
  }
  return totals;
}

/**
 * Strand (in place) every bin located in `loc`: a location lost to plain
 * damage keeps its shots on record as a negative count that no weapon can
 * draw (see `AmmoBins`).
 */
export function stripBinsInLocation(bins: AmmoBins, loc: Location): void {
  const prefix = `${loc}:`;
  for (const [id, n] of Object.entries(bins)) {
    if (id.startsWith(prefix) && n > 0) bins[id] = -n;
  }
}

/** Zero (in place) every bin located in `loc`: its ammo exploded with it. */
export function zeroBinsInLocation(bins: AmmoBins, loc: Location): void {
  const prefix = `${loc}:`;
  for (const id of Object.keys(bins)) {
    if (id.startsWith(prefix)) bins[id] = 0;
  }
}

const EXPOSED_RANK: Readonly<Record<Location, number>> = {
  rightArm: 0,
  leftArm: 0,
  rightLeg: 1,
  leftLeg: 1,
  rightTorso: 2,
  leftTorso: 2,
  head: 3,
  centerTorso: 4,
};

const CORE_RANK: Readonly<Record<Location, number>> = {
  centerTorso: 0,
  head: 1,
  rightTorso: 2,
  leftTorso: 2,
  rightLeg: 3,
  leftLeg: 3,
  rightArm: 4,
  leftArm: 4,
};

/** Uniform-ish int in [0, n) built from base-6 d6 digits via rejection sampling. */
function randInt(rng: Rng, n: number): number {
  let digits = 1;
  let range = 6;
  while (range < n) {
    digits += 1;
    range *= 6;
  }
  const bound = Math.floor(range / n) * n;
  for (;;) {
    let v = 0;
    for (let i = 0; i < digits; i++) v = v * 6 + (rng.d6() - 1);
    if (v < bound) return v % n;
  }
}

/** In-place Fisher-Yates shuffle driven only by the injected rng. */
function shuffleRun<T>(arr: T[], rng: Rng): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/**
 * Order the given bins by `policy` for the next shot. `exposed`/`core` rank
 * bins by location; `spread` sorts fullest-first and `leastFirst` emptiest-
 * first. Within each run of equal-priority bins the first bin is chosen at
 * random via `rng`.
 */
export function drawOrderBins(
  bins: readonly AmmoBin[],
  state: Readonly<AmmoBins>,
  policy: AmmoPolicy,
  rng: Rng,
): AmmoBin[] {
  const key = (b: AmmoBin): number => {
    const shots = state[b.id] ?? 0;
    if (policy === "spread") return -shots;
    if (policy === "leastFirst") return shots;
    return policy === "exposed" ? (EXPOSED_RANK[b.location] ?? 0) : (CORE_RANK[b.location] ?? 0);
  };
  const sorted = [...bins].sort((a, b) => key(a) - key(b));
  const out: AmmoBin[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && key(sorted[j + 1]!) === key(sorted[i]!)) j += 1;
    const run = sorted.slice(i, j + 1);
    shuffleRun(run, rng);
    out.push(...run);
    i = j + 1;
  }
  return out;
}

/**
 * Deduct `needed` shots from `pool` bins, drawing each shot from the next
 * bin per `policy` (ties broken at random via `rng`). Stops early when the
 * pool runs dry. Returns a new bin-state map with the input untouched; the
 * caller commits it onto the unit.
 */
function drainBins(
  bins: Readonly<AmmoBins>,
  pool: readonly AmmoBin[],
  needed: number,
  policy: AmmoPolicy,
  rng: Rng,
): AmmoBins {
  const next: AmmoBins = { ...bins };
  let remaining = needed;
  while (remaining > 0) {
    const candidates = pool.filter((b) => (next[b.id] ?? 0) > 0);
    if (candidates.length === 0) break;
    const target = drawOrderBins(candidates, next, policy, rng)[0]!;
    next[target.id]! -= 1;
    remaining -= 1;
  }
  return next;
}

/**
 * Deduct `needed` shots from the bins backing `weaponIndex`, drawing each
 * shot from the next bin per `policy` (ties broken at random via `rng`).
 * Returns a new bin-state map; the caller commits it onto the unit.
 */
export function consumeAmmo(
  def: ResolvedMechDef,
  bins: Readonly<AmmoBins>,
  weaponIndex: number,
  needed: number,
  policy: AmmoPolicy,
  rng: Rng,
): AmmoBins {
  return drainBins(bins, binsForWeapon(def, weaponIndex), needed, policy, rng);
}

/**
 * Deduct `needed` shots from the shared pool of a weapon name (every bin
 * backing any mount of that name). Streak fire draws through here so mounts
 * with no directly linked bins still spend shared ammo.
 */
export function consumeAmmoForName(
  def: ResolvedMechDef,
  bins: Readonly<AmmoBins>,
  weaponName: string,
  needed: number,
  policy: AmmoPolicy,
  rng: Rng,
): AmmoBins {
  return drainBins(bins, binsForWeaponName(def, weaponName), needed, policy, rng);
}
