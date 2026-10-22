/**
 * Anti-Missile Systems (TW pp.129-130). An AMS (or Laser AMS) does not fire:
 * when a missile attack hits through an arc it covers, the defender may
 * engage that attack, taking 4 off its Cluster Hits roll (never below 2). A
 * Streak volley is treated as a Cluster roll of 11 before the −4. Each AMS
 * engages at most one attack per turn and only one AMS may engage a given
 * attack; the defender chooses which. This module holds the pure parts: the
 * modifiers, the value of an engagement and the per-unit choice policy
 * (`UnitPolicy.amsPolicy`). `resolveAllAttacks` (game.ts) does the bookkeeping.
 */
import type { WeaponDef } from "../data/weapon.schema";
import { clusterHits, expectedClusterHits, modifiedClusterRoll } from "./cluster";

/** Cluster Hits roll modifier of an engaged attack (TW p.129). */
export const AMS_CLUSTER_MOD = -4;
/** Cluster roll a Streak volley counts as before the AMS modifier (TW p.129). */
export const AMS_STREAK_ROLL = 11;

/**
 * How a unit picks which hitting missile attack its AMS engage:
 *   `expected` - engage when this attack's expected damage saved is at least
 *     the best saving the AMS could still make on an attack not yet
 *     resolved, weighted by that attack's hit chance (default).
 *   `firstHit` - engage the first missile attack that hits.
 *   `priority` - engage unless a higher-priority attack (bigger full-volley
 *     damage, Streak first on ties) is still to resolve.
 *   `off` - never engage.
 */
export const AMS_POLICIES = ["expected", "firstHit", "priority", "off"] as const;
export type AmsPolicy = (typeof AMS_POLICIES)[number];

export function isAmsPolicy(value: unknown): value is AmsPolicy {
  return (AMS_POLICIES as readonly unknown[]).includes(value);
}

/** True for attacks an AMS can engage: missile launchers (type M). HAGs
 *  roll on the Cluster table too but are ballistic, so they are not. */
export function isAmsEngageable(weapon: WeaponDef): boolean {
  return (
    weapon.category === "MISSILE" &&
    weapon.missiles !== undefined &&
    weapon.missileDamage !== undefined
  );
}

/** Missiles that hit from an engaged attack: `roll` is the raw Cluster roll
 *  (ignored for Streak, which counts as {@link AMS_STREAK_ROLL}). */
export function amsClusterHits(weapon: WeaponDef, roll: number, mod = 0): number {
  const base = weapon.streak === true ? AMS_STREAK_ROLL : roll;
  return clusterHits(weapon.missiles!, modifiedClusterRoll(base, mod + AMS_CLUSTER_MOD));
}

/** Expected damage an engagement saves on a missile attack that hit. Exact
 *  for Streak (no Cluster roll); averaged over 2D6 otherwise. */
export function amsExpectedSaving(weapon: WeaponDef): number {
  const n = weapon.missiles!;
  const per = weapon.missileDamage!;
  if (weapon.streak === true) return (n - amsClusterHits(weapon, AMS_STREAK_ROLL)) * per;
  return (expectedClusterHits(n) - expectedClusterHits(n, AMS_CLUSTER_MOD)) * per;
}

/** `priority` rank: full-volley damage, Streak ahead of a non-Streak tie. */
export function amsPriority(weapon: WeaponDef): number {
  return weapon.missiles! * weapon.missileDamage! * 2 + (weapon.streak === true ? 1 : 0);
}

/** A declared missile attack against the defender, as the policy sees it. */
export interface AmsAttack {
  /** Resolution order of the attack in the phase (unique, ascending). */
  readonly key: number;
  readonly weapon: WeaponDef;
  /** Chance the attack hits, from its to-hit number at phase start. */
  readonly hitChance: number;
  /** AMS weapon indices of the defender whose arc covers this attack. */
  readonly coveredBy: readonly number[];
}

/**
 * Pick the AMS (weapon index) that engages `attack`, which just hit, or null
 * to let it through. `available` lists the defender's AMS still able to
 * engage (working, unused this turn, ammo left) that cover `attack`;
 * `pending` lists the defender's missile attacks still to resolve after it.
 * When several AMS could engage, the one with the least to lose on the
 * pending attacks is used (ties: lowest weapon index). Pure and dice-free.
 */
export function chooseAms(
  policy: AmsPolicy,
  attack: AmsAttack,
  available: readonly number[],
  pending: readonly AmsAttack[],
): number | null {
  if (policy === "off" || available.length === 0) return null;
  const worth = (a: AmsAttack): number =>
    policy === "expected"
      ? a.hitChance * amsExpectedSaving(a.weapon)
      : policy === "priority"
        ? amsPriority(a.weapon)
        : 1;
  let best: number | null = null;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const ams of [...available].sort((a, b) => a - b)) {
    const covered = pending.filter((p) => p.coveredBy.includes(ams));
    // firstHit: prefer the AMS needed by the fewest pending attacks.
    const cost =
      policy === "firstHit" ? covered.length : Math.max(0, ...covered.map((p) => worth(p)));
    if (cost < bestCost) {
      best = ams;
      bestCost = cost;
    }
  }
  if (best === null) return null;
  if (policy === "firstHit") return best;
  const now = policy === "expected" ? amsExpectedSaving(attack.weapon) : amsPriority(attack.weapon);
  return now >= bestCost ? best : null;
}
