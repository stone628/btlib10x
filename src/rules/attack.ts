import { roll2D6 } from "../core/dice";
import { hasPartialCover } from "../core/terrain";
import type {
  ArmLocation,
  LimbLocation,
  Location,
  MoveMode,
  Rng,
  TerrainType,
} from "../core/types";
import type { ResolvedMechDef } from "../data/mech.schema";
import type { WeaponDef } from "../data/weapon.schema";
import { weaponDefFor } from "../data/weapon.schema";
import type { AmmoBins } from "./ammo";
import type { Arc } from "./arcs";
import { clusterHits, groupMissiles, modifiedClusterRoll } from "./cluster";
import { type CriticalResolution, resolveCriticalHits } from "./critical";
import {
  applyDamage,
  type DamageApplication,
  structureStruck,
  type UnitDamageState,
} from "./damage";
import { toHitHeatModifier } from "./heat";
import { hitLocationForArc } from "./hitlocation";
import { losWoodsPoints } from "./los";
import { computeToHit, damageForBracket, type ToHitBreakdown } from "./tohit";

export interface HitGroup {
  readonly location: Location;
  readonly damage: number;
  /** True when the hit-location roll was a 2: through-armor critical
   *  (damage lands on armor normally, plus a determining roll, TW p.123). */
  readonly throughArmor: boolean;
}

export interface WeaponAttackInput {
  readonly rng: Rng;
  readonly gunnery: number;
  readonly attackerMoved: MoveMode;
  readonly targetHexesMoved: number;
  readonly targetJumped: boolean;
  readonly targetTerrain: TerrainType;
  /** True when the target cannot move (shut down or both legs destroyed):
   *  grants a flat −4 target modifier instead of the hex-based band. */
  readonly targetImmobile?: boolean;
  /** True when the target is prone (but not immobile): −2 adjacent, +1
   *  otherwise (TW p.109). Forwarded to `computeToHit` with `distance`. */
  readonly targetProne?: boolean;
  /** True when the attacker is prone: +2 attacker modifier (TW p.113). */
  readonly attackerProne?: boolean;
  /**
   * Arm the prone attacker props itself up on (TW p.113): weapons mounted in
   * the other arm remain fireable. Null (or omitted) when standing, or when a
   * prone attacker fires no arm-mounted weapons (nothing to prop against).
   * Echoed into `AttackResolution.propArm`.
   */
  readonly propArm?: ArmLocation | null;
  /** Destroyed-sensor to-hit modifier on the attacker: 0 intact, +2 on the
   *  first hit; a second hit blinds the 'Mech (declare no attacks, TW p.123).
   *  Callers map the destroyed-slot count via `sensorAttackModifier`. */
  readonly sensorMod?: number;
  /** Arm-actuator to-hit modifier for the firing arm (TW p.125); caller
   *  computes per weapon mount via `armWeaponToHitModifier`. */
  readonly actuatorMod?: number;
  /** Targeting-computer modifier for this weapon (TW p.143). */
  readonly tcMod?: number;
  /** Partial-cover to-hit modifier supplied by the caller (the board aware
   *  of wrecks): 2 when the target is adjacent to a level-2 wreck and the
   *  attacker is below its top. Merged with the terrain-derived value
   *  (larger wins); the caller computes it in `partialCoverMod`. */
  readonly partialCoverMod?: number;
  readonly interveningTerrains: readonly TerrainType[];
  /** Damage the target's building hex absorbs from each hit grouping: its CF
   *  at the start of the phase ÷ 10, rounded up (TW p.171). */
  readonly buildingAbsorb?: number;
  readonly distance: number;
  readonly weapon: string;
  readonly ammoExhausted?: boolean;
  /** Shots fired this attack; >1 only valid for rapid-fire (R) weapons. */
  readonly shots?: number;
  /** Layered damage state of the target. */
  readonly targetDamage: UnitDamageState;
  /** Attack direction: the side of the TARGET the attack strikes (TW p.119),
   *  classified from the target's facing. Drives the hit-location table
   *  column and the front/rear armor pool. Default front. */
  readonly arc?: Arc;
  /** Attacker's ground elevation in levels (default 0). */
  readonly attackerLevel?: number;
  /** Target's ground elevation in levels (default 0). */
  readonly targetLevel?: number;
  /**
   * Attacker's current heat value. Drives the Heat Scale to-hit modifier
   * (+1..+4). Omitted in tests that never track heat.
   */
  readonly attackerHeat?: number;
  /**
   * Target 'Mech definition; required for critical-hit resolution. Omit in
   * tests that only care about raw damage. When provided, `targetDef` is
   * used for crit-slot layout, weapon linkage, and the per-bin ammo state.
   */
  readonly targetDef?: ResolvedMechDef;
  /** Pre-attack crit-slot destroyed flags (running state for this phase). */
  readonly targetCritSlotsDestroyed?: Record<Location, boolean[]>;
  /** Phase-start crit-slot flags for the TW p.122 step-4 transfer test.
   *  Defaults to `targetCritSlotsDestroyed`. */
  readonly targetBaseCritSlotsDestroyed?: Record<Location, boolean[]>;
  /** Pre-attack destroyed weapon indices. */
  readonly targetDestroyedWeapons?: readonly number[];
  /** Pre-attack per-crit-slot ammo state. */
  readonly targetAmmoBins?: Readonly<AmmoBins>;
}

