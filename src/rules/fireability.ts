import { D2D6_FUMBLE, D2D6_MAX } from "../core/dice.js";
import { bearingExact, hexDistance } from "../core/hex.js";
import { cellAt } from "../core/terrain.js";
import type { Location } from "../core/types.js";
import { getMechDefFor } from "../data/index.js";
import { getWeaponDefFor } from "../data/weapon.schema.js";
import { binsForWeaponName, pooledShotsLeft } from "./ammo.js";
import { type Arc, classifyArcWithBoundary, weaponCanFireIntoArc } from "./arcs.js";
import { canFireFromLocation } from "./damage.js";
import { type BattleState, isImmobile, isUnitRemoved, partialCoverMod } from "./game.js";
import { toHitHeatModifier } from "./heat.js";
import { losClear, losWoodsPointsBetween } from "./los.js";
import { countDestroyedStructure, SENSORS } from "./piloting.js";
import type { RangeBracket } from "./tohit.js";
import { computeToHit, damageForBracket } from "./tohit.js";

export type FireBlockerReason =
  | "jammed"
  | "destroyed"
  | "outOfRange"
  | "outOfArc"
  | "noLos"
  | "outOfAmmo"
  | "autoMiss"
  | "prone";

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
   *  arc-boundary line; otherwise null. A weapon is legal when it can fire
   *  into either arc of the pair. */
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

function hitProbability(tn: number): number {
  if (tn <= D2D6_FUMBLE) return 1;
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
export function suggestFireTargets(state: BattleState, unitId: string): FireSuggestion {
  const unit = state.units[unitId];
  if (!unit || isUnitRemoved(unit)) {
    throw new Error(`suggestFireTargets: ${unitId} is not a fireable unit`);
  }
  const def = getMechDefFor(unit);
  const sensorsOut = countDestroyedStructure(def, unit.critSlotsDestroyed, SENSORS);
  const targets = Object.values(state.units)
    .filter((u) => u.team !== unit.team && !isUnitRemoved(u))
    .map((enemy) => {
      const distance = hexDistance(unit.position, enemy.position);
      const b = bearingExact(unit.position, enemy.position);
      const fireCls = b !== null ? classifyArcWithBoundary(unit.facing, b) : null;
      const arc = fireCls?.arc ?? null;
      const altArc = fireCls?.altArc ?? null;
      const interveningWoods = losWoodsPointsBetween(state, unit.position, enemy.position);

      const weaponsIfPropLeft: FireWeapon[] = [];
      const weaponsIfPropRight: FireWeapon[] = [];
      const blockedIfPropLeft: FireBlocked[] = [];
      const blockedIfPropRight: FireBlocked[] = [];

      Object.entries(def.weapons).forEach(([key, mount]) => {
        const weaponIndex = Number(key);
        const weapon = getWeaponDefFor(mount);
        const blockedEntry = (reason: FireBlockerReason): FireBlocked => ({
          weaponIndex,
          weapon: mount.weapon,
          reason,
        });
        const blockBoth = (reason: FireBlockerReason): void => {
          blockedIfPropLeft.push(blockedEntry(reason));
          blockedIfPropRight.push(blockedEntry(reason));
        };
        if (unit.jammedWeapons.includes(weaponIndex)) {
          blockBoth("jammed");
          return;
        }
        if (unit.destroyedWeapons.includes(weaponIndex)) {
          blockBoth("destroyed");
          return;
        }
        if (!canFireFromLocation(unit.phaseStartDamage, mount.location)) {
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
        const shots = poolable ? pooledShotsLeft(def, unit.ammoBins, weapon.name) : null;
        if (poolable && (shots ?? 0) < 1) {
          blockBoth("outOfAmmo");
          return;
        }
        // Same gate as `declareAttacks`: same-hex targets are unsupported,
        // and the weapon's mounting arc (TW p.105) must cover the target's
        // firing arc (either arc of the pair on a boundary line).
        if (fireCls === null || arc === null) {
          blockBoth("outOfArc");
          return;
        }
        const rearFacing = mount.rearFacing === true;
        const primaryOk = weaponCanFireIntoArc(mount.location, rearFacing, fireCls.arc);
        const altOk =
          fireCls.altArc !== null &&
          weaponCanFireIntoArc(mount.location, rearFacing, fireCls.altArc);
        if (!primaryOk && !altOk) {
          blockBoth("outOfArc");
          return;
        }
        // Record arc weapon actually fires through: primary when legal,
        // otherwise alternate of boundary pair.
        const firingArc = primaryOk ? fireCls.arc : fireCls.altArc!;
        // Same gate as `declareAttacks`: woods screening, water2/3 endpoints
        // (`losBlockedByWater`), elevation and intervening buildings
        // (`losBlockedByElevation`/`losBlockedByBuilding` fold into the ray).
        if (!losClear(state, unit.position, enemy.position, state.wrecks)) {
          blockBoth("noLos");
          return;
        }
        const breakdown = computeToHit({
          gunnery: unit.gunnery,
          attackerMovement: unit.moveMode ?? "standStill",
          attackerProne: unit.prone,
          sensorMod: sensorsOut,
          targetHexesMoved: enemy.movesThisTurn.length,
          targetJumped: enemy.jumpedThisTurn,
          targetImmobile: isImmobile(enemy),
          targetProne: enemy.prone,
          targetTerrain: cellAt(state, enemy.position).terrain,
          partialCoverMod: partialCoverMod(state, unit, enemy),
          interveningWoods,
          distance,
          weapon,
          attackerLevel: cellAt(state, unit.position).level,
          targetLevel: cellAt(state, enemy.position).level,
          heatMod: toHitHeatModifier(unit.heat),
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
          tn: breakdown.total,
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
