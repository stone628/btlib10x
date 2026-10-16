import { D2D6_MAX, D2D6_MIN } from "../core/dice";
import { hexDistance } from "../core/hex";
import { cellAt } from "../core/terrain";
import type { Location } from "../core/types";
import { mechDefFor } from "../data/index";
import { weaponDefFor } from "../data/weapon.schema";
import { armWeaponToHitModifier, targetingComputerModifier } from "./actuators";
import { binsForWeaponName, pooledShotsLeft } from "./ammo";
import {
  type Arc,
  classifyFiringArc,
  effectiveFacingForTwist,
  mountArcLocation,
  mountCanFireIntoArc,
} from "./arcs";
import { countDestroyedSensor, isWeaponCritted } from "./critical";
import { canFireMount, isUnitLocationDestroyed } from "./damage";
import {
  type BattleState,
  isImmobile,
  isTargetableBy,
  isUnitOnBoard,
  isUnitRemoved,
  losEnds,
  partialCoverMod,
} from "./game";
import { toHitHeatModifier } from "./heat";
import { losClear, losWoodsPointsBetween } from "./los";
import { sensorAttackModifier, sensorsBlind } from "./piloting";
import type { RangeBracket } from "./tohit";
import { computeToHit, damageForBracket, toHitTotal } from "./tohit";

export type FireBlockerReason =
  | "jammed"
  | "destroyed"
  | "outOfRange"
  | "outOfArc"
  | "noLos"
  | "outOfAmmo"
  | "autoMiss"
  | "prone"
  | "noSensor";

export interface FireWeapon {
  readonly weaponIndex: number;
  readonly weapon: string;
  readonly location: Location;
  /** Firing arc of the target relative to the ATTACKER's facing (the arc the
   *  weapon legally fires into). The side of the target struck (attack
   *  direction) is classified at declaration time in `declareAttacks`. */
  readonly arc: Arc;
  readonly shots: number | null;
  readonly rangeBracket: RangeBracket;
  readonly tn: number;
  /** Added to-hit penalty when the target is closer than the weapon's
   *  minimum range; `tn` already includes it. */
  readonly minRangePenalty?: number;
  readonly heat: number;
  readonly expectedDamage: number;
  readonly cluster?: { shots: number; perMissile: number };
}

export interface FireBlocked {
  readonly weaponIndex: number;
  readonly weapon: string;
  readonly reason: FireBlockerReason;
}

export interface FireTarget {
  readonly targetId: string;
  readonly distance: number;
  /** Firing arc of this target relative to the ATTACKER's facing; null when
   *  attacker and target share a hex (arc undefined, attack unsupported). */
  readonly arc: Arc | null;
  /** Alternate arc when the center-to-center line runs exactly along an
   *  arc-boundary line; otherwise null. The TW p.105 firing template assigns
   *  every hex wholly to one arc, so this is always null for firing arcs
   *  (retained for API compatibility). A weapon is legal when it can fire
   *  into the target's arc. */
  readonly altArc: Arc | null;
  /**
   * Fireable weapons when standing, else alias of the prop-right variant
   * (historic default). Prefer the `weaponsIfProp*` lists when prone.
   */
  readonly weapons: FireWeapon[];
  /** Alias of `blockedIfPropRight` when prone; standing shares all lists. */
  readonly blocked: FireBlocked[];
  /** Fireable weapons while propping on the left arm (left-arm mounts out). */
  readonly weaponsIfPropLeft: FireWeapon[];
  /** Fireable weapons while propping on the right arm (right-arm mounts out). */
  readonly weaponsIfPropRight: FireWeapon[];
  /** Blocked weapons while propping on the left arm. */
  readonly blockedIfPropLeft: FireBlocked[];
  /** Blocked weapons while propping on the right arm. */
  readonly blockedIfPropRight: FireBlocked[];
}

export interface FireSuggestion {
  readonly targetId: string;
  /** Enemy targets sorted best-first (most fireable weapons, then highest
   *  hit-weighted damage, then shortest distance). */
  readonly targets: FireTarget[];
}

/** 2d6 ways to roll >= tn, over 36. TNs below 3 always hit; above 12 never do. */
const WAYS_TO_HIT: readonly number[] = [36, 36, 36, 35, 33, 30, 26, 21, 15, 10, 6, 3, 1, 0];

/** Probability that 2D6 rolls at least `tn` (TW p. 106: 2 or less always hits, over 12 never). */
export function hitProbability(tn: number): number {
  if (tn <= D2D6_MIN) return 1;
  if (tn > D2D6_MAX) return 0;
  return WAYS_TO_HIT[tn]! / 36;
}