export interface AttackResolution {
  readonly weapon: string;
  readonly distance: number;
  readonly breakdown: ToHitBreakdown;
  readonly toHitRoll: number | null;
  readonly hit: boolean;
  readonly jammed: boolean;
  /** True when the shot was fired while the attacker was prone (TW p.113). */
  readonly prone: boolean;
  /**
   * Arm the prone attacker propped itself up on for this shot (its weapons
   * could not fire). Null when standing, or when a prone attacker fired no
   * arm-mounted weapons.
   */
  readonly propArm: ArmLocation | null;
  /** True when a streak launcher found its shared pool empty at resolution:
   *  the attack auto-missed without rolling (no ammo spent, no heat). */
  readonly ammoExhausted?: boolean;
  readonly clusterRoll: number | null;
  /** Range-dependent cluster-roll modifier actually applied (HAG +2 short /
   *  -2 long, TW p.136); null when the weapon has none. `clusterRoll` stays
   *  the raw 2D6 thrown. */
  readonly clusterMod: number | null;
  /** Hit groupings that reach the target, after building absorption. */
  readonly groups: readonly HitGroup[];
  /** Damage the building hex soaked from the groupings (TW p.171); this is
   *  what its CF loses. Absent when the target is not in a building. */
  readonly buildingAbsorbed?: number;
  readonly application: DamageApplication | null;
  /** Attack direction the attack resolved against (side of the target hit);
   *  drove the hit-location table and armor pool. Defaults to front when the
   *  input omitted it. */
  readonly arc: Arc;
  /**
   * Critical hit resolutions triggered by the attack, one per group that
   * stripped at least 1 internal-structure point or rolled a through-armor
   * hit location of 2. Empty when no crits were rolled (e.g. `targetDef`
   * was not supplied).
   */
  readonly crits: readonly CriticalResolution[];
}

/** Partial-cover to-hit modifier for cover terrain (water1 / building). */
export const PARTIAL_COVER_TERRAIN_MOD = 1;
/** 2D6 roll that jams a rapid-fire volley of more than one shot. */
const RAPID_FIRE_JAM_ROLL = 2;
/**
 * TW p.113: rapid-fire (Ultra / rotary autocannon) jams on a raw 2D6 of 2
 * (threshold scales +1 per two extra shots). Trigger is the RAW roll, not
 * the modified TN — independent of the auto-hit / auto-miss thresholds from
 * to-hit breakdown. Damage still resolves if the hit test below succeeds,
 * then the jam persists for the rest of the game (rotary AC has its own
 * clearing rule, p.140).
 */
/** Hit-location roll triggering a through-armor critical (TW p.123):
 *  damage lands on armor normally, plus one determining roll. */
const THROUGH_ARMOR_LOCATION_ROLL = 2;
/** Missile damage per missile that still splits into lots (above this: per-missile locations). */
const MISSILE_SINGLE_DAMAGE = 2;
/** Missiles grouped per hit location below MISSILE_SINGLE_DAMAGE. */
const MISSILE_LOT_SIZE = 5;

