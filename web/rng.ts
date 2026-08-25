import type { Rng } from "../src/core/types.js";

/** mulberry32 PRNG reduced to the engine's `Rng` interface (d6 = 1..6). */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    d6(): number {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % 6) + 1;
    },
  };
}