/** Hit-weighted damage across a target's fireable weapons. Higher is better. */
export function fireTargetScore(target: FireTarget): number {
  const lists = [target.weaponsIfPropLeft, target.weaponsIfPropRight];
  let best = 0;
  for (const list of lists) {
    const score = list.reduce((sum, w) => sum + w.expectedDamage * hitProbability(w.tn), 0);
    if (score > best) best = score;
  }
  return best;
}

/** Best-first ordering for fire targets. */
export function compareFireTargets(a: FireTarget, b: FireTarget): number {
  const aCount = Math.max(a.weaponsIfPropLeft.length, a.weaponsIfPropRight.length);
  const bCount = Math.max(b.weaponsIfPropLeft.length, b.weaponsIfPropRight.length);
  if (aCount !== bCount) return bCount - aCount;
  const score = fireTargetScore(b) - fireTargetScore(a);
  if (score !== 0) return score;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
}

/** Best fire target (most fireable weapons, then hit-weighted damage), or
 *  null when no enemy targets exist. */
export function bestFireTarget(sugg: FireSuggestion): FireTarget | null {
  return sugg.targets[0] ?? null;
}

/**
 * For the acting unit, enumerate every enemy 'Mech and, per target, list the
 * weapons that could reach it (within arc, LOS, range, ammo, not jammed or
 * destroyed, and not auto-missing). Weapons that cannot fire list the reason.
 * Ammo checks read the shared per-weapon-name pool (`pooledShotsLeft`), so
 * every mount of a pooled weapon reports the same remaining shots. Mirrors
 * the checks made by `declareAttacks` so any suggested combination is
 * guaranteed to be accepted there. Targets sort best-first (most fireable
 * weapons, then hit-weighted damage, then shortest distance), so callers
 * picking `targets[0]` engage with most firepower.
 *
 * When the attacker is prone, each target carries two weapon sets: propping
 * on the left arm blocks left-arm mounts (`weaponsIfPropLeft`), propping on
 * the right arm blocks right-arm mounts (`weaponsIfPropRight`). A legal
 * prone volley draws from exactly one set (never both arms at once); leg
 * mounts stay blocked in both. When standing, all lists match.
 */
