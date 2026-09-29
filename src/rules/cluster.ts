/**
 * Total Warfare Cluster Hits Table (p. 116). Columns are weapon sizes
 * (2-30 plus 40); rows are the 2D6 roll. Value = number of projectiles
 * that hit. Missiles and rapid-fire shots share this one table.
 */
export const CLUSTER_COLUMNS: readonly number[] = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 40,
];

export const CLUSTER_TABLE: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 9, 9, 10, 10, 12],
  [1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 9, 9, 10, 10, 12],
  [
    1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12,
    18,
  ],
  [
    1, 2, 2, 3, 3, 4, 4, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17,
    18, 18, 24,
  ],
  [
    1, 2, 2, 3, 4, 4, 5, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17,
    18, 18, 24,
  ],
  [
    1, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17,
    18, 18, 24,
  ],
  [
    2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17,
    18, 18, 24,
  ],
  [
    2, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 11, 12, 13, 14, 14, 15, 16, 17, 18, 19, 20, 21, 21, 22,
    23, 23, 24, 32,
  ],
  [
    2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 11, 12, 13, 14, 14, 15, 16, 17, 18, 19, 20, 21, 21, 22,
    23, 23, 24, 32,
  ],
  [
    2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    28, 29, 30, 40,
  ],
  [
    2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    28, 29, 30, 40,
  ],
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
