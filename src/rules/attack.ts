import { roll2D6 } from "../core/dice.js";
import type { Location, MoveMode, Rng, TerrainType } from "../core/types.js";
import type { ResolvedMechDef } from "../data/mech.schema.js";
import type { WeaponDef } from "../data/weapon.schema.js";
import { getWeaponOrThrow } from "../data/weapon.schema.js";
import type { Arc } from "./arcs.js";
import { clusterHitsForMissiles, clusterHitsForShots, groupMissiles } from "./cluster.js";
import { type CriticalResolution, resolveCriticalHits } from "./critical.js";
import { applyDamage, type DamageApplication, type UnitDamageState } from "./damage.js";
import { hitLocation } from "./hitlocation.js";
import { losWoodsPoints } from "./los.js";
import { computeToHit, damageForBracket } from "./tohit.js";

export interface HitGroup {
  readonly location: Location;
  readonly damage: number;
}

export interface WeaponAttackInput {
  readonly rng: Rng;
  readonly gunnery: number;
  readonly attackerMoved: MoveMode;
  readonly targetHexesMoved: number;
  readonly targetJumped: boolean;
  readonly targetTerrain: TerrainType;
  readonly interveningTerrains: readonly TerrainType[];
  readonly distance: number;
  readonly weaponName: string;
  /** Shots fired this attack; >1 only valid for rapid-fire (R) weapons. */
  readonly shots?: number;
  /** Layered damage state of the target. */
  readonly targetDamage: UnitDamageState;
  /** Firing arc; default front. */
  readonly arc?: Arc;
  /** Attacker's ground elevation in levels (default 0). */
  readonly attackerLevel?: number;
  /** Target's ground elevation in levels (default 0). */
  readonly targetLevel?: number;
  /**
   * Target 'Mech definition; required for critical-hit resolution. Omit in
   * tests that only care about raw damage. When provided, `targetDef` is
   * used for crit-slot layout, weapon linkage, and the per-weapon ammo
   * pool.
   */
  readonly targetDef?: ResolvedMechDef;
  /** Pre-attack crit-slot destroyed flags (snapshot). */
  readonly targetCritSlotsDestroyed?: Record<Location, boolean[]>;
  /** Pre-attack destroyed weapon indices. */
  readonly targetDestroyedWeapons?: readonly number[];
  /** Pre-attack shots remaining per weapon index. */
  readonly targetShotsLeft?: Readonly<Record<number, number>>;
}

export interface AttackResolution {
  readonly weapon: string;
  readonly distance: number;
  readonly breakdown: ReturnType<typeof computeToHit>;
  readonly toHitRoll: number | null;
  readonly hit: boolean;
  readonly jammed: boolean;
  readonly clusterRoll: number | null;
  readonly groups: readonly HitGroup[];
  readonly application: DamageApplication | null;
  /**
   * Critical hit resolutions triggered by the attack, one per group that
   * stripped at least 1 internal-structure point. Empty when no crits were
   * rolled (e.g. `targetDef` was not supplied).
   */
  readonly crits: readonly CriticalResolution[];
}

