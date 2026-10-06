import type { Rng } from "./types";

/** Minimum 2D6 total (snake eyes). */
export const D2D6_MIN = 2;
/** Maximum 2D6 total (boxcars); also the auto-fail ceiling for TN checks. */
export const D2D6_MAX = 12;
/** Smallest avoid number a `roll >= avoid` check can never reach. */
export const D2D6_IMPOSSIBLE = D2D6_MAX + 1;

export function rollD6(rng: Rng): number {
  return rng.d6();
}

export function roll2D6(rng: Rng): number {
  return rng.d6() + rng.d6();
}

/** Uniform-ish int in [0, n) built from base-6 d6 digits via rejection sampling. */
export function diceIndex(rng: Rng, n: number): number {
  let digits = 1;
  let range = 6;
  while (range < n) {
    digits += 1;
    range *= 6;
  }
  const bound = Math.floor(range / n) * n;
  for (;;) {
    let v = 0;
    for (let i = 0; i < digits; i++) v = v * 6 + (rng.d6() - 1);
    if (v < bound) return v % n;
  }
}
