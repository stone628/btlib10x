import { requireUnit, type UnitState } from "btlib10x";
import type { Chunk } from "../../web/terminal/chunk";
import { runChunks } from "../../web/terminal/cli";
import { boardLegendText, boardToText, createBoardModel } from "../../web/terminal/renderer.text";
import type { Session } from "../../web/terminal/session";

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
