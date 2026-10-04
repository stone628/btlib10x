import { neighbor } from "../core/hex";
import {
  cellAt,
  costToClimb,
  costToEnter,
  type HexGrid,
  MP_PER_FACING_CHANGE,
} from "../core/terrain";
import type { Facing, HexCoord, MoveMode, TerrainType } from "../core/types";
import { FACINGS, hexKey, oppositeFacing, rotateFacing } from "../core/types";

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
    case "prone":
      return walking;
    case "run":
      return running;
    case "jump":
      return jumping;
  }
}

/** Attacker movement to-hit modifiers by locomotion (TW GATOR steps). */
const ATTACKER_MOVE_MOD_STAND = 0;
const ATTACKER_MOVE_MOD_WALK = 1;
const ATTACKER_MOVE_MOD_RUN = 2;
const ATTACKER_MOVE_MOD_JUMP = 3;

export function attackerMovementModifier(mode: MoveMode): number {
  switch (mode) {
    case "standStill":
      return ATTACKER_MOVE_MOD_STAND;
    case "walk":
    case "prone":
      return ATTACKER_MOVE_MOD_WALK;
    case "run":
      return ATTACKER_MOVE_MOD_RUN;
    case "jump":
      return ATTACKER_MOVE_MOD_JUMP;
  }
}

/** Target modifier when the target cannot move (shutdown / both legs gone). */
export const TARGET_IMMOBILE_MOD = -4;
/** Extra target modifier when the target jumped. */
export const TARGET_JUMP_BONUS = 1;
/** Hexes-entered ceilings (hexes moved, target modifier), ascending. */
const TARGET_MOVE_STEPS: ReadonlyArray<readonly [maxHexes: number, mod: number]> = [
  [2, 0],
  [4, 1],
  [6, 2],
  [9, 3],
  [17, 4],
  [24, 5],
];
/** Target modifier past the last step ceiling. */
const TARGET_MOVE_MOD_MAX = 6;

/** Max elevation change per forward hex (TW). */
export const FORWARD_LEVEL_CHANGE_MAX = 2;
/** Elevation change allowed per backward hex (none). */
export const BACKWARD_LEVEL_CHANGE_MAX = 0;

/**
 * Target movement table (hexes entered), +1 extra when jumping. An immobile
 * target (unit unable to move — e.g. a shutdown 'Mech or one with both legs
 * destroyed) gets a flat TARGET_IMMOBILE_MOD regardless of hexes entered or jump.
 */
export function targetMovementModifier(
  hexesEntered: number,
  jumped: boolean,
  immobile?: boolean,
): number {
  if (immobile) return TARGET_IMMOBILE_MOD;
  let mod = TARGET_MOVE_MOD_MAX;
  for (const [maxHexes, stepMod] of TARGET_MOVE_STEPS) {
    if (hexesEntered <= maxHexes) {
      mod = stepMod;
      break;
    }
  }
  return mod + (jumped ? TARGET_JUMP_BONUS : 0);
}

/** MP per jump hex entered (flat, ignores terrain and climb). */
export const JUMP_MP_PER_HEX = 1;

export function facingChangeCost(facings: number): number {
  return facings * MP_PER_FACING_CHANGE;
}

/** Stacking: friendly units may be passed through; enemies may not. */
export function canPassThroughHex(occupantTeam: number | undefined, moverTeam: number): boolean {
  return occupantTeam === undefined || occupantTeam === moverTeam;
}

/** Stacking: movement may never END in a hex held by any other 'Mech. */
export function canEndMoveInHex(occupantTeam: number | undefined, _moverTeam: number): boolean {
  return occupantTeam === undefined;
}

/** True when moving from `from` into `to` would be a step backward relative to `facing`. */
export function isBackwardStep(from: HexCoord, to: HexCoord, facing: Facing): boolean {
  const backHex = neighbor(from, oppositeFacing(facing));
  return backHex.col === to.col && backHex.row === to.row;
}

/** True when `to` is the adjacent hex directly ahead of `facing`. */
export function isForwardStep(from: HexCoord, to: HexCoord, facing: Facing): boolean {
  const ahead = neighbor(from, facing);
  return ahead.col === to.col && ahead.row === to.row;
}

/** A single movement fragment in a reachability path. */
export type MoveFragment = "F" | "B" | "R" | "L" | "J" | "U";
export interface MovePathStep {
  readonly fragment: MoveFragment;
  readonly totalMp: number;
  readonly baseMp: number;
  readonly terrain: TerrainType;
  readonly terrainSurcharge: number;
  readonly climbLevels: number;
  readonly climbCost: number;
}

/** One landing reachable from the start, with the fragment sequence that reaches it. */
export interface RevealedLanding {
  readonly hex: HexCoord;
  readonly facing: Facing;
  /** Movement fragments from the start (in order) that end at `hex` facing `facing`. */
  readonly path: readonly MovePathStep[];
}

