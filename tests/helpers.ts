import type { Facing, HexCoord, Location, Rng, TerrainType } from "../src/core/types";
import { type AmmoBins, bearingExact, createBattle, isUnitRemoved } from "../src/index";
import type { BattleState, TerrainHexDef, UnitInit, UnitState } from "../src/rules/game";
import { advancePhase, requireUnit } from "../src/rules/game";
import type { Chunk } from "../web/chunk";
import { runChunks } from "../web/cli";
import { boardLegendText, boardToText, createBoardModel } from "../web/renderer.text";
import type { Session } from "../web/session";

/**
 * Build createBattle options from unit data (plus optional terrain), sizing the
 * board to cover every unit position and terrain hex (extent + 1, min 1).
 */
export function createTestBattle(
  terrain: readonly TerrainHexDef[] = [],
  units: readonly UnitInit[],
  critsDisabled: boolean,
  width?: number,
  height?: number,
): BattleState {
  let col = 0;
  let row = 0;
  const legends = new Set<TerrainType>();
  for (const u of units) {
    col = Math.max(col, u.position.col);
    row = Math.max(row, u.position.row);
  }
  for (const t of terrain) {
    col = Math.max(col, t.col);
    row = Math.max(row, t.row);
  }
  const state = createBattle(
    {
      name: "testhelper",
      width: width ?? col + 1,
      height: height ?? row + 1,
      terrain,
      legends: Array.from(legends),
    },
    units,
    { critsDisabled },
  );
  advancePhase(state, []); // end -> initiative (turn 1)
  return state;
}

export function disableCritical(s: Session) {
  s.battle!.critsDisabled = true;
}

export function currentActor(s: Session): UnitState | null {
  if (s.state !== "battle" || !s.battle) return null;
  let id: string | null = null;
  switch (s.battle.phase) {
    case "movement":
      id = s.move?.actorId ?? null;
      break;
    case "attack":
      id = s.attack?.actorId ?? null;
      break;
  }
  return id === null ? null : requireUnit(s.battle, id);
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
    snapshot(): string {
      return i.toString();
    },
    load(snapshot: string): void {
      const v = parseInt(snapshot, 10);
      if (Number.isNaN(v) || v < 0) throw new Error("Invalid RNG snapshot");
      i = v;
    },
  };
}

/** Seedable PRNG (mulberry32) mapped to D6 faces, for long randomized battles.
 *  `a` is the PRNG state; snapshot/load round-trip it as a hex string so a
 *  saved battle resumes with identical rolls. */
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
    snapshot(): string {
      return a.toString(16);
    },
    load(snapshot: string): void {
      const v = parseInt(snapshot, 16);
      if (Number.isNaN(v)) throw new Error("Invalid RNG snapshot");
      a = v >>> 0;
    },
  };
}

/** Flat text of one chunk (boards contribute legend + visible characters). */
export function chunkText(chunk: Chunk): string[] {
  if (chunk.kind === "board") {
    const lines: string[] = boardLegendText(chunk.info.map);
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
  const chunks = runChunks(session, raw);
  return chunks.flatMap(chunkText);
}

export function overrideAmmoBin(
  src: AmmoBins,
  location: Location,
  slotIndex: number,
  shots: number,
) {
  src[`${location}:${slotIndex}`] = shots;
}

export interface VictoryResult {
  readonly winnerTeam: number | null;
  readonly draw: boolean;
}

export function checkVictory(state: BattleState): VictoryResult {
  const aliveTeams = new Set(
    Object.values(state.units)
      .filter((u) => !isUnitRemoved(u))
      .map((u) => u.team),
  );
  if (aliveTeams.size <= 1) {
    return { winnerTeam: aliveTeams.values().next().value ?? null, draw: aliveTeams.size === 0 };
  }
  return { winnerTeam: null, draw: false };
}

/** Relative direction of `target` as seen from `origin` (compass sector), or
 *  null when identical. On an exact sector boundary one sector of the pair is
 *  returned deterministically; use `bearingExact` when the boundary matters. */
export function bearing(from: HexCoord, to: HexCoord): Facing | null {
  return bearingExact(from, to)?.facing ?? null;
}
