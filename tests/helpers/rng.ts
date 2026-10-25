import type { Rng } from "../../src/core/types";

/** Deterministic RNG fed an explicit queue of D6 results (asserts exact consumption). */
export function scriptedRng(...rolls: number[]): Rng & { remaining(): number } {
  let i = 0;
  return {
    remaining(): number {
      return rolls.length - i;
    },
    d6(): number {
      const v = rolls[i];
      if (v === undefined || v < 1 || v > 6) {
        throw new Error(`RNG script exhausted or invalid at call ${i}`);
      }
      i += 1;
      return v;
    },
    snapshot(): string {
      return i.toString();
    },
    load(snapshot: string): void {
      const v = parseInt(snapshot, 10);
      if (Number.isNaN(v) || v < 0) throw new Error("Invalid RNG snapshot");
      i = v;
    },
  };
}

/** Seedable PRNG (mulberry32) mapped to D6 faces, for long randomized battles.
 *  `a` is the PRNG state; snapshot/load round-trip it as a hex string so a
 *  saved battle resumes with identical rolls. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    d6(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(u * 6) + 1;
    },
    snapshot(): string {
      return a.toString(16);
    },
    load(snapshot: string): void {
      const v = parseInt(snapshot, 16);
      if (Number.isNaN(v)) throw new Error("Invalid RNG snapshot");
      a = v >>> 0;
    },
  };
}
