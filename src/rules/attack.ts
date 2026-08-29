import { roll2D6 } from "../core/dice.js";
import type { Location, MoveMode, Rng, TerrainType } from "../core/types.js";
import type { WeaponDef } from "../data/weapons.js";
import { getWeapon } from "../data/weapons.js";
import type { Arc } from "./arcs.js";
import { clusterHitsForMissiles, clusterHitsForShots, groupMissiles } from "./cluster.js";
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
}

/** Resolve one declared weapon attack end-to-end: to-hit, location(s), damage. */
export function resolveWeaponAttack(input: WeaponAttackInput): AttackResolution {
  const weapon: WeaponDef = getWeapon(input.weaponName);
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
  }
  base.application = application;
  return base;
}