/** Resolve one declared weapon attack end-to-end: to-hit, location(s), damage. */
export function resolveWeaponAttack(input: WeaponAttackInput): AttackResolution {
  const weapon: WeaponDef = weaponDefFor(input);
  const shots = input.shots ?? 1;
  const arc = input.arc ?? "front";
  // Caller-computed value (battle-state aware, includes wrecks + intervening)
  // wins; direct callers without it get the target-hex fallback.
  const partialCoverMod =
    input.partialCoverMod ??
    (input.targetTerrain === "water1"
      ? PARTIAL_COVER_TERRAIN_MOD
      : hasPartialCover(input.targetTerrain) &&
          (input.attackerLevel ?? 0) <= (input.targetLevel ?? 0)
        ? PARTIAL_COVER_TERRAIN_MOD
        : 0);
  const partialCover = partialCoverMod > 0;

  const breakdown = computeToHit({
    gunnery: input.gunnery,
    attackerMovement: input.attackerMoved,
    ...(input.attackerProne !== undefined ? { attackerProne: input.attackerProne } : {}),
    targetHexesMoved: input.targetHexesMoved,
    targetJumped: input.targetJumped,
    targetTerrain: input.targetTerrain,
    ...(input.targetImmobile !== undefined ? { targetImmobile: input.targetImmobile } : {}),
    ...(input.targetProne !== undefined ? { targetProne: input.targetProne } : {}),
    ...(input.sensorMod !== undefined ? { sensorMod: input.sensorMod } : {}),
    ...(input.actuatorMod !== undefined ? { actuatorMod: input.actuatorMod } : {}),
    ...(input.tcMod !== undefined ? { tcMod: input.tcMod } : {}),
    ...(partialCoverMod > 0 ? { partialCoverMod } : {}),
    interveningWoods: losWoodsPoints(input.interveningTerrains),
    distance: input.distance,
    weapon,
    ...(input.attackerHeat !== undefined ? { heatMod: toHitHeatModifier(input.attackerHeat) } : {}),
  });

  const prone = input.attackerProne ?? false;
  const propArm = prone ? (input.propArm ?? null) : null;

  const base = {
    weapon: weapon.name,
    distance: input.distance,
    breakdown,
    toHitRoll: null as number | null,
    hit: false,
    jammed: false,
    prone,
    propArm,
    ammoExhausted: false,
    clusterRoll: null as number | null,
    clusterMod: null as number | null,
    groups: [] as HitGroup[],
    application: null as DamageApplication | null,
    crits: [] as CriticalResolution[],
    arc,
  };

  if (breakdown.outOfRange) return base;
  if (input.ammoExhausted === true) {
    base.ammoExhausted = true;
    return base;
  }

  const roll = roll2D6(input.rng);
  base.toHitRoll = roll;

  const rapidFire = weapon.rapidFireShots !== undefined && weapon.rapidFireShots > 0;
  const rapidFireJamThreshold = RAPID_FIRE_JAM_ROLL + Math.floor((shots - 2) / 2);
  if (rapidFire && shots > 1 && roll <= rapidFireJamThreshold) base.jammed = true;

  base.hit = breakdown.automatic !== null ? breakdown.automatic === "hit" : roll >= breakdown.total;
  if (!base.hit) return base;

  if (weapon.missiles !== undefined && weapon.missileDamage !== undefined) {
    // Streak launchers: to-hit success means full tube count hits; no
    // cluster roll, no extra RNG consumed. Miss path already returned above,
    // so launcher never fires on miss (no ammo, no heat there either).
    let hits: number;
    if (weapon.streak === true) {
      hits = weapon.missiles;
    } else {
      const clusterRoll = roll2D6(input.rng);
      base.clusterRoll = clusterRoll;
      // HAG range mod (TW p.136): +2 short / 0 medium / -2 long on the
      // 2D6 roll, clamped to 2..12. Other cluster weapons roll unmodified.
      const mod = weapon.clusterRangeMod?.[breakdown.rangeBracket] ?? 0;
      if (mod !== 0) base.clusterMod = mod;
      hits = clusterHits(weapon.missiles, modifiedClusterRoll(clusterRoll, mod));
    }
    if (weapon.missileDamage === MISSILE_SINGLE_DAMAGE) {
      for (let i = 0; i < hits; i++) {
        const placed = hitLocationPlaced(input.rng, partialCover, arc);
        if (placed === null) continue;
        base.groups.push({
          location: placed.location,
          damage: weapon.missileDamage,
          throughArmor: placed.throughArmor,
        });
      }
    } else {
      for (const lot of groupMissiles(hits, MISSILE_LOT_SIZE)) {
        const placed = hitLocationPlaced(input.rng, partialCover, arc);
        if (placed === null) continue;
        base.groups.push({
          location: placed.location,
          damage: lot * weapon.missileDamage,
          throughArmor: placed.throughArmor,
        });
      }
    }
  } else if (rapidFire && shots > 1) {
    const clusterRoll = roll2D6(input.rng);
    base.clusterRoll = clusterRoll;
    const hits = clusterHits(shots, clusterRoll);
    for (let i = 0; i < hits; i++) {
      const placed = hitLocationPlaced(input.rng, partialCover, arc);
      if (placed === null) continue;
      base.groups.push({
        location: placed.location,
        damage: damageForBracket(weapon, breakdown.rangeBracket),
        throughArmor: placed.throughArmor,
      });
    }
  } else {
    const placed = hitLocationPlaced(input.rng, partialCover, arc);
    if (placed !== null) {
      base.groups.push({
        location: placed.location,
        damage: damageForBracket(weapon, breakdown.rangeBracket),
        throughArmor: placed.throughArmor,
      });
    }
  }

  // TW p.171: each grouping loses the hex's absorption before it reaches the
  // unit; the building is charged only what it actually absorbed. A grouping
  // reduced to nothing is dropped (and with it any through-armor crit chance).
  const absorbPerGroup = input.buildingAbsorb ?? 0;
  if (absorbPerGroup > 0) {
    let absorbed = 0;
    const reaching: HitGroup[] = [];
    for (const g of base.groups) {
      const soak = Math.min(absorbPerGroup, g.damage);
      absorbed += soak;
      if (g.damage > soak) reaching.push({ ...g, damage: g.damage - soak });
    }
    base.groups = reaching;
    (base as { buildingAbsorbed?: number }).buildingAbsorbed = absorbed;
  }

  let damage = input.targetDamage;
  let application: DamageApplication | null = null;
  const critStateAvailable =
    input.targetDef !== undefined &&
    input.targetCritSlotsDestroyed !== undefined &&
    input.targetDestroyedWeapons !== undefined &&
    input.targetAmmoBins !== undefined;
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
  let ammoBins: AmmoBins = input.targetAmmoBins ? { ...input.targetAmmoBins } : {};

  for (const group of base.groups) {
    const app = applyDamage(damage, group.location, group.damage, arc);
    damage = app.after;
    application =
      application === null
        ? app
        : {
            after: app.after,
            before: application.before,
            steps: [...application.steps, ...app.steps],
            newlyDestroyed: [...application.newlyDestroyed, ...app.newlyDestroyed],
            blownOffLimbs: [...application.blownOffLimbs, ...app.blownOffLimbs],
            killed: application.killed || app.killed,
          };

    if (!critStateAvailable || !input.targetDef) continue;
    // One determining roll per location whose internal structure this group
    // damaged, transferred locations included (TW p.124 Multiple Locations).
    // A hit-location roll of 2 adds one determining roll on the hit location
    // even with armor unbreached (through-armor critical, TW p.123), "in
    // addition to any structure-damage critical roll" (TW p.124); it resolves
    // last, tagged, slot state advancing between rolls.
    const struck = structureStruck(app);
    const critRolls = struck.map((location) => ({ location, tac: false }));
    if (group.throughArmor) critRolls.push({ location: group.location, tac: true });
    for (const { location: critLoc, tac: tagThroughArmor } of critRolls) {
      const res = resolveCriticalHits({
        rng: input.rng,
        def: input.targetDef,
        source: {
          location: critLoc,
          damage: group.damage,
          struck: struck.includes(critLoc),
          tac: tagThroughArmor,
        },
        ...(tagThroughArmor ? { throughArmor: true } : {}),
        ...(input.targetBaseCritSlotsDestroyed !== undefined
          ? { baseCritSlotsDestroyed: input.targetBaseCritSlotsDestroyed }
          : {}),
        critSlotsDestroyed: critSlotsDestroyed!,
        destroyedWeapons,
        damage,
        ammoBins,
      });
      critSlotsDestroyed = res.critSlotsDestroyed;
      destroyedWeapons = res.destroyedWeapons;
      ammoBins = res.ammoBins;
      damage = res.damage;
      // The crit may have blown off the arm or killed the unit; reflect that
      // on the merged damage application.
      if (application) {
        application = {
          ...application,
          after: res.damage,
          blownOffLimbs: mergeUniqueLimb(application.blownOffLimbs, res.blownOffLimbs),
          killed: application.killed || res.killedReason !== null,
        };
      }
      base.crits.push(res);
    }
  }
  base.application = application;
  return base;
}

/** Hit-location roll on the column for the attack direction `arc`, tagged
 *  when the roll is a through-armor 2. Under partial cover a leg result
 *  strikes the cover instead and the attack deals no damage to the target
 *  (null). */
function hitLocationPlaced(
  rng: Rng,
  partialCover: boolean,
  arc: Arc,
): { location: Location; throughArmor: boolean } | null {
  const roll = roll2D6(rng);
  const location = hitLocationForArc(arc, roll);
  if (partialCover && (location === "leftLeg" || location === "rightLeg")) return null;
  return { location, throughArmor: roll === THROUGH_ARMOR_LOCATION_ROLL };
}

function cloneDestroyed(src: Record<Location, boolean[]>): Record<Location, boolean[]> {
  const out: Record<Location, boolean[]> = {} as Record<Location, boolean[]>;
  (Object.keys(src) as Location[]).forEach((loc) => {
    out[loc] = src[loc].slice();
  });
  return out;
}

function mergeUniqueLimb(a: readonly LimbLocation[], b: readonly LimbLocation[]): LimbLocation[] {
  const out: LimbLocation[] = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}