/** Resolve one declared weapon attack end-to-end: to-hit, location(s), damage. */
export function resolveWeaponAttack(input: WeaponAttackInput): AttackResolution {
  const weapon: WeaponDef = getWeaponOrThrow(input.weaponName);
  const shots = input.shots ?? 1;

  const breakdown = computeToHit({
    gunnery: input.gunnery,
    attackerMovement: input.attackerMoved,
    targetHexesMoved: input.targetHexesMoved,
    targetJumped: input.targetJumped,
    targetTerrain: input.targetTerrain,
    interveningWoods: losWoodsPoints(input.interveningTerrains),
    distance: input.distance,
    weapon,
    ...(input.attackerLevel !== undefined ? { attackerLevel: input.attackerLevel } : {}),
    ...(input.targetLevel !== undefined ? { targetLevel: input.targetLevel } : {}),
  });

  const base = {
    weapon: weapon.name,
    distance: input.distance,
    breakdown,
    toHitRoll: null as number | null,
    hit: false,
    jammed: false,
    clusterRoll: null as number | null,
    groups: [] as HitGroup[],
    application: null as DamageApplication | null,
    crits: [] as CriticalResolution[],
  };

  if (breakdown.outOfRange) return base;

  const roll = roll2D6(input.rng);
  base.toHitRoll = roll;

  const rapidFire = weapon.rapidFireShots !== undefined && weapon.rapidFireShots > 0;
  if (rapidFire && shots > 1 && roll === 2) base.jammed = true;

  base.hit = breakdown.automatic !== null ? breakdown.automatic === "hit" : roll >= breakdown.total;
  if (!base.hit) return base;

  if (weapon.missiles !== undefined && weapon.missileDamage !== undefined) {
    const clusterRoll = roll2D6(input.rng);
    base.clusterRoll = clusterRoll;
    const hits = clusterHitsForMissiles(weapon.missiles, clusterRoll);
    if (weapon.missileDamage === 2) {
      for (let i = 0; i < hits; i++) {
        base.groups.push({
          location: hitLocation(roll2D6(input.rng)),
          damage: weapon.missileDamage,
        });
      }
    } else {
      for (const lot of groupMissiles(hits, 5)) {
        base.groups.push({
          location: hitLocation(roll2D6(input.rng)),
          damage: lot * weapon.missileDamage,
        });
      }
    }
  } else if (rapidFire && shots > 1) {
    const clusterRoll = roll2D6(input.rng);
    base.clusterRoll = clusterRoll;
    const hits = clusterHitsForShots(shots, clusterRoll);
    for (let i = 0; i < hits; i++) {
      base.groups.push({
        location: hitLocation(roll2D6(input.rng)),
        damage: damageForBracket(weapon, breakdown.rangeBracket),
      });
    }
  } else {
    base.groups.push({
      location: hitLocation(roll2D6(input.rng)),
      damage: damageForBracket(weapon, breakdown.rangeBracket),
    });
  }

  let damage = input.targetDamage;
  let application: DamageApplication | null = null;
  const arc = input.arc ?? "front";
  const critStateAvailable =
    input.targetDef !== undefined &&
    input.targetCritSlotsDestroyed !== undefined &&
    input.targetDestroyedWeapons !== undefined &&
    input.targetShotsLeft !== undefined;
  // Mutable crit tracking; each group that strips IS in the SAME location
  // reuses the snapshot from the previous group's crit, mirroring the rules
  // ("before resolving any further weapons fire" the determining roll is
  // made and the crit slot state advances immediately).
  let critSlotsDestroyed: Record<Location, boolean[]> | undefined = input.targetCritSlotsDestroyed
    ? cloneDestroyed(input.targetCritSlotsDestroyed)
    : undefined;
  let destroyedWeapons: number[] = input.targetDestroyedWeapons
    ? [...input.targetDestroyedWeapons]
    : [];
  let shotsLeft: Record<number, number> = input.targetShotsLeft ? { ...input.targetShotsLeft } : {};

  for (const group of base.groups) {
    const app = applyDamage(damage, group.location, group.damage, arc);
    damage = app.damage;
    application =
      application === null
        ? app
        : {
            damage: app.damage,
            steps: [...application.steps, ...app.steps],
            newlyDestroyed: [...application.newlyDestroyed, ...app.newlyDestroyed],
            blownOffArms: [...application.blownOffArms, ...app.blownOffArms],
            killed: application.killed || app.killed,
          };

    if (!critStateAvailable || !input.targetDef) continue;
    // Did this group strip at least 1 IS point at the group's *original*
    // location (not a transferred one)? The rules call for one determining
    // roll per location that loses IS in a given group.
    const stripped = app.steps.some(
      (s) => s.location === group.location && s.pool === "structure" && s.damageApplied > 0,
    );
    if (!stripped) continue;
    const res = resolveCriticalHits({
      rng: input.rng,
      def: input.targetDef,
      source: { location: group.location, damage: group.damage },
      critSlotsDestroyed: critSlotsDestroyed!,
      destroyedWeapons,
      damage,
      shotsLeft,
    });
    critSlotsDestroyed = res.critSlotsDestroyed;
    destroyedWeapons = res.destroyedWeapons;
    shotsLeft = res.shotsLeft;
    damage = res.damage;
    // The crit may have blown off the arm or killed the unit; reflect that
    // on the merged damage application.
    if (application) {
      application = {
        ...application,
        damage: res.damage,
        blownOffArms: mergeUnique(application.blownOffArms, res.blownOffArms),
        killed: application.killed || res.killed,
      };
    }
    base.crits.push(res);
  }
  base.application = application;
  return base;
}

function cloneDestroyed(src: Record<Location, boolean[]>): Record<Location, boolean[]> {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  (Object.keys(src) as Location[]).forEach((loc) => {
    out[loc] = src[loc].slice();
  });
  return out;
}

function mergeUnique(a: readonly Location[], b: readonly Location[]): Location[] {
  const out: Location[] = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}
