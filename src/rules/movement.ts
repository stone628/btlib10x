import { neighbor } from "../core/hex.js";
import { costToClimb, costToEnter, levelAt, MP_PER_FACING_CHANGE } from "../core/terrain.js";
import type { Facing, Hex, MoveMode, TerrainType } from "../core/types.js";
import { FACINGS, oppositeFacing, rotateFacing } from "../core/types.js";

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
export function canEndMoveInHex(occupantTeam: number | undefined, _moverTeam: number): boolean {
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

export function terrainAt(terrain: Readonly<Record<string, TerrainType>>, hex: Hex): TerrainType {
  return terrain[`${hex.col},${hex.row}`] ?? "clear";
}

export function hexKey(hex: Hex): string {
  return `${hex.col},${hex.row}`;
}

/** A single movement fragment in a reachability path. */
export type MoveFragment = "F" | "B" | "R" | "L";

/** One landing reachable from the start, with the fragment sequence that reaches it. */
export interface RevealedLanding {
  readonly hex: Hex;
  readonly facing: Facing;
  /** Movement fragments from the start (in order) that end at `hex` facing `facing`. */
  readonly path: readonly MoveFragment[];
}

export interface ReachabilityOptions {
  readonly mode: MoveMode;
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  readonly terrain: Readonly<Record<string, TerrainType>>;
  /** Per-hex ground elevation; missing entries are level 0. */
  readonly elevation: Readonly<Record<string, number>>;
  /** The mover's team. */
  readonly team: number;
  /** Team of the unit occupying a hex, or undefined when empty. */
  readonly occupantTeam: (hex: Hex) => number | undefined;
  /** Board width in engine columns (exclusive upper bound). */
  readonly width: number;
  /** Board height in engine rows (exclusive upper bound). */
  readonly height: number;
}

/**
 * Enumerate the hex/facing combinations a 'Mech can reach from `start` with the
 * given mode's MP budget, paired with a movement fragment sequence that
 * achieves each one.
 *
 * Fragment vocabulary: F = step forward, B = step backward, R/L = 1-hexside
 * turn (right/left). Ground (walk/run) charges 1 MP per R/L and 1+terrain per
 * F/B; run never moves backward. Jump charges 1 MP per F/B and treats R/L as
 * free reorientations (landing facing is chosen freely), so a side-neighbor
 * jump is expressed as `R...+F` (free turns) + `F` (the 1-MP step).
 *
 * The starting hex is included: the initial state has an empty path, and every
 * facing reachable from it by pure turns (free for jump, paid for ground)
 * appears as its own entry.
 */
export function reachableLandings(
  start: Hex,
  startFacing: Facing,
  options: ReachabilityOptions,
): RevealedLanding[] {
  const budget = maxMovePoints(options.mode, options.walking, options.running, options.jumping);
  if (budget <= 0 || options.mode === "standStill") return [];

  const jumping = options.mode === "jump";

  // Ground: R/L cost 1 MP. Jump: R/L are free reorientations before/after the
  // 1-MP jump step (landing facing is chosen freely on jump).
  const turnCost = jumping ? 0 : 1;
  const stepCost = (hex: Hex): number => {
    if (jumping) return 1;
    return costToEnter(terrainAt(options.terrain, hex));
  };
  const backwardAllowed = jumping || options.mode === "walk";

  interface State {
    hex: Hex;
    facing: Facing;
    cost: number;
    path: MoveFragment[];
  }
  const stateKey = (hex: Hex, facing: Facing): string => `${hexKey(hex)}|${facing}`;

  // Minimum MP to reach each (hex, facing) state, and the fragment path that
  // achieves it. On equal-cost ties, the first-discovered path is kept
  // (deterministic given the transition iteration order).
  const dist = new Map<string, number>();
  const bestPath = new Map<string, MoveFragment[]>();
  const queue: State[] = [];
  const enqueue = (hex: Hex, facing: Facing, cost: number, path: MoveFragment[]): void => {
    const key = stateKey(hex, facing);
    const known = dist.get(key);
    if (known !== undefined && known <= cost) return;
    dist.set(key, cost);
    bestPath.set(key, path);
    queue.push({ hex, facing, cost, path });
  };
  enqueue(start, startFacing, 0, []);

  const point = (a: Hex, b: Hex): boolean => a.col === b.col && a.row === b.row;
  const inBounds = (hex: Hex): boolean =>
    hex.col >= 0 && hex.col < options.width && hex.row >= 0 && hex.row < options.height;
  // Ground pass-through: friendly-occupied hexes are passable but never landable,
  // and a 'Mech cannot step more than one level up in a single hex (jump ignores
  // the climb cap and may change level freely).
  // Jump pass-through: any in-bounds hex; landing is restricted separately.
  const canEnter = (from: Hex, hex: Hex): boolean => {
    if (!inBounds(hex)) return false;
    if (jumping) return true;
    if (levelAt(options.elevation, hex) - levelAt(options.elevation, from) > 1) return false;
    const occ = options.occupantTeam(hex);
    return occ === undefined || occ === options.team;
  };
  const canLand = (hex: Hex): boolean =>
    inBounds(hex) && (point(hex, start) || options.occupantTeam(hex) === undefined);

  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    if (cur.cost > budget) continue;
    const key = stateKey(cur.hex, cur.facing);
    if ((dist.get(key) ?? Infinity) < cur.cost) continue;

    // Turn transitions: 1-hexside right/left. For jump these are free; for
    // ground each costs 1 MP.
    for (const [frag, delta] of [
      ["R", 1],
      ["L", -1],
    ] as const) {
      const newFacing = rotateFacing(cur.facing, delta);
      const c = cur.cost + turnCost;
      if (c <= budget) enqueue(cur.hex, newFacing, c, [...cur.path, frag]);
    }

    // Step transitions: F (forward) and, when allowed, B (backward). The
    // 'Mech keeps its facing after entering the hex. Ground moves also pay
    // +1 MP per level climbed (descent is free); jumps ignore elevation.
    const forward = neighbor(cur.hex, cur.facing);
    if (canEnter(cur.hex, forward)) {
      const climb = jumping
        ? 0
        : costToClimb(levelAt(options.elevation, cur.hex), levelAt(options.elevation, forward));
      const c = cur.cost + stepCost(forward) + climb;
      if (c <= budget) enqueue(forward, cur.facing, c, [...cur.path, "F"]);
    }
    if (backwardAllowed) {
      const backward = neighbor(cur.hex, oppositeFacing(cur.facing));
      if (canEnter(cur.hex, backward)) {
        const climb = jumping
          ? 0
          : costToClimb(levelAt(options.elevation, cur.hex), levelAt(options.elevation, backward));
        const c = cur.cost + stepCost(backward) + climb;
        if (c <= budget) enqueue(backward, cur.facing, c, [...cur.path, "B"]);
      }
    }
  }

  // Collect every (hex, facing) that is a valid landing within budget.
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

function parseHexKey(key: string): Hex {
  const [col, row] = key.split(",");
  return { col: Number(col), row: Number(row) };
}
