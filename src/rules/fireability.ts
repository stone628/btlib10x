import { bearing, hexDistance } from "../core/hex.js";
import { cellAt, hasPartialCover } from "../core/terrain.js";
import type { Location } from "../core/types.js";
import { getMechDefFor } from "../data/index.js";
import { getWeaponDefFor } from "../data/weapon.schema.js";
import { binsForWeaponName, pooledShotsLeft } from "./ammo.js";
import { type Arc, classifyArc } from "./arcs.js";
import { canFireFromLocation } from "./damage.js";
import { type BattleState, isImmobile } from "./game.js";
import { toHitHeatModifier } from "./heat.js";
import { losClear, losWoodsPointsBetween } from "./los.js";
import type { RangeBracket } from "./tohit.js";
import { computeToHit, damageForBracket } from "./tohit.js";

export type FireBlockerReason =
  | "jammed"
  | "destroyed"
  | "outOfRange"
  | "outOfArc"
  | "noLos"
  | "outOfAmmo"
  | "autoMiss";

export interface FireWeapon {
  readonly weaponIndex: number;
  readonly weapon: string;
  readonly location: Location;
  /** Firing arc of the target relative to the attacker's facing. */
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

export interface FireTarget {
  readonly targetId: string;
  readonly distance: number;
  /** Firing arc of this target relative to the attacker's facing; null when
   *  attacker and target share a hex (arc undefined, attack unsupported). */
  readonly arc: Arc | null;
  readonly weapons: FireWeapon[];
  readonly blocked: Array<{
    readonly weaponIndex: number;
    readonly weapon: string;
    readonly reason: FireBlockerReason;
  }>;
}

export interface FireSuggestion {
  readonly targetId: string;
  readonly targets: FireTarget[];
}

/**
 * For the acting unit, enumerate every enemy 'Mech and, per target, list the
 * weapons that could reach it (within arc, LOS, range, ammo, not jammed or
 * destroyed, and not auto-missing). Weapons that cannot fire list the reason.
 * Ammo checks read the shared per-weapon-name pool (`pooledShotsLeft`), so
 * every mount of a pooled weapon reports the same remaining shots. Mirrors
 * the checks made by `declareAttacks` so any suggested combination is
 * guaranteed to be accepted there.
 */
export function suggestFireTargets(state: BattleState, unitId: string): FireSuggestion {
  const unit = state.units[unitId];
  if (!unit || unit.destroyed || unit.removed) {
    throw new Error(`suggestFireTargets: ${unitId} is not a fireable unit`);
  }
  const def = getMechDefFor(unit);

  const targets = Object.values(state.units)
    .filter((u) => u.team !== unit.team && !u.removed && !u.destroyed)
    .map((enemy) => {
      const distance = hexDistance(unit.position, enemy.position);
      const bearingToTarget = bearing(unit.position, enemy.position);
      const arc = bearingToTarget !== null ? classifyArc(unit.facing, bearingToTarget) : null;
      const interveningWoods = losWoodsPointsBetween(state, unit.position, enemy.position);

      const weapons: FireWeapon[] = [];
      const blocked: FireTarget["blocked"] = [];

      Object.entries(def.weapons).forEach(([key, mount]) => {
        const weaponIndex = Number(key);
        const weapon = getWeaponDefFor(mount);
        if (unit.jammedWeapons.includes(weaponIndex)) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "jammed" });
          return;
        }
        if (unit.destroyedWeapons.includes(weaponIndex)) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "destroyed" });
          return;
        }
        if (!canFireFromLocation(unit.phaseStartDamage, mount.location)) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "destroyed" });
          return;
        }
        const poolable = binsForWeaponName(def, weapon.name).length > 0;
        const shots = poolable ? pooledShotsLeft(def, unit.ammoBins, weapon.name) : null;
        if (poolable && (shots ?? 0) < 1) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "outOfAmmo" });
          return;
        }
        if (bearingToTarget === null || arc === null) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "outOfArc" });
          return;
        }
        // Same gate as `declareAttacks`: woods screening, water2/3 endpoints
        // (`losBlockedByWater`), elevation and intervening buildings
        // (`losBlockedByElevation`/`losBlockedByBuilding` fold into the ray).
        if (!losClear(state, unit.position, enemy.position)) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "noLos" });
          return;
        }
        const breakdown = computeToHit({
          gunnery: unit.gunnery,
          attackerMovement: unit.moveMode ?? "standStill",
          targetHexesMoved: enemy.movesThisTurn.length,
          targetJumped: enemy.jumpedThisTurn,
          targetImmobile: isImmobile(enemy),
          targetTerrain: cellAt(state, enemy.position).terrain,
          targetPartialCover:
            hasPartialCover(cellAt(state, enemy.position).terrain) &&
            cellAt(state, unit.position).level <= cellAt(state, enemy.position).level,
          interveningWoods,
          distance,
          weapon,
          attackerLevel: cellAt(state, unit.position).level,
          targetLevel: cellAt(state, enemy.position).level,
          heatMod: toHitHeatModifier(unit.heat),
        });
        if (breakdown.outOfRange) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "outOfRange" });
          return;
        }
        if (breakdown.automatic === "miss") {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "autoMiss" });
          return;
        }
        const weaponSugg: FireWeapon = {
          weaponIndex,
          weapon: mount.weapon,
          location: mount.location,
          arc,
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
        weapons.push(weaponSugg);
      });

      return { targetId: enemy.id, distance, arc, weapons, blocked };
    });

  return { targetId: unitId, targets };
}
