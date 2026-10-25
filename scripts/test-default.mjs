import { execFileSync, spawnSync } from "node:child_process";

/**
 * Default `npm test`: run only the tests affected by the change at hand.
 *
 * - Uncommitted changes (staged, unstaged or untracked) → `vitest run --changed`.
 * - Clean tree → `vitest run --changed HEAD~1` (the files of the last commit).
 * - No parent commit, or a catalog data edit the import graph cannot see
 *   (`data/`, `docs/mtf/sw/json/`) → the full suite (`npm run test:all`).
 *
 * When the change touches `src/`, `npm run build` runs first so the session
 * tests that load the engine through `dist/` are not stale. Extra arguments are
 * passed through to vitest. See docs/GAME_REFACTORING.md step 9.
 */
const extra = process.argv.slice(2);

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const DATA_PREFIXES = ["data/", "docs/mtf/sw/json/"];

const porcelain = git("status", "--porcelain", "--untracked-files=all");
let mode;
let changed;
let vitestArgs;
if (porcelain === null) {
  mode = "full suite (not a git checkout)";
  changed = null;
} else if (porcelain.trim() !== "") {
  mode = "uncommitted changes";
  changed = porcelain
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").at(-1).replace(/^"|"$/g, ""));
  vitestArgs = ["--changed"];
} else if (git("rev-parse", "--verify", "--quiet", "HEAD~1") !== null) {
  mode = "last commit (HEAD~1...HEAD)";
  changed = (git("diff", "--name-only", "HEAD~1", "HEAD") ?? "").split("\n").filter(Boolean);
  vitestArgs = ["--changed", "HEAD~1"];
} else {
  mode = "full suite (no parent commit)";
  changed = null;
}

if (changed?.some((f) => DATA_PREFIXES.some((p) => f.startsWith(p)))) {
  mode = `full suite (catalog data changed; run \`npm run pack\` / \`npm run pack:sw\` first)`;
  vitestArgs = undefined;
}

const files = changed === null ? "" : `, ${changed.length} changed file(s)`;
console.log(`[npm test] mode: ${mode}${files}. Full suite: npm run test:all`);

if (changed === null || changed.some((f) => f.startsWith("src/"))) {
  console.log("[npm test] building dist/ first (npm run build)");
  run("npm", ["run", "build", "--silent"]);
}

run("npx", [
  "vitest",
  "run",
  ...(vitestArgs ? [...vitestArgs, "--passWithNoTests"] : []),
  ...extra,
]);
