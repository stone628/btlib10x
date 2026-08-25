import type { Facing, Hex } from "./types.js";
import { FACINGS } from "./types.js";

/**
 * Flat-top hexes in column-offset storage with odd columns raised half a hex:
 * every hex's six sides face n / ne / se / s / sw / nw per the rulebook
 * diagrams (there is no east/west hexside). Diagonal deltas shift by column
 * parity as specified below.
 */
const EVEN_COL_DELTAS: Record<Facing, readonly [number, number]> = {
  n: [0, -1],
  s: [0, +1],
  ne: [+1, 0],
  se: [+1, +1],
  nw: [-1, 0],
  sw: [-1, +1],
};

const ODD_COL_DELTAS: Record<Facing, readonly [number, number]> = {
  n: [0, -1],
  s: [0, +1],
  ne: [+1, -1],
  se: [+1, 0],
  nw: [-1, -1],
  sw: [-1, 0],
};

export function neighbor(hex: Hex, facing: Facing): Hex {
  const deltas = hex.col % 2 === 0 ? EVEN_COL_DELTAS : ODD_COL_DELTAS;
  const pair = deltas[facing]!;
  return { col: hex.col + pair[0], row: hex.row + pair[1] };
}

export function neighbors(hex: Hex): Hex[] {
  return FACINGS.map((facing) => neighbor(hex, facing));
}

function offsetToCube(hex: Hex): { x: number; y: number; z: number } {
  const x = hex.col;
  const z = hex.row - (hex.col + (hex.col & 1)) / 2;
  const y = -x - z;
  return { x, y, z };
}

function cubeToOffset(x: number, _y: number, z: number): Hex {
  const col = x;
  const row = z + (col + (col & 1)) / 2;
  return { col, row };
}

export function hexDistance(a: Hex, b: Hex): number {
  const ca = offsetToCube(a);
  const cb = offsetToCube(b);
  return Math.max(Math.abs(ca.x - cb.x), Math.abs(ca.y - cb.y), Math.abs(ca.z - cb.z));
}

export function sameHex(a: Hex, b: Hex): boolean {
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
export function lineHexes(from: Hex, to: Hex): Hex[] {
  if (sameHex(from, to)) return [];
  const a = offsetToCube(from);
  const b = offsetToCube(to);
  const n = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  const result: Hex[] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    const pz = a.z + (b.z - a.z) * t;
    result.push(cubeRound(px, py, pz));
  }
  return result;
}

function cubeRound(px: number, py: number, pz: number): Hex {
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
export function bearing(from: Hex, to: Hex): Facing | null {
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
