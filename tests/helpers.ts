import type { Rng } from "../src/core/types.js";
import { runChunks } from "../web/cli.js";
import type { Chunk } from "../web/format.js";
import { boardLegendText, boardToText } from "../web/render.js";
import type { Session } from "../web/session.js";

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
  };
}

/** Seedable PRNG (mulberry32) mapped to D6 faces, for long randomized battles. */
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
  };
}

/** Flat text of one chunk (boards contribute legend + visible characters). */
export function chunkText(chunk: Chunk): string[] {
  if (chunk.kind === "board") {
    const lines: string[] = [boardLegendText("en")];
    lines.push(...boardToText(chunk.board.model).split("\n"));
    return lines;
  }
  if (chunk.kind === "sheet") {
    return sheetText(chunk.left, chunk.right);
  }
  return [...chunk.lines];
}

/** Flat rendering of a sheet: left column padded, right column beside it. */
function sheetText(left: readonly string[], right: readonly string[]): string[] {
  const leftMax = Math.max(0, ...left.map((l) => l.length));
  const rightMax = Math.max(0, ...right.map((l) => l.length));
  const height = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = (left[i] ?? "").padEnd(leftMax);
    const r = (right[i] ?? "").padEnd(rightMax);
    if (l.trim() === "" && r.trim() === "") continue;
    lines.push(r.length > 0 ? `${l}  ${r}` : l);
  }
  return lines;
}

/** Run one input line against the session; returns plain output lines. */
export function execute(session: Session, raw: string): string[] {
  return runChunks(session, raw).flatMap(chunkText);
}
