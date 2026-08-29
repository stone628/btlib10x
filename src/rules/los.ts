import { hexDistance, lineHexes } from "../core/hex.js";
import { levelAt, woodsPoints } from "../core/terrain.js";
import type { Hex, TerrainType } from "../core/types.js";
import { terrainAt } from "./movement.js";

/**
 * Hexes along the center-to-center LOS, excluding the attacker's and target's
 * own hexes. The cube-lerp rounding picks one hex deterministically when the
 * line grazes an edge (defender-choice tie-break is a documented v1 gap).
 */
export function interveningHexes(from: Hex, to: Hex): Hex[] {
  return lineHexes(from, to);
}

export function losWoodsPoints(intervening: readonly TerrainType[]): number {
  let points = 0;
  for (const t of intervening) points += woodsPoints(t);
  return points;
}

/** Three or more points of intervening woods block line of sight. */
export function losBlocked(points: number): boolean {
  return points >= 3;
}

/** Sum of woods points among hexes between `from` and `to` (endpoints excluded). */
export function losWoodsPointsBetween(
  terrain: Readonly<Record<string, TerrainType>>,
  from: Hex,
  to: Hex,
): number {
  let points = 0;
  for (const h of interveningHexes(from, to)) {
    points += woodsPoints(terrainAt(terrain, h));
  }
  return points;
}

/** Terrain types of hexes between `from` and `to` (endpoints excluded). */
export function interveningTerrains(
  terrain: Readonly<Record<string, TerrainType>>,
  from: Hex,
  to: Hex,
): TerrainType[] {
  return interveningHexes(from, to).map((h) => terrainAt(terrain, h));
}

/**
 * LOS elevation check: a 'Mech's LOS level is its hex level + 1. Draw a real-
 * valued line from the attacker's LOS level to the target's LOS level; an
 * intervening hex C blocks iff its own LOS level (level + 1) meets or exceeds
 * the ray's height at C's center. Bipedal 'Mechs only — no buildings, no
 * hull-down, no partial cover.
 */
export function losBlockedByElevation(
  elevation: Readonly<Record<string, number>>,
  from: Hex,
  to: Hex,
): boolean {
  const a = levelAt(elevation, from);
  const b = levelAt(elevation, to);
  const aLos = a + 1;
  const bLos = b + 1;
  const dTotal = hexDistance(from, to);
  if (dTotal === 0) return false;
  for (const h of interveningHexes(from, to)) {
    const dA = hexDistance(from, h);
    const rayHeight = aLos + (bLos - aLos) * (dA / dTotal);
    if (levelAt(elevation, h) + 1 > rayHeight) return true;
  }
  return false;
}

/** True when both the woods and elevation LOS checks are clear. */
export function losClear(
  elevation: Readonly<Record<string, number>>,
  terrain: Readonly<Record<string, TerrainType>>,
  from: Hex,
  to: Hex,
): boolean {
  if (losBlocked(losWoodsPointsBetween(terrain, from, to))) return false;
  if (losBlockedByElevation(elevation, from, to)) return false;
  return true;
}