export interface ReachabilityOptions {
  readonly mode: MoveMode;
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  readonly prone: boolean;
  readonly grid: HexGrid;
  /** The mover's team. */
  readonly team: number;
  /** Team of the unit occupying a hex, or undefined when empty. */
  readonly occupantTeam: (hex: HexCoord) => number | undefined;
  /** True when `hex` holds a wreck obstacle: never passable, never landable. */
  readonly wreckAt?: (hex: HexCoord) => boolean;
  /**
   * TW p.50 standup free pick: "Once standing, it may face any direction at
   * no cost and continue moving under the declared mode." When true, the
   * start hex gets a zero-cost empty-path landing for every facing — five
   * extras beyond the BFS's existing `(start, startFacing, [])` entry. The
   * convention `(start, f, [], 0)` with `f !== startFacing` is consumed by
   * the web layer's `placeLanding` via `moveFinalFacing`. Non-start hexes
   * remain BFS-generated from `startFacing` only, so their paths replay
   * cleanly. Combine with `mode: "walk" | "run" | "jump"` (the caller
   * already deducted `STAND_MP_COST` from the budget).
   */
  readonly standup?: boolean;
}

/**
 * Enumerate the hex/facing combinations a 'Mech can reach from `start` with the
 * given mode's MP budget, paired with a movement fragment sequence that
 * achieves each one.
 *
 * Fragment vocabulary:
 *   F = step forward (walk)
 *   B = step backward (walk or jump)
 *   R/L = 1-hexside turn (right/left)
 *   J = jump step forward (jump mode)
 *   U = run step (run mode)
 *
 * Ground (walk/run) charges 1 MP per R/L and 1+terrain+climb per F/B/U;
 * run never moves backward. Prone turn (walk+prone) allows only R/L turns
 * (1 MP each, multiple turns within budget), no hex enters. Jump charges
 * 1 MP per J step forward (backward steps stay B) and treats R/L as free
 * reorientations (landing facing chosen freely). Jump needs >= 1 hex enter;
 * zero-hex jump declarations are rejected at commit.
 *
 * The starting hex is included: the initial state has an empty path, and every
 * facing reachable from it by pure turns (free for jump, paid for ground)
 * appears as its own entry.
 */
