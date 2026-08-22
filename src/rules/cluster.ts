import { roll2D6 } from "../core/dice.js";
import type { Rng } from "../core/types.js";

/**
 * Beginner Box / CBT quick-start Cluster Hits Table. Columns are missile
 * counts (SRM-2, SRM-5, SRM-6, LRM-10/15, LRM-20); rows are the 2D6 roll.
 * Value = number of missiles that hit.
 */
export const CLUSTER_COLUMNS: readonly number[] = [2, 5, 6, 10, 15];

const MISSILE_TABLE: readonly (readonly number[])[] = [
  [1, 1, 2, 3, 5],
  [1, 2, 2, 3, 5],
  [1, 2, 3, 4, 6],
  [1, 3, 3, 6, 9],
  [1, 3, 4, 6, 9],
  [1, 3, 4, 6, 9],
  [2, 3, 4, 6, 9],
  [2, 4, 5, 8, 12],
  [2, 4, 5, 8, 12],
  [2, 5, 6, 10, 15],
  [2, 5, 6, 10, 15],
];

/**
 * Rapid-fire / multi-shot cluster columns (CBT quick-start p.29), used for
 * Ultra autocannons firing more than one shot; column index = shots fired - 2.
 */
export const SHOT_CLUSTER_COLUMNS: readonly number[] = [2, 3, 4];

const SHOTS_TABLE: readonly (readonly number[])[] = [
  [1, 1, 2],
  [1, 1, 2],
  [1, 1, 2],
  [1, 2, 2],
  [1, 2, 2],
  [1, 2, 3],
  [2, 2, 3],
  [2, 2, 3],
  [2, 3, 3],
  [2, 3, 4],
  [2, 3, 4],
];

function lookup(table: readonly (readonly number[])[], row: number, col: number): number {
  const r = table[row - 2];
  if (r === undefined) throw new Error(`Cluster roll out of range: ${row}`);
  const v = r[col];
  if (v === undefined) throw new Error(`Cluster column out of range: ${col}`);
  return v;
}

export function clusterHitsForMissiles(missiles: number, roll2d6: number): number {
  const col = CLUSTER_COLUMNS.indexOf(missiles);
  if (col < 0) throw new Error(`No cluster column for ${missiles} missiles`);
  return lookup(MISSILE_TABLE, roll2d6, col);
}

export function clusterHitsForShots(shots: number, roll2d6: number): number {
  const col = SHOT_CLUSTER_COLUMNS.indexOf(shots);
  if (col < 0) throw new Error(`No shot-cluster column for ${shots} shots`);
  return lookup(SHOTS_TABLE, roll2d6, col);
}

/** Split missiles into damage lots of `per` (LRM: one location per lot of 5). */
export function groupMissiles(total: number, per: number): number[] {
  const groups: number[] = [];
  let remaining = total;
  while (remaining >= per) {
    groups.push(per);
    remaining -= per;
  }
  if (remaining > 0) groups.push(remaining);
  return groups;
}
