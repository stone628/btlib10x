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

/** 2D6 ways (over 36) to roll 2..12, index 0 = roll 2. */
const WAYS_2D6: readonly number[] = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];

/**
 * Expected projectiles hitting for a cluster weapon of `missiles` size: the
 * Cluster Hits Table (TW p. 116) averaged over the 2D6 distribution.
 */
export function expectedClusterHits(missiles: number): number {
  let sum = 0;
  for (let roll = 2; roll <= 12; roll++) sum += clusterHits(missiles, roll) * WAYS_2D6[roll - 2]!;
  return sum / 36;
}

/** HAG range-dependent cluster-roll modifier (TW p.136): +2 at short range,
 *  -2 at long range, applied to the 2D6 roll with results clamped to 2..12. */
export function modifiedClusterRoll(roll2d6: number, mod: number): number {
  return Math.min(12, Math.max(2, roll2d6 + mod));
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
