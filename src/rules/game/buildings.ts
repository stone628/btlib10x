import { sameHex } from "../../core/hex";
import { cellAt, setCell } from "../../core/terrain";
import { type HexCoord, hexKey } from "../../core/types";
import { applyBuildingDamage, collapseToRubble, isBuildingTerrain, isCollapsed } from "../building";
import { BUILDING_ABSORB_DIVISOR } from "./constants";
import { isUnitOnBoard } from "./queries";
import type { BattleState, BuildingDamageResult, GameEvent } from "./types";

/**
 * Apply damage (weapon fire, or a 'Mech entering or falling in the hex) to
 * the building occupying a hex, collapsing it to rubble when its structural
 * factor reaches zero. Pushes the `buildingDamaged` / `buildingCollapsed`
 * event into `sink` and returns the outcome, or `null` when the hex has no
 * building. Occupant collapse damage is applied by the caller (see
 * `resolveBuildingCollapse`).
 */
export function damageBuildingAt(
  state: BattleState,
  hex: HexCoord,
  damage: number,
  sink: GameEvent[],
): BuildingDamageResult | null {
  const key = hexKey(hex);
  const building = state.buildings[key];
  if (building === undefined) return null;
  const preCf = building.cf;
  const occupants = Object.values(state.units)
    .filter((u) => isUnitOnBoard(u) && sameHex(u.position, hex))
    .map((u) => u.id);
  state.buildings[key] = applyBuildingDamage(building, damage);
  const cf = state.buildings[key]!.cf;
  if (isCollapsed(state.buildings[key]!)) {
    const cell = cellAt(state, hex);
    const rubble = collapseToRubble(cell);
    if (rubble !== null) setCell(state, hex, rubble);
    // Remember what the rubble was: girder searches (TW p.146) only work
    // rubbled medium/heavy/hardened buildings.
    if (isBuildingTerrain(cell.terrain)) state.rubbleOrigin[key] = cell.terrain;
    delete state.buildings[key];
    sink.push({ kind: "buildingCollapsed", col: hex.col, row: hex.row });
    return { col: hex.col, row: hex.row, damage, preCf, cf: 0, collapsed: true, occupants };
  }
  sink.push({ kind: "buildingDamaged", col: hex.col, row: hex.row, damage, cf });
  return {
    col: hex.col,
    row: hex.row,
    damage,
    preCf,
    cf,
    collapsed: false,
    occupants: [],
  };
}

/**
 * Collapse damage total for a building hex (TW p. 176): base damage (CF at
 * the start of the phase / 10) plus base × levels above the unit, rounded
 * up at the end. Pure: exported for tests.
 */
export function collapseDamageTotal(preCf: number, levelsAbove: number): number {
  return Math.ceil((preCf / BUILDING_ABSORB_DIVISOR) * (1 + levelsAbove));
}
