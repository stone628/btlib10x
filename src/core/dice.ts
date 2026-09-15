import type { Rng } from "./types.js";

/** Minimum 2D6 total (snake eyes). */
export const D2D6_MIN = 2;
/** Maximum 2D6 total (boxcars); also the auto-fail ceiling for TN checks. */
export const D2D6_MAX = 12;
/** Natural 2D6 roll that always fails a check. */
export const D2D6_FUMBLE = 2;
/** Natural 2D6 roll that always succeeds a check. */
export const D2D6_AUTO_SUCCESS = 12;

export function rollD6(rng: Rng): number {
  return rng.d6();
}

export function roll2D6(rng: Rng): number {
  return rng.d6() + rng.d6();
}
