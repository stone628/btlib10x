declare const __BTLIB_VERSION__: string;

/**
 * Build stamp `YYMMDDhhmmss-<git hash>` identifying the bundled commit.
 *
 * `scripts/build-web.mjs` and `scripts/standalone-web.mjs` replace the
 * `__BTLIB_VERSION__` placeholder with the literal stamp of HEAD via esbuild
 * `define`, so the shipped web bundles always carry the string. The npm/tsc
 * build has no injection and falls back to "dev"; `typeof` guards the plain
 * identifier so the fallback never raises a ReferenceError.
 */
export const VERSION: string = typeof __BTLIB_VERSION__ === "string" ? __BTLIB_VERSION__ : "dev";
