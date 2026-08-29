import { lineHexes } from "../core/hex.js";
import { woodsPoints } from "../core/terrain.js";
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
