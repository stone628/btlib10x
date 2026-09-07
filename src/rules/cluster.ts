/**
 * Total Warfare Cluster Hits Table. Columns are projectile
 * counts (SRM-2, SRM-5, SRM-6, LRM-10/15, LRM-20); rows are the 2D6 roll.
 * Value = number of projectile that hit.
 */
export const CLUSTER_COLUMNS: readonly number[] = [2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 20, 30, 40];

const CLUSTER_TABLE: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 2, 3, 3, 3, 4, 5, 6, 10, 12],
  [1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 6, 10, 12],
  [1, 1, 2, 2, 3, 4, 4, 4, 5, 6, 9, 12, 18],
  [1, 2, 2, 3, 3, 4, 5, 6, 6, 9, 12, 18, 24],
  [1, 2, 3, 3, 4, 5, 5, 6, 8, 9, 12, 18, 24],
  [1, 2, 3, 3, 4, 5, 6, 6, 8, 9, 12, 18, 24],
  [2, 2, 3, 4, 4, 5, 6, 6, 8, 12, 15, 21, 28],
  [2, 2, 3, 4, 4, 5, 6, 8, 9, 12, 15, 21, 28],
  [2, 3, 3, 4, 5, 6, 7, 8, 10, 12, 16, 24, 32],
  [2, 3, 4, 5, 5, 7, 8, 9, 11, 14, 18, 27, 36],
  [2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 20, 30, 40],
];

function lookup(table: readonly (readonly number[])[], row: number, col: number): number {
  const r = table[row - 2];
  if (r === undefined) throw new Error(`Cluster roll out of range: ${row}`);
  const v = r[col];
  if (v === undefined) throw new Error(`Cluster column out of range: ${col}`);
  return v;
}

export function clusterHits(missiles: number, roll2d6: number): number {
  const col = CLUSTER_COLUMNS.indexOf(missiles);
  if (col < 0) throw new Error(`No cluster column for ${missiles} missiles`);
  return lookup(CLUSTER_TABLE, roll2d6, col);
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
