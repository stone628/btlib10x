import { hexDistance, neighbor } from "../core/hex";
import {
  cellAt,
  costToClimb,
  groundLevel,
  type HexGrid,
  hexEntryCost,
  MP_PER_FACING_CHANGE,
  MP_TO_ENTER_HEX,
  waterDepth,
} from "../core/terrain";
import type { Facing, HexCoord, MoveMode, TerrainType } from "../core/types";
import { FACINGS, hexKey, oppositeFacing, rotateFacing } from "../core/types";
import { isBuildingTerrain } from "./building";

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

/** TW p.49: MP charged by a minimum-movement step when the unit has no run budget left. */
export const MIN_MOVEMENT_MP = 1;

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

/** Occupant team reported for an abandoned hull: a neutral unit (TO:AR
 *  p.184) that any team may pass through but none may end movement on, and
 *  that charges and DFAs treat as a target. */
export const NEUTRAL_TEAM = 0;

/** Stacking: friendly units and neutral hulls may be passed through; enemies
 *  may not. */
export function canPassThroughHex(occupantTeam: number | undefined, moverTeam: number): boolean {
  return occupantTeam === undefined || occupantTeam === moverTeam || occupantTeam === NEUTRAL_TEAM;
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

/** MP spent along `path`: the sum of its steps' `baseMp`. */
export function pathMp(path: readonly MovePathStep[]): number {
  let n = 0;
  for (const step of path) n += step.baseMp;
  return n;
}

/** A single movement fragment in a reachability path. */
export type MoveFragment = "F" | "B" | "R" | "L" | "J" | "U";
export interface MovePathStep {
  readonly fragment: MoveFragment;
  /** MP this step costs, terrain and climbing included. */
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
  /** Set when `hex` holds an enemy: ending the path there declares a charge
   *  (walk / run) or DFA (jump). The unit stops in `stopsAt`, the hex before
   *  it, and never enters `hex` (TW pp.148-150, without displacement). */
  readonly melee?: { readonly kind: "charge" | "dfa"; readonly stopsAt: HexCoord };
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
  /** Team of the unit occupying a hex ({@link NEUTRAL_TEAM} for an abandoned
   *  hull), or undefined when empty. */
  readonly occupantTeam: (hex: HexCoord) => number | undefined;
  /** True when battlefield wreckage lies in `hex` (TO:AR p.155): ground
   *  entry pays its Rough surcharge (`wreckageMoveCost`). Omit for none. */
  readonly wreckageAt?: (hex: HexCoord) => boolean;
  /**
   * Enables charge / DFA landings: true when the mover could declare `kind`
   * against the enemy in `targetHex` while standing in `stop`. Omit to list
   * ordinary landings only.
   */
  readonly meleeOk?: (stop: HexCoord, targetHex: HexCoord, kind: "charge" | "dfa") => boolean;
  /**
   * TW p.50 standup free pick: "Once standing, it may face any direction at
   * no cost and continue moving under the declared mode." When true, the
   * search starts from all six facings at zero cost. The start hex gets an
   * empty-path landing for every facing; the convention `(start, f, [])`
   * with `f !== startFacing` is consumed by the web layer's `placeLanding`
   * via `moveFinalFacing`. A path that leaves the start hex in another
   * facing opens with 0-MP R/L steps for the free turn, so it replays from
   * `startFacing` and `executePostureMove` charges nothing for them.
   * Combine with `mode: "walk" | "run"` (the caller already deducted
   * `STAND_MP_COST` from the budget).
   */
  readonly standup?: boolean;
  /** Caps the MP a prone turn (`prone` with `mode: "walk"`) may spend on
   *  facing changes; pass 1 for a destroyed gyro, which allows one hexside
   *  per turn (TW p.125). Omit for the whole walking budget. */
  readonly proneTurnMax?: number;
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
 * reorientations (landing facing chosen freely). Jump needs >= 1 hex enter, so
 * jump mode never lists the starting hex (commit rejects zero-hex jumps too).
 *
 * Ground modes include the starting hex: the initial state has an empty path,
 * and every facing reachable from it by pure (paid) turns appears as its own
 * entry.
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
  // TW p.49 minimum movement: a unit with >= 1 MP may always enter the hex
  // directly ahead as its only expenditure, counted as running. It matters
  // only when the run budget cannot already afford that hex.
  const minMoveEligible =
    options.mode === "run" && !options.prone && !options.standup && options.walking >= 1;
  if ((budget <= 0 && !minMoveEligible) || options.mode === "standStill") return [];

  const jumping = options.mode === "jump";
  const proneTurn = options.prone && options.mode === "walk";
  const running = options.mode === "run";
  const { width, height } = options.grid;

  const turnCost = jumping ? 0 : 1;
  const turnLimit =
    proneTurn && options.proneTurnMax !== undefined
      ? Math.min(budget, options.proneTurnMax)
      : budget;
  const wreckageAt = (hex: HexCoord): boolean => options.wreckageAt?.(hex) ?? false;

  const stepCost = (from: HexCoord, to: HexCoord): number => {
    if (jumping) return JUMP_MP_PER_HEX;
    return (
      hexEntryCost(options.grid, to, wreckageAt(to)) +
      costToClimb(groundLevel(options.grid, from), groundLevel(options.grid, to))
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
  ): MovePathStep => {
    const cellTo = cellAt(options.grid, to);
    const fromGround = groundLevel(options.grid, from);
    const toGround = groundLevel(options.grid, to);
    const climbLevels = jumping ? 0 : toGround - fromGround;
    const climbCost = jumping ? 0 : costToClimb(fromGround, toGround);
    const terrain = cellTo.terrain;
    // Wreckage (TO:AR p.155) is Rough stacked on the terrain: its MP rides
    // in the terrain surcharge.
    const terrainSurcharge = jumping
      ? 0
      : hexEntryCost(options.grid, to, wreckageAt(to)) - MP_TO_ENTER_HEX;
    return {
      fragment,
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
  enqueue(start, startFacing, 0, []);
  if (options.standup) {
    // TW p.50 free pick: the other five start-hex facings cost nothing, and
    // the search expands from them too. Later MP-charged turn-path entries
    // (e.g. (start, ne, [R], 1)) hit the `known <= cost` guard above and
    // never overwrite the free picks.
    for (const f of FACINGS) {
      if (f !== startFacing) enqueue(start, f, 0, []);
    }
  }

  const point = (a: HexCoord, b: HexCoord): boolean => a.col === b.col && a.row === b.row;
  // A free pick keeps its empty path; a path that leaves it spells the free
  // turn out as 0-MP R/L steps, so it replays from `startFacing`.
  const leavingPath = (hex: HexCoord, facing: Facing, path: MovePathStep[]): MovePathStep[] => {
    if (!options.standup || path.length > 0 || facing === startFacing || !point(hex, start)) {
      return path;
    }
    const right = (FACINGS.indexOf(facing) - FACINGS.indexOf(startFacing) + 6) % 6;
    const fragment: MoveFragment = right <= 3 ? "R" : "L";
    const terrain = cellAt(options.grid, start).terrain;
    return Array.from({ length: right <= 3 ? right : 6 - right }, () => ({
      fragment,
      baseMp: 0,
      terrain,
      terrainSurcharge: 0,
      climbLevels: 0,
      climbCost: 0,
    }));
  };
  const inBounds = (hex: HexCoord): boolean =>
    hex.col >= 1 && hex.col <= width && hex.row >= 1 && hex.row <= height;

  const canEnter = (from: HexCoord, hex: HexCoord, backward: boolean, minMove = false): boolean => {
    if (!inBounds(hex)) return false;
    // TW p.53: a jump is impossible if its path crosses a level higher than
    // Jumping MP + the starting level.
    if (jumping)
      return cellAt(options.grid, hex).level <= budget + groundLevel(options.grid, start);
    // TW p.53: running units cannot enter water; Minimum Movement (p.57) can.
    if (running && !minMove && waterDepth(cellAt(options.grid, hex).terrain) > 0) return false;
    const delta = groundLevel(options.grid, hex) - groundLevel(options.grid, from);
    if (backward ? delta !== BACKWARD_LEVEL_CHANGE_MAX : Math.abs(delta) > FORWARD_LEVEL_CHANGE_MAX)
      return false;
    return canPassThroughHex(options.occupantTeam(hex), options.team);
  };
  // TW p.168: a 'Mech cannot use Jumping MP to enter a building hex, only
  // its roof, and roofs are not modeled.
  const jumpsIntoBuilding = (hex: HexCoord): boolean =>
    jumping && isBuildingTerrain(cellAt(options.grid, hex).terrain);
  const canLand = (hex: HexCoord): boolean =>
    inBounds(hex) &&
    (point(hex, start) || options.occupantTeam(hex) === undefined) &&
    !jumpsIntoBuilding(hex);

  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    if (cur.cost > budget) continue;
    const key = stateKey(cur.hex, cur.facing);
    if ((dist.get(key) ?? Infinity) < cur.cost) continue;
    const curPath = leavingPath(cur.hex, cur.facing, cur.path);

    for (const [frag, delta] of [
      ["R", 1],
      ["L", -1],
    ] as const) {
      const newFacing = rotateFacing(cur.facing, delta);
      const c = cur.cost + turnCost;
      if (c <= turnLimit) {
        const turnStep: MovePathStep = {
          fragment: frag,
          baseMp: turnCost,
          terrain: cellAt(options.grid, cur.hex).terrain,
          terrainSurcharge: 0,
          climbLevels: 0,
          climbCost: 0,
        };
        enqueue(cur.hex, newFacing, c, [...curPath, turnStep]);
      }
    }

    if (!proneTurn) {
      const forward = neighbor(cur.hex, cur.facing);
      if (canEnter(cur.hex, forward, false)) {
        const base = stepCost(cur.hex, forward);
        const c = cur.cost + base;
        if (c <= budget) {
          const step = makeStep(cur.hex, forward, stepFragment(), base);
          enqueue(forward, cur.facing, c, [...curPath, step]);
        }
      }
    }
    if (backwardAllowed && !proneTurn) {
      const backward = neighbor(cur.hex, oppositeFacing(cur.facing));
      if (canEnter(cur.hex, backward, true)) {
        const base = stepCost(cur.hex, backward);
        const c = cur.cost + base;
        if (c <= budget) {
          const step = makeStep(cur.hex, backward, "B", base);
          enqueue(backward, cur.facing, c, [...curPath, step]);
        }
      }
    }
  }

  const results: RevealedLanding[] = [];
  if (minMoveEligible) {
    const forward = neighbor(start, startFacing);
    if (canEnter(start, forward, false, true) && canLand(forward)) {
      const base = stepCost(start, forward);
      if (base > budget || waterDepth(cellAt(options.grid, forward).terrain) > 0) {
        const charged = Math.min(base, Math.max(budget, MIN_MOVEMENT_MP));
        const step = makeStep(start, forward, stepFragment(), charged);
        results.push({ hex: forward, facing: startFacing, path: [step] });
      }
    }
  }
  for (const [key, cost] of dist) {
    if (cost > budget) continue;
    const sep = key.lastIndexOf("|");
    const hexKeyStr = key.slice(0, sep);
    const hex = parseHexKey(hexKeyStr);
    if (!canLand(hex)) continue;
    // A jump follows a shortest path to its landing hex and must leave the
    // starting hex (TW p.53): in-place reorientation is not a jump.
    if (jumping && (hexDistance(start, hex) === 0 || cost !== hexDistance(start, hex))) continue;
    const facing = key.slice(sep + 1) as Facing;
    results.push({ hex, facing, path: bestPath.get(key) ?? [] });
  }

  if (options.meleeOk !== undefined && !proneTurn) {
    for (const [key, cost] of dist) {
      if (cost > budget) continue;
      const sep = key.lastIndexOf("|");
      const hex = parseHexKey(key.slice(0, sep));
      const facing = key.slice(sep + 1) as Facing;
      const path = leavingPath(hex, facing, bestPath.get(key) ?? []);
      // An enemy, or a neutral hull of either team (TO:AR p.184).
      const enemyAt = (h: HexCoord): boolean => {
        const occ = options.occupantTeam(h);
        return occ !== undefined && occ !== options.team;
      };
      if (jumping) {
        // DFA: the jump's last step flew into the enemy hex, so the stop is
        // the hex behind it along that step's facing.
        const last = path[path.length - 1];
        if (last === undefined || last.fragment !== "J") continue;
        if (!enemyAt(hex) || cost !== hexDistance(start, hex)) continue;
        const stop = neighbor(hex, oppositeFacing(facing));
        if (!jumpsIntoBuilding(stop) && options.meleeOk(stop, hex, "dfa")) {
          results.push({ hex, facing, path, melee: { kind: "dfa", stopsAt: stop } });
        }
        continue;
      }
      // Charge: step straight ahead from a reachable state into the enemy.
      const ahead = neighbor(hex, facing);
      if (!inBounds(ahead) || !enemyAt(ahead)) continue;
      if (running && waterDepth(cellAt(options.grid, ahead).terrain) > 0) continue;
      const delta = groundLevel(options.grid, ahead) - groundLevel(options.grid, hex);
      if (Math.abs(delta) > FORWARD_LEVEL_CHANGE_MAX) continue;
      const base = stepCost(hex, ahead);
      if (cost + base > budget) continue;
      if (!options.meleeOk(hex, ahead, "charge")) continue;
      const step = makeStep(hex, ahead, stepFragment(), base);
      results.push({
        hex: ahead,
        facing,
        path: [...path, step],
        melee: { kind: "charge", stopsAt: hex },
      });
    }
  }

  results.sort((a, b) => {
    if (a.hex.col !== b.hex.col) return a.hex.col - b.hex.col;
    if (a.hex.row !== b.hex.row) return a.hex.row - b.hex.row;
    return FACINGS.indexOf(a.facing) - FACINGS.indexOf(b.facing);
  });
  return results;
}

function parseHexKey(key: string): HexCoord {
  const [col, row] = key.split(",");
  return { col: Number(col), row: Number(row) };
}