export function reachableLandings(
  start: HexCoord,
  startFacing: Facing,
  options: ReachabilityOptions,
): RevealedLanding[] {
  const budget = maxMovePoints(options.mode, options.walking, options.running, options.jumping);
  // TW p.50 standup free pick: even at zero MP, the unit can stand and pick
  // any facing. Return the six start-hex free picks without running the BFS
  // when the budget can't afford any actual movement.
  if (options.standup && options.mode !== "standStill") {
    if (budget <= 0) {
      return FACINGS.map((f) => ({ hex: start, facing: f, path: [] }));
    }
  }
  if (budget <= 0 || options.mode === "standStill") return [];

  const jumping = options.mode === "jump";
  const proneTurn = options.prone && options.mode === "walk";
  const running = options.mode === "run";
  const { width, height } = options.grid;

  const turnCost = jumping ? 0 : 1;

  const stepCost = (from: HexCoord, to: HexCoord): number => {
    if (jumping) return JUMP_MP_PER_HEX;
    const cellTo = cellAt(options.grid, to);
    return (
      costToEnter(cellTo.terrain) + costToClimb(cellAt(options.grid, from).level, cellTo.level)
    );
  };

  const stepFragment = (): MoveFragment => {
    if (jumping) return "J";
    if (running) return "U";
    return "F";
  };

  const backwardAllowed = jumping || options.mode === "walk";

  interface State {
    hex: HexCoord;
    facing: Facing;
    cost: number;
    path: MovePathStep[];
  }
  const stateKey = (hex: HexCoord, facing: Facing): string => `${hexKey(hex)}|${facing}`;

  const dist = new Map<string, number>();
  const bestPath = new Map<string, MovePathStep[]>();
  const queue: State[] = [];

  const makeStep = (
    from: HexCoord,
    to: HexCoord,
    fragment: MoveFragment,
    baseMp: number,
    prevTotal: number,
  ): MovePathStep => {
    const cellTo = cellAt(options.grid, to);
    const cellFrom = cellAt(options.grid, from);
    const climbLevels = jumping ? 0 : cellTo.level - cellFrom.level;
    const climbCost = jumping ? 0 : costToClimb(cellFrom.level, cellTo.level);
    const terrain = cellTo.terrain;
    const terrainSurcharge = jumping ? 0 : costToEnter(terrain) - 1;
    return {
      fragment,
      totalMp: prevTotal + baseMp,
      baseMp,
      terrain,
      terrainSurcharge,
      climbLevels: Math.abs(climbLevels),
      climbCost,
    };
  };

  const enqueue = (hex: HexCoord, facing: Facing, cost: number, path: MovePathStep[]): void => {
    const key = stateKey(hex, facing);
    const known = dist.get(key);
    if (known !== undefined && known <= cost) return;
    dist.set(key, cost);
    bestPath.set(key, path);
    queue.push({ hex, facing, cost, path });
  };
  if (options.standup) {
    // TW p.50 free pick: seed the five non-startFacing start-hex facings at
    // zero cost before the BFS runs. Later MP-charged turn-path entries
    // (e.g. (start, ne, [R], 1)) hit the `known <= cost` guard above and
    // never overwrite the free picks. The `startFacing` entry is left to
    // the `enqueue(start, startFacing, 0, [])` below so the BFS can still
    // explore forward/backward from it.
    for (const f of FACINGS) {
      if (f === startFacing) continue;
      const key = stateKey(start, f);
      dist.set(key, 0);
      bestPath.set(key, []);
    }
  }
  enqueue(start, startFacing, 0, []);

  const point = (a: HexCoord, b: HexCoord): boolean => a.col === b.col && a.row === b.row;
  const inBounds = (hex: HexCoord): boolean =>
    hex.col >= 1 && hex.col <= width && hex.row >= 1 && hex.row <= height;

  const canEnter = (from: HexCoord, hex: HexCoord, backward: boolean): boolean => {
    if (!inBounds(hex)) return false;
    if (options.wreckAt?.(hex)) return false;
    if (jumping) return true;
    const delta = cellAt(options.grid, hex).level - cellAt(options.grid, from).level;
    if (backward ? delta !== BACKWARD_LEVEL_CHANGE_MAX : Math.abs(delta) > FORWARD_LEVEL_CHANGE_MAX)
      return false;
    const occ = options.occupantTeam(hex);
    return occ === undefined || occ === options.team;
  };
  const canLand = (hex: HexCoord): boolean =>
    inBounds(hex) &&
    (options.wreckAt === undefined || !options.wreckAt(hex)) &&
    (point(hex, start) || options.occupantTeam(hex) === undefined);

  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    if (cur.cost > budget) continue;
    const key = stateKey(cur.hex, cur.facing);
    if ((dist.get(key) ?? Infinity) < cur.cost) continue;

    for (const [frag, delta] of [
      ["R", 1],
      ["L", -1],
    ] as const) {
      const newFacing = rotateFacing(cur.facing, delta);
      const c = cur.cost + turnCost;
      if (c <= budget) {
        const turnStep: MovePathStep = {
          fragment: frag,
          totalMp: c,
          baseMp: turnCost,
          terrain: cellAt(options.grid, cur.hex).terrain,
          terrainSurcharge: 0,
          climbLevels: 0,
          climbCost: 0,
        };
        enqueue(cur.hex, newFacing, c, [...cur.path, turnStep]);
      }
    }

    if (!proneTurn) {
      const forward = neighbor(cur.hex, cur.facing);
      if (canEnter(cur.hex, forward, false)) {
        const base = stepCost(cur.hex, forward);
        const c = cur.cost + base;
        if (c <= budget) {
          const step = makeStep(cur.hex, forward, stepFragment(), base, cur.cost);
          enqueue(forward, cur.facing, c, [...cur.path, step]);
        }
      }
    }
    if (backwardAllowed && !proneTurn) {
      const backward = neighbor(cur.hex, oppositeFacing(cur.facing));
      if (canEnter(cur.hex, backward, true)) {
        const base = stepCost(cur.hex, backward);
        const c = cur.cost + base;
        if (c <= budget) {
          const step = makeStep(cur.hex, backward, "B", base, cur.cost);
          enqueue(backward, cur.facing, c, [...cur.path, step]);
        }
      }
    }
  }

  const results: RevealedLanding[] = [];
  for (const [key, cost] of dist) {
    if (cost > budget) continue;
    const sep = key.lastIndexOf("|");
    const hexKeyStr = key.slice(0, sep);
    const hex = parseHexKey(hexKeyStr);
    if (!canLand(hex)) continue;
    const facing = key.slice(sep + 1) as Facing;
    results.push({ hex, facing, path: bestPath.get(key) ?? [] });
  }

  results.sort((a, b) => {
    const ka = hexKey(a.hex);
    const kb = hexKey(b.hex);
    if (ka !== kb) return ka.localeCompare(kb);
    return FACINGS.indexOf(a.facing) - FACINGS.indexOf(b.facing);
  });
  return results;
}

function parseHexKey(key: string): HexCoord {
  const [col, row] = key.split(",");
  return { col: Number(col), row: Number(row) };
}
