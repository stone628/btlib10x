import { bearingExact } from "../../src/core/hex";
import type { Facing, HexCoord, Location, TerrainHexDef, TerrainType } from "../../src/core/types";
import { mechDefFor, type ResolvedMechDef } from "../../src/data/mech.schema";
import type { AmmoBins } from "../../src/rules/ammo";
import { type CritState, emptyCritTable, setSlotDestroyed } from "../../src/rules/critical";
import { createBattle } from "../../src/rules/game/create";
import { isUnitRemoved } from "../../src/rules/game/queries";
import { startNextTurn } from "../../src/rules/game/turnOrder";
import type { BattleState, UnitInit, UnitState } from "../../src/rules/game/types";

/**
 * Build createBattle options from unit data (plus optional terrain), sizing the
 * board to cover every unit position and terrain hex (extent + 1, min 1).
 */
export function createTestBattle(
  terrain: readonly TerrainHexDef[] = [],
  units: readonly UnitInit[],
  critsDisabled: boolean,
  width?: number,
  height?: number,
): BattleState {
  let col = 0;
  let row = 0;
  const legends = new Set<TerrainType>();
  for (const u of units) {
    col = Math.max(col, u.position.col);
    row = Math.max(row, u.position.row);
  }
  for (const t of terrain) {
    col = Math.max(col, t.col);
    row = Math.max(row, t.row);
  }
  const state = createBattle(
    {
      name: "testhelper",
      width: width ?? col + 1,
      height: height ?? row + 1,
      terrain,
      legends: Array.from(legends),
    },
    units,
    { critsDisabled },
  );
  // end -> initiative (turn 1), as `advancePhase` would from the turn-0 placeholder
  state.actorQueue = null;
  startNextTurn(state);
  return state;
}

/** A pristine unit state (full armor and structure, no crit flags) around
 *  `ammoBins`, for the ammo helpers that read bin liveness. */
export function critState(def: ResolvedMechDef, ammoBins: AmmoBins): CritState {
  return {
    damage: {
      armor: { ...def.armor },
      armorRear: { ...def.armorRear },
      internalStructure: { ...def.internalStructure },
    },
    critSlotsDestroyed: emptyCritTable(def),
    ammoBins,
  };
}

/** Flag the first crit slot of weapon `weaponIndex`, as a critical hit on it
 *  would: the slot flags are the only record of a destroyed weapon. */
export function critWeapon(unit: UnitState, weaponIndex: number): void {
  const def = mechDefFor(unit);
  for (const loc of Object.keys(def.critSlots) as Location[]) {
    const i = def.critSlots[loc].findIndex(
      (s) => s.kind === "weapon" && s.weaponIndex === weaponIndex,
    );
    if (i >= 0) {
      setSlotDestroyed(unit.critSlotsDestroyed, loc, i);
      return;
    }
  }
  throw new Error(`critWeapon: no slot for weapon ${weaponIndex} on ${unit.id}`);
}

export function overrideAmmoBin(
  src: AmmoBins,
  location: Location,
  slotIndex: number,
  shots: number,
) {
  src[`${location}:${slotIndex}`] = shots;
}

export interface VictoryResult {
  readonly winnerTeam: number | null;
  readonly draw: boolean;
}

export function checkVictory(state: BattleState): VictoryResult {
  const aliveTeams = new Set(
    Object.values(state.units)
      .filter((u) => !isUnitRemoved(u))
      .map((u) => u.team),
  );
  if (aliveTeams.size <= 1) {
    return { winnerTeam: aliveTeams.values().next().value ?? null, draw: aliveTeams.size === 0 };
  }
  return { winnerTeam: null, draw: false };
}

/** Relative direction of `target` as seen from `origin` (compass sector), or
 *  null when identical. On an exact sector boundary one sector of the pair is
 *  returned deterministically; use `bearingExact` when the boundary matters. */
export function bearing(from: HexCoord, to: HexCoord): Facing | null {
  return bearingExact(from, to)?.facing ?? null;
}
