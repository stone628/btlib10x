import type { Facing, HexCoord } from "./types.js";
import { FACINGS } from "./types.js";

/**
 * Flat-top hexes in column-offset storage. Even columns sit half a hex lower
 * than odd columns (odd columns are raised), matching the renderer's
 * `col % 2 === 1 ? 0 : STAGGER` stagger. The board is 1-based, so (1, 1) is
 * the top-left hex and the SE neighbor of (1, 1) is (2, 1). Every hex's six
 * sides face n / ne / se / s / sw / nw per the rulebook diagrams (there is no
 * east/west hexside). The cube deltas below are parity-independent; the
 * offset (col, row) deltas flip with column parity, but cube space collapses
 * that into a single mapping.
 */
const FACING_CUBE_DELTAS: Record<Facing, readonly [number, number, number]> = {
  n: [0, +1, -1],
  s: [0, -1, +1],
  ne: [+1, 0, -1],
  se: [+1, -1, 0],
  sw: [-1, 0, +1],
  nw: [-1, +1, 0],
};

export function neighbor(hex: HexCoord, facing: Facing): HexCoord {
  const cube = offsetToCube(hex);
  const [dx, dy, dz] = FACING_CUBE_DELTAS[facing];
  return cubeToOffset(cube.x + dx, cube.y + dy, cube.z + dz);
}

export function neighbors(hex: HexCoord): HexCoord[] {
  return FACINGS.map((facing) => neighbor(hex, facing));
}

/** True when `a` and `b` are the same or one of the six adjacent hexes. */
export function isAdjacent(a: HexCoord, b: HexCoord): boolean {
  if (sameHex(a, b)) return true;
  for (const f of FACINGS) {
    if (sameHex(neighbor(a, f), b)) return true;
  }
  return false;
}

function offsetToCube(hex: HexCoord): { x: number; y: number; z: number } {
  const x = hex.col;
  const z = hex.row - (hex.col + (hex.col & 1)) / 2;
  const y = -x - z;
  return { x, y, z };
}

function cubeToOffset(x: number, _y: number, z: number): HexCoord {
  const col = x;
  const row = z + (col + (col & 1)) / 2;
  return { col, row };
}

export function hexDistance(a: HexCoord, b: HexCoord): number {
  const ca = offsetToCube(a);
  const cb = offsetToCube(b);
  return Math.max(Math.abs(ca.x - cb.x), Math.abs(ca.y - cb.y), Math.abs(ca.z - cb.z));
}

export function sameHex(a: HexCoord, b: HexCoord): boolean {
  return a.col === b.col && a.row === b.row;
}

/**
 * All hexes strictly between `from` and `to` along a straight center-to-center
 * line, ordered from `from` toward `to` (endpoints excluded).
 *
 * Uses cube-coordinate lerp with rounding; ties are broken deterministically by
 * preferring the hex closer to the straight line (lowest cube-distance error),
 * then by lower x, y, z so results are reproducible.
 */
export function lineHexes(from: HexCoord, to: HexCoord): HexCoord[] {
  if (sameHex(from, to)) return [];
  const a = offsetToCube(from);
  const b = offsetToCube(to);
  const n = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  const result: HexCoord[] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const pz = a.z + (b.z - a.z) * t;
    result.push(cubeRound(px, py, pz));
  }
  return result;
}

function cubeRound(px: number, py: number, pz: number): HexCoord {
  let rx = Math.round(px);
  let ry = Math.round(py);
  let rz = Math.round(pz);
  const dx = Math.abs(rx - px);
  const dy = Math.abs(ry - py);
  const dz = Math.abs(rz - pz);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return cubeToOffset(rx, ry, rz);
}

/** Relative direction of `target` as seen from `origin` (compass sector), or null when identical. */
export function bearing(from: HexCoord, to: HexCoord): Facing | null {
  if (sameHex(from, to)) return null;
  for (const f of FACINGS) {
    if (sameHex(neighbor(from, f), to)) return f;
  }
  // Not adjacent: approximate a compass heading. Cube +x points east and
  // cube +z points south (rows run top-to-bottom), so the northward
  // component is -dz.
  const a = offsetToCube(from);
  const b = offsetToCube(to);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const compassDeg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  const sector = Math.floor(((compassDeg + 30) % 360) / 60);
  return FACINGS[sector]!;
}
