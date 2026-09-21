import { hexDistance, lineHexes } from "../core/hex.js";
import { blocksTargeting, cellAt, type HexGrid, screeningPoints } from "../core/terrain.js";
import { isWoodsTerrain, type HexCoord, type TerrainType, type WreckState } from "../core/types.js";
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

/** Intervening woods points that block line of sight. */
const WOODS_BLOCK_POINTS = 3;

/** Three or more points of intervening woods block line of sight. */
export function losBlocked(points: number): boolean {
  return points >= WOODS_BLOCK_POINTS;
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
 * Standing feature heights above the underlying hex level (TW p. 100):
 *  - 'Mechs: 2 levels for LOS ray (TW p. 99 unit height).
 *  - woods: 2 levels (p. 100).
 *  - buildings: 2 levels default (p. 166–167 medium default).
 *  - clear / rough / rubble / pavement / water: 0 (no LOS height).
 */
const MECH_LOS_HEIGHT = 2;
const BUILDING_LOS_HEIGHT = 2;
const WOODS_LOS_HEIGHT = 2;

function terrainHeightAt(grid: HexGrid, hex: HexCoord): number {
  const cell = cellAt(grid, hex);
  const t = cell.terrain;
  if (buildingTypeOf(t) !== undefined) return cell.level + BUILDING_LOS_HEIGHT;
  if (isWoodsTerrain(t)) return cell.level + WOODS_LOS_HEIGHT;
  return cell.level;
}

/**
 * LOS elevation check (TW p. 100): the ray runs between the two units' eye
 * levels (ground + MECH_LOS_HEIGHT) and an intervening feature blocks if its
 * top strictly exceeds the ray height at that hex's center. Woods are sized
 * equal to a standing 'Mech (2 levels) so the elevation ray never blocks on
 * woods alone — the screening-points rule (losBlocked) handles woods LOS.
 * Bipedal 'Mechs only — no multi-floor interiors, no hull-down, no partial
 * cover.
 */
export function losBlockedByElevation(grid: HexGrid, from: HexCoord, to: HexCoord): boolean {
  const aLos = cellAt(grid, from).level + MECH_LOS_HEIGHT;
  const bLos = cellAt(grid, to).level + MECH_LOS_HEIGHT;
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
 * hexes block LOS (TW p. 100) unless the eye-level ray clears their height;
 * the building hex a unit occupies is not intervening.
 */
export function losBlockedByBuilding(grid: HexGrid, from: HexCoord, to: HexCoord): boolean {
  const aLos = cellAt(grid, from).level + MECH_LOS_HEIGHT;
  const bLos = cellAt(grid, to).level + MECH_LOS_HEIGHT;
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
 *  obstacles; a level-2 wreck strictly between the endpoints blocks LOS
 *  entirely; a level-1 wreck does NOT block LOS (Tactical Operations).
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

/** True when a wreck hex lies strictly between `from` and `to`:
 *  - Tactical Operations: a level-1 wreck does NOT block LOS between two
 *    standing Level 2 'Mechs (standard ground 'Mechs). L1 cover is purely
 *    a to-hit modifier handled by `partialCoverMod` in `src/rules/game.ts`.
 *  - A level-2 wreck blocks LOS entirely, independent of any elevation
 *    advantage. Implementation note: "between" means the intervening hexes
 *    along the LOS ray (endpoints excluded — wrecks can't sit on either
 *    endpoint because the hex is unenterable). */
export function losBlockedByWreck(
  from: HexCoord,
  to: HexCoord,
  wrecks?: Readonly<Record<string, WreckState>>,
): boolean {
  if (wrecks === undefined) return false;
  for (const h of interveningHexes(from, to)) {
    const w = wrecks[`${h.col},${h.row}`];
    if (w !== undefined && w.level >= 2) return true;
  }
  return false;
}
