import { sameHex } from "../../core/hex";
import { groundLevel } from "../../core/terrain";
import { type HexCoord, msgHex } from "../../core/types";
import { validatePhysicalAttack } from "../physical";
import { facingToward } from "./geometry";
import { isUnitRemoved, occupantAt } from "./queries";
import type { BattleState } from "./types";

/**
 * Why `unitId` cannot charge (walk / run) or DFA (jump) `targetId` from the
 * hex `stop` just before it, or null when the declaration is legal (TW
 * pp.148-150). The attacker is checked as if it already stood in `stop`
 * facing the target; `jumpMP` is the Jumping MP available for a DFA's
 * clearance. Shared by `executeMove` and the movement-candidate display.
 */
export function meleeDeclarationProblem(
  state: BattleState,
  unitId: string,
  stop: HexCoord,
  targetId: string,
  kind: "charge" | "dfa",
  jumpMP: number,
): string | null {
  const unit = state.units[unitId];
  const target = state.units[targetId];
  if (unit === undefined || target === undefined) return "unknown unit";
  const toward = facingToward(stop, target.position);
  if (toward === undefined) return "Charge / DFA target must be adjacent";
  if (kind === "dfa") {
    // The jump must clear the target hex: its level over the start hex plus
    // two for a standing target (TW p.149).
    const need =
      groundLevel(state, target.position) -
      groundLevel(state, unit.position) +
      (target.prone ? 0 : 2);
    if (jumpMP < need) return `A DFA at ${target.id} needs ${need} Jumping MP to clear it`;
  }
  // The attacker stays in `stop` for the rest of the turn.
  const squatter = occupantAt(state, stop, unitId);
  if (squatter !== undefined) return `${msgHex(stop)} is occupied by ${squatter.id}`;
  const others = Object.values(state.units).filter((u) => u.id !== unitId && !isUnitRemoved(u));
  // Standing in a hex another unit reserved is fine; moving into one is not.
  const reserved = sameHex(unit.position, stop)
    ? undefined
    : others.find((u) => u.meleeCharge !== null && sameHex(u.meleeCharge.hex, stop));
  if (reserved !== undefined) return `${msgHex(stop)} is reserved for ${reserved.id}'s charge`;
  if (others.some((u) => u.meleeCharge?.targetId === target.id)) {
    return `${target.id} is already the target of a charge or DFA this turn`;
  }
  if (others.some((u) => u.meleeCharge?.targetId === unitId)) {
    return `${unitId} is the target of a charge or DFA and cannot make one`;
  }
  const view: BattleState = {
    ...state,
    units: {
      ...state.units,
      [unitId]: { ...unit, position: stop, facing: toward, jumpedThisTurn: kind === "dfa" },
    },
  };
  const check = validatePhysicalAttack(view, unitId, { type: kind, targetId });
  return check.ok ? null : (check.reason ?? "illegal charge");
}
