import { isAdjacent, lineHexes } from "../core/hex";
import {
  blocksTargeting,
  cellAt,
  groundLevel,
  type HexGrid,
  screeningPoints,
  waterDepth,
} from "../core/terrain";
import {
  type HexCoord,
  hexKey,
  isWoodsTerrain,
  type TerrainType,
  type WreckState,
} from "../core/types";
import { buildingTypeOf } from "./building";

/**
 * Hexes along the center-to-center LOS, excluding the attacker's and target's
 * own hexes. A line running exactly along a hexside has two candidate hexes at
 * that step (TW p.99: the target's controller picks); `side` selects one of
 * them (see `lineHexes`), and `0` keeps the deterministic tie-break.
 */
export function interveningHexes(from: HexCoord, to: HexCoord, side: 0 | 1 | -1 = 0): HexCoord[] {
  return lineHexes(from, to, side);
}

/** Both tie-break sides of a hexside line. The defender chooses the side, so
 *  every LOS question is asked of both and the one worse for the attacker
 *  wins (LOS-03); off a tie the two sides are identical. */
export const LOS_SIDES = [1, -1] as const;

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

/** Posture of the two LOS endpoints (prone lowers a unit's LOS level). */
export interface ProneEnds {
  readonly from?: boolean;
  readonly to?: boolean;
  /** Explicit LOS level of an endpoint, replacing the ground-plus-height
   *  rule (a DFA'er is in the air until the physical phase, TW p.149). */
  readonly fromLevel?: number;
  readonly toLevel?: number;
}

/** A unit's LOS level: the level of the hex it stands on (the bed, for a
 *  'Mech in water) plus its height, 2 standing or 1 prone (TW p.99). */
export function unitLosLevel(grid: HexGrid, hex: HexCoord, prone?: boolean): number {
  return groundLevel(grid, hex) + (prone === true ? 1 : MECH_LOS_HEIGHT);
}

/**
 * TW p.100: terrain along the LOS intervenes if its level (top) is equal to
 * or higher than both units; or it is adjacent to the attacker and equal to
 * or higher than the attacker's level; or it is adjacent to the target and
 * equal to or higher than the target's level. No line is interpolated.
 */
function losIntervenes(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  h: HexCoord,
  top: number,
  prone?: ProneEnds,
): boolean {
  const aLos = prone?.fromLevel ?? unitLosLevel(grid, from, prone?.from);
  const bLos = prone?.toLevel ?? unitLosLevel(grid, to, prone?.to);
  return (
    (top >= aLos && top >= bLos) ||
    (isAdjacent(h, from) && top >= aLos) ||
    (isAdjacent(h, to) && top >= bLos)
  );
}

/** A woods hex counts toward the woods modifier and the blocking limit only
 *  when its canopy intervenes (TW p.100; LOS-02). */
function woodsIntervene(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  h: HexCoord,
  prone?: ProneEnds,
): boolean {
  const cell = cellAt(grid, h);
  return (
    isWoodsTerrain(cell.terrain) &&
    losIntervenes(grid, from, to, h, cell.level + WOODS_LOS_HEIGHT, prone)
  );
}

/** Sum of screening points among intervening woods between `from` and `to`
 *  (endpoints excluded). */
export function losWoodsPointsBetween(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  prone?: ProneEnds,
): number {
  let worst = 0;
  for (const side of LOS_SIDES)
    worst = Math.max(worst, woodsPointsOnSide(grid, from, to, side, prone));
  return worst;
}

function woodsPointsOnSide(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  side: 0 | 1 | -1,
  prone?: ProneEnds,
): number {
  let points = 0;
  for (const h of interveningHexes(from, to, side)) {
    if (woodsIntervene(grid, from, to, h, prone))
      points += screeningPoints(cellAt(grid, h).terrain);
  }
  return points;
}

/** Terrain types of intervening hexes between `from` and `to` (endpoints
 *  excluded); woods whose canopy does not intervene read as clear. */
