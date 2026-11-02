import { execFileSync } from "node:child_process";

/** What each versioned component's stamp watches (docs: AGENTS.md "Versioning"). */
export const STAMP_PATHS = {
  // The catalog packs ship with the engine and change game results.
  engine: ["src", "data/mechs", "data/maps", "docs/mtf/sw/json"],
  terminal: ["web/terminal", "web/terminal.html", "web/terminal.css", "web/bt10x.css", "web/fonts"],
  instant: [
    "web/instant",
    "web/instant.html",
    "web/instant.css",
    "web/bt10x.css",
    "web/tui.js",
    "web/tui.css",
    "web/fonts",
  ],
};

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Build stamp `YYMMDD-<8-char git hash>` identifying a bundled commit.
 *
 * With no `paths`, the stamp names HEAD. With `paths`, it names the last
 * commit touching any of them, so a component's stamp moves only when its
 * own files change; uncommitted edits under them add a `-dirty` suffix.
 * The committer timestamp is rendered in UTC so the same commit stamps
 * identically on any machine. A shallow clone would silently report the
 * wrong commit for `paths`, so it fails the build instead. Outside git the
 * stamp falls back to the current UTC clock with a `nogit` hash so non-repo
 * checkouts/builds never hard-fail.
 */
export function buildStamp(paths = []) {
  let unixSeconds;
  let hash;
  let dirty = false;
  let inGit = true;
  try {
    git(["rev-parse", "--git-dir"]);
  } catch {
    inGit = false;
  }
  if (inGit) {
    if (paths.length > 0 && git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      throw new Error(
        "buildStamp: shallow clone, path stamps need full history (git fetch --unshallow)",
      );
    }
    const scope = paths.length > 0 ? ["--", ...paths] : [];
    const [ts, h] = git(["log", "-1", "--abbrev=8", "--format=%ct %h", ...scope])
      .trim()
      .split(/\s+/);
    unixSeconds = Number(ts);
    hash = h;
    if (paths.length > 0) dirty = git(["status", "--porcelain", "--", ...paths]).trim() !== "";
  }
  if (!inGit || !Number.isFinite(unixSeconds) || !hash) {
    unixSeconds = Math.floor(Date.now() / 1000);
    hash = "nogit";
    dirty = false;
  }

  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const yy = pad(d.getUTCFullYear() % 100);
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  return `${yy}${mm}${dd}-${hash}${dirty ? "-dirty" : ""}`;
}

/** The three component stamps, as `build-web.mjs` and `standalone-web.mjs` inject them. */
export function componentStamps() {
  return {
    engine: buildStamp(STAMP_PATHS.engine),
    terminal: buildStamp(STAMP_PATHS.terminal),
    instant: buildStamp(STAMP_PATHS.instant),
  };
}
