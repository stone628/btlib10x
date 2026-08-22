import type { Rng } from "./types.js";

export function rollD6(rng: Rng): number {
  return rng.d6();
}

export function roll2D6(rng: Rng): number {
  return rng.d6() + rng.d6();
}