export function interveningTerrains(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  prone?: ProneEnds,
): TerrainType[] {
  // The side with more screening is the one the defender picks.
  let best: 0 | 1 | -1 = LOS_SIDES[0];
  let bestPoints = -1;
  for (const side of LOS_SIDES) {
    const points = woodsPointsOnSide(grid, from, to, side, prone);
    if (points > bestPoints) {
      best = side;
      bestPoints = points;
    }
  }
  return interveningHexes(from, to, best).map((h) =>
    woodsIntervene(grid, from, to, h, prone) ? cellAt(grid, h).terrain : "clear",
  );
}

/**
 * Water depth 2+ blocks LOS: units cannot fire into or out of a water2/water3
 * hex. This is checked at the endpoint hexes (attacker or target position).
 */
export function losBlockedByWater(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  prone?: ProneEnds,
): boolean {
  const submerged = (hex: HexCoord, isProne: boolean | undefined): boolean => {
    const terrain = cellAt(grid, hex).terrain;
    // A prone 'Mech is completely submerged in depth 1+ water (TW p.102).
    return blocksTargeting(terrain) || (isProne === true && waterDepth(terrain) >= 1);
  };
  return submerged(from, prone?.from) || submerged(to, prone?.to);
}

/**
 * Standing feature heights above the underlying hex level (TW p. 100):
 *  - 'Mechs: 2 levels for LOS ray (TW p. 99 unit height).
 *  - woods: 2 levels (p. 100).
 *  - buildings: 2 levels default (p. 166–167 medium default).
 *  - clear / rough / rubble / pavement / water: 0 (no LOS height).
 */
export const MECH_LOS_HEIGHT = 2;
const BUILDING_LOS_HEIGHT = 2;
const WOODS_LOS_HEIGHT = 2;

/**
 * LOS elevation check (TW p.100): hills and buildings block when they
 * intervene by the three-clause test. A hex blocks at its own level; a
 * building rises 2 levels above it. Bipedal 'Mechs only — no multi-floor
 * interiors, no hull-down.
 */
export function losBlockedByElevation(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  prone?: ProneEnds,
): boolean {
  return LOS_SIDES.some((side) => elevationBlockedOnSide(grid, from, to, side, prone));
}

function elevationBlockedOnSide(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  side: 0 | 1 | -1,
  prone?: ProneEnds,
): boolean {
  for (const h of interveningHexes(from, to, side)) {
    const cell = cellAt(grid, h);
    if (losIntervenes(grid, from, to, h, cell.level, prone)) return true;
    if (
      buildingTypeOf(cell.terrain) !== undefined &&
      losIntervenes(grid, from, to, h, cell.level + BUILDING_LOS_HEIGHT, prone)
    ) {
      return true;
    }
  }
  return false;
}

/** True when an intervening building hex blocks LOS (TW p.100); the
 *  building hex a unit occupies is not intervening. */
export function losBlockedByBuilding(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  prone?: ProneEnds,
): boolean {
  return LOS_SIDES.some((side) => buildingBlockedOnSide(grid, from, to, side, prone));
}

function buildingBlockedOnSide(
  grid: HexGrid,
  from: HexCoord,
  to: HexCoord,
  side: 0 | 1 | -1,
  prone?: ProneEnds,
): boolean {
  for (const h of interveningHexes(from, to, side)) {
    const cell = cellAt(grid, h);
    if (buildingTypeOf(cell.terrain) === undefined) continue;
    if (losIntervenes(grid, from, to, h, cell.level + BUILDING_LOS_HEIGHT, prone)) return true;
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
  prone?: ProneEnds,
): boolean {
  if (losBlocked(losWoodsPointsBetween(grid, from, to, prone))) return false;
  if (losBlockedByWater(grid, from, to, prone)) return false;
  if (losBlockedByElevation(grid, from, to, prone)) return false;
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
  for (const side of LOS_SIDES) {
    for (const h of interveningHexes(from, to, side)) {
      const w = wrecks[hexKey(h)];
      if (w !== undefined && w.level >= 2) return true;
    }
  }
  return false;
}
