import { execFileSync } from "node:child_process";

/**
 * Build stamp `YYMMDD-<short-git-hash>` identifying the bundled commit.
 *
 * Derived from the HEAD commit itself: committer timestamp (rendered in UTC so
 * the same commit stamps identically on any machine) plus the abbreviated hash
 * from a single `git show` call. Falls back to the current UTC clock with a
 * `nogit` hash so non-repo checkouts/builds never hard-fail.
 */
export function buildStamp() {
  let unixSeconds;
  let hash;
  try {
    const [ts, h] = execFileSync("git", ["show", "-s", "--format=%ct %h", "HEAD"], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/);
    unixSeconds = Number(ts);
    hash = h;
  } catch {
    unixSeconds = Math.floor(Date.now() / 1000);
    hash = "nogit";
  }
  if (!Number.isFinite(unixSeconds) || hash === undefined) {
    unixSeconds = Math.floor(Date.now() / 1000);
    hash = "nogit";
  }

  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const yy = pad(d.getUTCFullYear() % 100);
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  return `${yy}${mm}${dd}-${hash}`;
}
