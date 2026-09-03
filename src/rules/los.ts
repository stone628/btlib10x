import { hexDistance, lineHexes } from "../core/hex.js";
import { cellAt, type HexGrid, woodsPoints } from "../core/terrain.js";
import type { HexCoord, TerrainType } from "../core/types.js";

/**
 * Hexes along the center-to-center LOS, excluding the attacker's and target's
 * own hexes. The cube-lerp rounding picks one hex deterministically when the
 * line grazes an edge (defender-choice tie-break is a documented v1 gap).
 */
export function interveningHexes(from: HexCoord, to: HexCoord): HexCoord[] {
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
export function losWoodsPointsBetween(grid: HexGrid, from: HexCoord, to: HexCoord): number {
  let points = 0;
  for (const h of interveningHexes(from, to)) {
    points += woodsPoints(cellAt(grid, h).terrain);
  }
  return points;
}

/** Terrain types of hexes between `from` and `to` (endpoints excluded). */
export function interveningTerrains(grid: HexGrid, from: HexCoord, to: HexCoord): TerrainType[] {
  return interveningHexes(from, to).map((h) => cellAt(grid, h).terrain);
}

/**
 * LOS elevation check: a 'Mech's LOS level is its hex level + 1. Draw a real-
 * valued line from the attacker's LOS level to the target's LOS level; an
 * intervening hex C blocks iff its own LOS level (level + 1) meets or exceeds
 * the ray's height at C's center. Bipedal 'Mechs only — no buildings, no
 * hull-down, no partial cover.
 */
export function losBlockedByElevation(grid: HexGrid, from: HexCoord, to: HexCoord): boolean {
  const a = cellAt(grid, from).level;
  const b = cellAt(grid, to).level;
  const aLos = a + 1;
  const bLos = b + 1;
  const dTotal = hexDistance(from, to);
  if (dTotal === 0) return false;
  for (const h of interveningHexes(from, to)) {
    const dA = hexDistance(from, h);
    const rayHeight = aLos + (bLos - aLos) * (dA / dTotal);
    if (cellAt(grid, h).level + 1 > rayHeight) return true;
  }
  return false;
}

/** True when both the woods and elevation LOS checks are clear. */
export function losClear(grid: HexGrid, from: HexCoord, to: HexCoord): boolean {
  if (losBlocked(losWoodsPointsBetween(grid, from, to))) return false;
  if (losBlockedByElevation(grid, from, to)) return false;
  return true;
}
