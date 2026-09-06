import type { Rng } from "../src/core/types.js";
import type { CreateBattleOptions, TerrainHexDef, UnitInit } from "../src/rules/game.js";
import { runChunks } from "../web/cli.js";
import type { Chunk } from "../web/format.js";
import { boardLegendText, boardToText, createBoardModel } from "../web/renderer.text.js";
import type { Session } from "../web/session.js";

/**
 * Build createBattle options from unit data (plus optional terrain), sizing the
 * board to cover every unit position and terrain hex (extent + 1, min 1).
 */
export function makeBattleOptions(
  units: readonly UnitInit[],
  critsDisabled: boolean,
  terrain: readonly TerrainHexDef[] = [],
): CreateBattleOptions {
  let col = 0;
  let row = 0;
  for (const u of units) {
    col = Math.max(col, u.position.col);
    row = Math.max(row, u.position.row);
  }
  for (const t of terrain) {
    col = Math.max(col, t.col);
    row = Math.max(row, t.row);
  }
  return { terrain, width: col + 1, height: row + 1, critsDisabled };
}

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
    const lines: string[] = [boardLegendText(chunk.info.map, "en")];
    lines.push(...boardToText(createBoardModel(chunk.info)).split("\n"));
    return lines;
  }
  if (chunk.kind === "columns") {
    return columnsText(chunk.columns);
  }
  if (chunk.kind === "collapsible") {
    return [chunk.summary, ...chunk.chunks.flatMap(chunkText)];
  }
  return [...chunk.lines];
}

/** Flat rendering of side-by-side columns: each padded to its own width. */
function columnsText(columns: readonly (readonly string[])[]): string[] {
  const widths = columns.map((c) => Math.max(0, ...c.map((l) => l.length)));
  const height = Math.max(0, ...columns.map((c) => c.length));
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    const row = columns.map((c, idx) => (c[i] ?? "").padEnd(widths[idx] ?? 0));
    if (row.every((l) => l.trim() === "")) continue;
    lines.push(row.join("  "));
  }
  return lines;
}

/** Run one input line against the session; returns plain output lines. */
export function execute(session: Session, raw: string): string[] {
  return runChunks(session, raw).flatMap(chunkText);
}
