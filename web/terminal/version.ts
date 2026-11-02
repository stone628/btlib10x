declare const __APP_VERSION__: string;
declare const __ENGINE_BUILT_WITH__: string;

/**
 * App build stamp `YYMMDD-<git hash>`: the last commit touching this app's
 * own files (`STAMP_PATHS.terminal` in `scripts/build-stamp.mjs`), injected by
 * esbuild `define`. Unbundled runs (tests, tsc) fall back to "dev"; `typeof`
 * guards the plain identifiers so the fallback never raises a ReferenceError.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** Engine stamp this bundle was built with, compared to the loaded engine's `VERSION`. */
export const ENGINE_BUILT_WITH: string =
  typeof __ENGINE_BUILT_WITH__ === "string" ? __ENGINE_BUILT_WITH__ : "dev";

/**
 * True when the loaded engine is not the one this app was built with,
 * usually a cached `btlib10x.js` beside a fresh app bundle. "dev" on either
 * side skips the check.
 */
export function engineMismatch(loaded: string): boolean {
  return loaded !== "dev" && ENGINE_BUILT_WITH !== "dev" && loaded !== ENGINE_BUILT_WITH;
}
