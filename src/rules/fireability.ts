import { bearing, hexDistance } from "../core/hex.js";
import type { Location } from "../core/types.js";
import { getWeapon } from "../data/weapons.js";
import { isInFrontArc } from "./arcs.js";
import { canFireFromLocation } from "./damage.js";
import type { BattleState } from "./game.js";
import { losBlocked, losWoodsPointsBetween } from "./los.js";
import * as mv from "./movement.js";
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
  readonly ammoShots: number | null;
  readonly rangeBracket: RangeBracket;
  readonly tn: number;
  readonly expectedDamage: number;
  readonly cluster?: { shots: number; perMissile: number };
}

export interface FireTarget {
  readonly targetId: string;
  readonly distance: number;
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
 * Mirrors the checks made by `declareAttacks` so any suggested combination is
 * guaranteed to be accepted there.
 */
export function suggestFireTargets(state: BattleState, unitId: string): FireSuggestion {
  const unit = state.units[unitId];
  if (!unit || unit.destroyed || unit.removed) {
    throw new Error(`suggestFireTargets: ${unitId} is not a fireable unit`);
  }
  const def = state.defs[unit.model]!;

  const targets = Object.values(state.units)
    .filter((u) => u.team !== unit.team && !u.removed && !u.destroyed)
    .map((enemy) => {
      const distance = hexDistance(unit.position, enemy.position);
      const bearingToTarget = bearing(unit.position, enemy.position);
      const inArc = bearingToTarget !== null && isInFrontArc(unit.facing, bearingToTarget);
      const interveningWoods = losWoodsPointsBetween(state.terrain, unit.position, enemy.position);
      const los = losBlocked(interveningWoods);

      const weapons: FireWeapon[] = [];
      const blocked: FireTarget["blocked"] = [];

      def.weapons.forEach((mount, weaponIndex) => {
        const weapon = getWeapon(mount.weapon);
        if (unit.jammedWeapons.includes(weaponIndex)) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "jammed" });
          return;
        }
        if (!canFireFromLocation(unit.phaseStartDamage, mount.location)) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "destroyed" });
          return;
        }
        const ammoShots = mount.ammoShots !== undefined ? (unit.ammoLeft[weaponIndex] ?? 0) : null;
        if (mount.ammoShots !== undefined && ammoShots! < 1) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "outOfAmmo" });
          return;
        }
        if (bearingToTarget === null || !inArc) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "outOfArc" });
          return;
        }
        if (los) {
          blocked.push({ weaponIndex, weapon: mount.weapon, reason: "noLos" });
          return;
        }
        const breakdown = computeToHit({
          gunnery: unit.gunnery,
          attackerMovement: unit.moveMode ?? "standStill",
          targetHexesMoved: mv.hexesSinceLastReversal(enemy.movesThisTurn),
          targetJumped: enemy.jumpedThisTurn,
          targetTerrain: mv.terrainAt(state.terrain, enemy.position),
          interveningWoods,
          distance,
          weapon,
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
          ammoShots,
          rangeBracket: breakdown.rangeBracket,
          tn: breakdown.total,
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

      return { targetId: enemy.id, distance, weapons, blocked };
    });

  return { targetId: unitId, targets };
}
