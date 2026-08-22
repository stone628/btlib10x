import type { Facing, Hex, MoveMode, TerrainType } from "../core/types.js";
import { oppositeFacing } from "../core/types.js";
import { neighbor } from "../core/hex.js";
import { costToEnter, MP_PER_FACING_CHANGE } from "../core/terrain.js";

export function maxMovePoints(
  mode: MoveMode,
  walking: number,
  running: number,
  jumping: number,
): number {
  switch (mode) {
    case "standStill":
      return 0;
    case "walk":
      return walking;
    case "run":
      return running;
    case "jump":
      return jumping;
  }
}

export function attackerMovementModifier(mode: MoveMode): number {
  switch (mode) {
    case "standStill":
      return 0;
    case "walk":
      return 1;
    case "run":
      return 2;
    case "jump":
      return 3;
  }
}

/** Quick-start target movement table (hexes entered), +1 extra when jumping. */
export function targetMovementModifier(hexesEntered: number, jumped: boolean): number {
  let mod: number;
  if (hexesEntered <= 2) mod = 0;
  else if (hexesEntered <= 4) mod = 1;
  else if (hexesEntered <= 6) mod = 2;
  else if (hexesEntered <= 9) mod = 3;
  else if (hexesEntered <= 17) mod = 4;
  else if (hexesEntered <= 24) mod = 5;
  else mod = 6;
  return mod + (jumped ? 1 : 0);
}

/**
 * Hexes counted for the target movement modifier: when a 'Mech reverses
 * direction, only the hexes moved after the last reversal count.
 */
export function hexesSinceLastReversal(moves: readonly ("forward" | "backward")[]): number {
  if (moves.length === 0) return 0;
  const last = moves[moves.length - 1]!;
  let count = 0;
  for (let i = moves.length - 1; i >= 0; i--) {
    if (moves[i] !== last) break;
    count++;
  }
  return count;
}

export function facingChangeCost(facings: number): number {
  return facings * MP_PER_FACING_CHANGE;
}

/** Stacking: friendly units may be passed through; enemies may not. */
export function canPassThroughHex(occupantTeam: number | undefined, moverTeam: number): boolean {
  return occupantTeam === undefined || occupantTeam === moverTeam;
}

/** Stacking: movement may never END in a hex held by any other 'Mech. */
export function canEndMoveInHex(occupantTeam: number | undefined, moverTeam: number): boolean {
  return occupantTeam === undefined;
}

/** True when moving from `from` into `to` would be a step backward relative to `facing`. */
export function isBackwardStep(from: Hex, to: Hex, facing: Facing): boolean {
  const backHex = neighbor(from, oppositeFacing(facing));
  return backHex.col === to.col && backHex.row === to.row;
}

/** True when `to` is the adjacent hex directly ahead of `facing`. */
export function isForwardStep(from: Hex, to: Hex, facing: Facing): boolean {
  const ahead = neighbor(from, facing);
  return ahead.col === to.col && ahead.row === to.row;
}

export function terrainAt(
  terrain: Readonly<Record<string, TerrainType>>,
  hex: Hex,
): TerrainType {
  return terrain[`${hex.col},${hex.row}`] ?? "clear";
}

export function hexKey(hex: Hex): string {
  return `${hex.col},${hex.row}`;
}
