/**
 * Per-bin ammunition depletion and per-unit depletion policies.
 *
 * Ammo is tracked per crit slot ("bin"), keyed by `AmmoBinId` =
 * `${location}:${slotIndex}`. `UnitState.shotsLeft` remains a derived
 * per-weapon total (the sum of its bins) for fireability checks and display.
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

import type { Location, Rng } from "../core/types.js";
import { getShotsPerBin } from "../data/ammo.schema.js";
import type { ResolvedMechDef } from "../data/mech.schema.js";

/** Stable identity of one ammo bin: `${location}:${slotIndex}` (1-based slot). */
export type AmmoBinId = string;

export const AMMO_POLICIES = ["exposed", "core", "spread", "leastFirst"] as const;

/** Per-unit ammo depletion policy. */
export type AmmoPolicy = (typeof AMMO_POLICIES)[number];

export function isAmmoPolicy(value: unknown): value is AmmoPolicy {
  return typeof value === "string" && (AMMO_POLICIES as readonly string[]).includes(value);
}

/** Parse a CLI word into a policy. Case-insensitive; `least-first` and
 *  `leastfirst` are accepted for `leastFirst`. Null when unrecognized. */
export function parseAmmoPolicy(word: string): AmmoPolicy | null {
  const normalized = word.toLowerCase().replaceAll("-", "");
  for (const policy of AMMO_POLICIES) {
    if (normalized === policy.toLowerCase()) return policy;
  }
  return null;
}

/** Canonical bin id for a 1-based crit slot index in a location. */
export function ammoBinId(loc: Location, slotIndex: number): AmmoBinId {
  return `${loc}:${slotIndex}`;
}

/** One ammo bin: a single `{kind:"ammo"}` crit slot linked to a weapon mount. */
export interface AmmoBin {
  readonly id: AmmoBinId;
  readonly location: Location;
  readonly slotIndex: number;
  readonly weaponIndex: number;
  readonly weapon: string;
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

export interface AmmoLoad {
  /** Per-bin remaining shots. */
  readonly bins: Record<AmmoBinId, number>;
  /** Per-weapon total remaining shots (sum over that mount's bins). */
  readonly totals: Record<number, number>;
}

/**
 * Starting ammo state: every bin of a weapon loads from the ammo table's
 * per-bin capacity. If any mount of the weapon declares `shots`, the declared
 * sum (across all mounts of that weapon name) is instead spread evenly over
 * every bin, leftover shots landing one per bin in slot order.
 */
export function loadAmmoBins(def: ResolvedMechDef): AmmoLoad {
  const bins: Record<AmmoBinId, number> = {};
  const totals: Record<number, number> = {};
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
      declaredTotal > 0
        ? Math.floor(declaredTotal / list.length)
        : (getShotsPerBin(weaponName) ?? 0);
    let remainder = declaredTotal > 0 ? declaredTotal % list.length : 0;
    for (const bin of list) {
      const amount = perBin + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      bins[bin.id] = amount;
      totals[bin.weaponIndex] = (totals[bin.weaponIndex] ?? 0) + amount;
    }
  }
  return { bins, totals };
}

/** Per-weapon totals (sum over each mount's bins), for out-of-ammo checks. */
export function ammoWeaponTotals(
  def: ResolvedMechDef,
  bins: Readonly<Record<AmmoBinId, number>>,
): Record<number, number> {
  const totals: Record<number, number> = {};
  for (const bin of collectAmmoBins(def)) {
    const n = bins[bin.id] ?? 0;
    if (n > 0) totals[bin.weaponIndex] = (totals[bin.weaponIndex] ?? 0) + n;
  }
  return totals;
}

/** Delete (in place) every bin located in `loc` (e.g. blown-off / destroyed). */
export function stripBinsInLocation(bins: Record<AmmoBinId, number>, loc: Location): void {
  const prefix = `${loc}:`;
  for (const id of Object.keys(bins)) {
    if (id.startsWith(prefix)) delete bins[id];
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
  counts: Readonly<Record<AmmoBinId, number>>,
  policy: AmmoPolicy,
  rng: Rng,
): AmmoBin[] {
  const key = (b: AmmoBin): number => {
    if (policy === "spread") return -(counts[b.id] ?? 0);
    if (policy === "leastFirst") return counts[b.id] ?? 0;
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
 * Deduct `needed` shots from the bins backing `weaponIndex`, drawing each
 * shot from the next bin per `policy` (ties broken at random via `rng`).
 * Returns a new bin-count map; the caller commits it (with the refreshed
 * weapon totals) onto the unit.
 */
export function consumeAmmo(
  def: ResolvedMechDef,
  bins: Readonly<Record<AmmoBinId, number>>,
  weaponIndex: number,
  needed: number,
  policy: AmmoPolicy,
  rng: Rng,
): Record<AmmoBinId, number> {
  const next = { ...bins };
  let remaining = needed;
  while (remaining > 0) {
    const candidates = binsForWeapon(def, weaponIndex).filter((b) => (next[b.id] ?? 0) > 0);
    if (candidates.length === 0) break;
    const target = drawOrderBins(candidates, next, policy, rng)[0]!;
    next[target.id] = (next[target.id] ?? 0) - 1;
    remaining -= 1;
  }
  return next;
}
