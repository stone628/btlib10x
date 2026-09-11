import { hexDistance, lineHexes } from "../core/hex.js";
import { blocksTargeting, cellAt, type HexGrid, screeningPoints } from "../core/terrain.js";
import type { HexCoord, TerrainType, WreckState } from "../core/types.js";
import { buildingTypeOf } from "./building.js";

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
  for (const t of intervening) points += screeningPoints(t);
  return points;
}

/** Three or more points of intervening woods block line of sight. */
export function losBlocked(points: number): boolean {
  return points >= 3;
}

/** Sum of screening points among hexes between `from` and `to` (endpoints excluded). */
export function losWoodsPointsBetween(grid: HexGrid, from: HexCoord, to: HexCoord): number {
  let points = 0;
  for (const h of interveningHexes(from, to)) {
    points += screeningPoints(cellAt(grid, h).terrain);
  }
  return points;
}

/** Terrain types of hexes between `from` and `to` (endpoints excluded). */
export function interveningTerrains(grid: HexGrid, from: HexCoord, to: HexCoord): TerrainType[] {
  return interveningHexes(from, to).map((h) => cellAt(grid, h).terrain);
}

/**
 * Water depth 2+ blocks LOS: units cannot fire into or out of a water2/water3
 * hex. This is checked at the endpoint hexes (attacker or target position).
 */
export function losBlockedByWater(grid: HexGrid, from: HexCoord, to: HexCoord): boolean {
  return blocksTargeting(cellAt(grid, from).terrain) || blocksTargeting(cellAt(grid, to).terrain);
}

/**
 * LOS-blocking height of a hex: its ground level plus the standing feature
 * (1 level for a 'Mech-height crest, 2 for a building — TW: one building
 * level equals two hex levels; default single-level buildings).
 */
function terrainHeightAt(grid: HexGrid, hex: HexCoord): number {
  const cell = cellAt(grid, hex);
  const standing = buildingTypeOf(cell.terrain) !== undefined ? 2 : 1;
  return cell.level + standing;
}

/**
 * LOS elevation check: a 'Mech's LOS level is its hex level + 1. Draw a real-
 * valued line from the attacker's LOS level to the target's LOS level; an
 * intervening hex C blocks iff its own blocking height (level + 1, or +2 for
 * a building) meets or exceeds the ray's height at C's center. Bipedal
 * 'Mechs only — no multi-floor interiors, no hull-down, no partial cover.
 */
export function losBlockedByElevation(grid: HexGrid, from: HexCoord, to: HexCoord): boolean {
  const aLos = cellAt(grid, from).level + 1;
  const bLos = cellAt(grid, to).level + 1;
  const dTotal = hexDistance(from, to);
  if (dTotal === 0) return false;
  for (const h of interveningHexes(from, to)) {
    const dA = hexDistance(from, h);
    const rayHeight = aLos + (bLos - aLos) * (dA / dTotal);
    if (terrainHeightAt(grid, h) > rayHeight) return true;
  }
  return false;
}

/**
 * True when an intervening building hex rises above the LOS ray. Building
 * hexes block LOS (TW p.100) unless the attacker's elevation line clears
 * their height; the building hex a unit occupies is not intervening.
 */
export function losBlockedByBuilding(grid: HexGrid, from: HexCoord, to: HexCoord): boolean {
  const aLos = cellAt(grid, from).level + 1;
  const bLos = cellAt(grid, to).level + 1;
  const dTotal = hexDistance(from, to);
  if (dTotal === 0) return false;
  for (const h of interveningHexes(from, to)) {
    if (buildingTypeOf(cellAt(grid, h).terrain) === undefined) continue;
    const dA = hexDistance(from, h);
    const rayHeight = aLos + (bLos - aLos) * (dA / dTotal);
    if (terrainHeightAt(grid, h) > rayHeight) return true;
  }
  return false;
}

/** True when all LOS checks are clear: screening, water, elevation, and
 *  wrecks. `wrecks` (keyed by `"col,row"`) supplies the ejected-'Mech
 *  obstacles; one strictly between the endpoints blocks LOS entirely.
 *  Endpoints themselves cannot hold a wreck (the hex is unenterable). */
export function losClear(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  wrecks?: Readonly<Record<string, WreckState>>,
): boolean {
  if (losBlocked(losWoodsPointsBetween(grid, from, to))) return false;
  if (losBlockedByWater(grid, from, to)) return false;
  if (losBlockedByElevation(grid, from, to)) return false;
  if (losBlockedByWreck(from, to, wrecks)) return false;
  return true;
}

/** True when a wreck hex lies strictly between `from` and `to`: a level-2
 *  wreck blocks LOS entirely, independent of any elevation advantage. */
export function losBlockedByWreck(
  from: HexCoord,
  to: HexCoord,
  wrecks?: Readonly<Record<string, WreckState>>,
): boolean {
  if (wrecks === undefined) return false;
  for (const h of interveningHexes(from, to)) {
    if (wrecks[`${h.col},${h.row}`] !== undefined) return true;
  }
  return false;
}