export function suggestFireTargets(
  state: BattleState,
  unitId: string,
  twist: Arc | null = null,
): FireSuggestion {
  const unit = state.units[unitId];
  if (!unit || isUnitRemoved(unit)) {
    throw new Error(`suggestFireTargets: ${unitId} is not a fireable unit`);
  }
  const def = mechDefFor(unit);
  const sensorsOut = countDestroyedSensor(def, unit.damage, unit.critSlotsDestroyed);
  const blind = sensorsBlind(sensorsOut);
  const sensorMod = sensorAttackModifier(sensorsOut);
  const effectiveFacing = effectiveFacingForTwist(unit.facing, twist);
  const targets = Object.values(state.units)
    .filter((u) => u.id !== unit.id && isUnitOnBoard(u) && isTargetableBy(unit, u))
    .map((enemy) => {
      const distance = hexDistance(unit.position, enemy.position);
      // TW p.105 hex template: every hex falls wholly in one firing arc
      // (null only when attacker and target share a hex).
      const arc = classifyFiringArc(unit.position, enemy.position, effectiveFacing);
      const altArc = null as Arc | null;
      const interveningWoods = losWoodsPointsBetween(
        state,
        unit.position,
        enemy.position,
        losEnds(state, unit, enemy),
      );

      const weaponsIfPropLeft: FireWeapon[] = [];
      const weaponsIfPropRight: FireWeapon[] = [];
      const blockedIfPropLeft: FireBlocked[] = [];
      const blockedIfPropRight: FireBlocked[] = [];

      Object.entries(def.weapons).forEach(([key, mount]) => {
        const weaponIndex = Number(key);
        const weapon = weaponDefFor(mount);
        // Physical-weapon equipment (TW p.146) never fires as a ranged
        // weapon: it is used through strike declarations only.
        if (weapon.physicalWeapon === true) return;
        const blockedEntry = (reason: FireBlockerReason): FireBlocked => ({
          weaponIndex,
          weapon: mount.weapon,
          reason,
        });
        const blockBoth = (reason: FireBlockerReason): void => {
          blockedIfPropLeft.push(blockedEntry(reason));
          blockedIfPropRight.push(blockedEntry(reason));
        };
        // Second destroyed sensor blinds the 'Mech: no weapon attacks (TW p.123).
        if (blind) {
          blockBoth("noSensor");
          return;
        }
        if (unit.jammedWeapons.includes(weaponIndex)) {
          blockBoth("jammed");
          return;
        }
        if (isWeaponCritted(def, unit.critSlotsDestroyed, weaponIndex)) {
          blockBoth("destroyed");
          return;
        }
        const baseDamage = unit.damage;
        if (
          unit.prone &&
          (isUnitLocationDestroyed(baseDamage, "leftArm") ||
            isUnitLocationDestroyed(baseDamage, "rightArm"))
        ) {
          blockBoth("prone");
          return;
        }
        if (!canFireMount(baseDamage, mount)) {
          blockBoth("destroyed");
          return;
        }
        // Prone gates mirror `declareAttacks`: leg mounts never fire; each
        // prop choice blocks its own arm only, so arm mounts land in exactly
        // one variant list.
        if (unit.prone && (mount.location === "rightLeg" || mount.location === "leftLeg")) {
          blockBoth("prone");
          return;
        }
        const poolable = binsForWeaponName(def, weapon.name).length > 0;
        const shots = poolable ? pooledShotsLeft(def, unit, weapon.name) : null;
        if (poolable && (shots ?? 0) < 1) {
          blockBoth("outOfAmmo");
          return;
        }
        // Same gate as `declareAttacks`: same-hex targets are unsupported,
        // and the weapon's mounting arc (TW p.105) must cover the target's
        // firing arc.
        if (arc === null) {
          blockBoth("outOfArc");
          return;
        }
        if (!mountCanFireIntoArc(mount, arc)) {
          blockBoth("outOfArc");
          return;
        }
        // Record arc weapon actually fires through.
        const firingArc = arc;
        // Same gate as `declareAttacks`: woods screening, water2/3 endpoints
        // (`losBlockedByWater`), elevation and intervening buildings
        // (`losBlockedByElevation`/`losBlockedByBuilding` fold into the ray).
        if (!losClear(state, unit.position, enemy.position, losEnds(state, unit, enemy))) {
          blockBoth("noLos");
          return;
        }
        const breakdown = computeToHit({
          gunnery: unit.gunnery,
          attackerMovement: unit.moveMode ?? "standStill",
          attackerProne: unit.prone,
          sensorMod,
          actuatorMod: armWeaponToHitModifier(
            def,
            unit.damage,
            unit.critSlotsDestroyed,
            mountArcLocation(mount),
          ),
          targetHexesMoved: enemy.hexesMovedThisTurn,
          targetJumped: enemy.jumpedThisTurn,
          targetImmobile: isImmobile(enemy),
          targetProne: enemy.prone,
          targetTerrain: cellAt(state, enemy.position).terrain,
          partialCoverMod: partialCoverMod(state, unit, enemy),
          interveningWoods,
          distance,
          weapon,
          heatMod: toHitHeatModifier(unit.heat),
          tcMod: targetingComputerModifier(def, unit.damage, unit.critSlotsDestroyed, weapon),
        });
        if (breakdown.outOfRange) {
          blockBoth("outOfRange");
          return;
        }
        if (breakdown.automatic === "miss") {
          blockBoth("autoMiss");
          return;
        }
        const weaponSugg: FireWeapon = {
          weaponIndex,
          weapon: mount.weapon,
          location: mount.location,
          arc: firingArc,
          shots,
          rangeBracket: breakdown.rangeBracket,
          tn: toHitTotal(breakdown),
          ...(breakdown.minRangeMod > 0 ? { minRangePenalty: breakdown.minRangeMod } : {}),
          heat: weapon.heat ?? 0,
          expectedDamage:
            weapon.missiles !== undefined
              ? (weapon.missileDamage ?? 1) * weapon.missiles
              : damageForBracket(weapon, breakdown.rangeBracket),
          ...(weapon.missiles !== undefined
            ? {
                cluster: {
                  shots: weapon.missiles,
                  perMissile: weapon.missileDamage ?? 1,
                },
              }
            : {}),
        };
        if (unit.prone && mount.location === "leftArm") {
          blockedIfPropLeft.push(blockedEntry("prone"));
          weaponsIfPropRight.push(weaponSugg);
          return;
        }
        if (unit.prone && mount.location === "rightArm") {
          weaponsIfPropLeft.push(weaponSugg);
          blockedIfPropRight.push(blockedEntry("prone"));
          return;
        }
        weaponsIfPropLeft.push(weaponSugg);
        weaponsIfPropRight.push(weaponSugg);
      });

      return {
        targetId: enemy.id,
        distance,
        arc,
        altArc,
        weapons: weaponsIfPropRight,
        blocked: blockedIfPropRight,
        weaponsIfPropLeft,
        weaponsIfPropRight,
        blockedIfPropLeft,
        blockedIfPropRight,
      };
    });
  targets.sort(compareFireTargets);

  return { targetId: unitId, targets };
}
