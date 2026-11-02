declare const __BTLIB_VERSION__: string;

/**
 * Engine build stamp `YYMMDD-<git hash>`: the last commit touching the
 * engine's own files (`src/` and the catalog data, see `STAMP_PATHS` in
 * `scripts/build-stamp.mjs`), so web-only commits leave it unchanged.
 *
 * `scripts/build-web.mjs` and `scripts/standalone-web.mjs` replace the
 * `__BTLIB_VERSION__` placeholder with that literal stamp via esbuild
 * `define`, so the shipped web bundles always carry the string. The npm/tsc
 * build has no injection and falls back to "dev"; `typeof` guards the plain
 * identifier so the fallback never raises a ReferenceError.
 */
export const VERSION: string = typeof __BTLIB_VERSION__ === "string" ? __BTLIB_VERSION__ : "dev";
