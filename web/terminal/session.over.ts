import { createBattle, mapDefFor } from "btlib10x";
import { buildLinesChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import { i18n } from "./i18n";
import { startReplay } from "./replay";
import { createRng } from "./rng";
import { drive, type Session, type SessionGameEvent } from "./session";
import { battleSheet, sheetIdLine, sheetLinesShort } from "./session.common";

export interface SessionVictoryResult {
  readonly winnerTeam: number | null;
  readonly draw: boolean;
}

/** Set by `drive()` when `checkSessionVictory` reports a winner; cleared
 *  on `startBattle` / `rematch` so the next battle starts fresh. */
export interface OverContext {
  victory: SessionVictoryResult;
}

export function overRematch(s: Session): SessionGameEvent[] {
  if (s.state !== "over") throw new Error(i18n("err.rematchOnlyOver"));
  s.rng = createRng(s.setup.seed);
  s.move = null;
  s.attack = null;
  s.over = null;
  s.battle = createBattle(mapDefFor(s.setup), s.setup.roster);
  startReplay(s);
  return drive(s);
}

export function overStatusChunk(s: Session): Chunk {
  const battle = s.battle!;
  const lines: string[] = [];
  const teams = [...new Set(Object.values(battle.units).map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(i18n("setup.teamHeader", { team }));
    for (const [uid, unit] of Object.entries(battle.units).filter(([, u]) => u.team === team)) {
      const view = battleSheet(unit, uid);
      lines.push(`  ${sheetIdLine(view)}`);
      for (const line of sheetLinesShort(view)) lines.push(`    ${line}`);
    }
  }
  return buildLinesChunk(...lines);
}

export function victoryBannerChunk(s: Session): Chunk {
  if (s.state !== "over" || s.over === null) throw new Error(i18n("err.notOver"));
  const victory = s.over.victory;
  return buildLinesChunkWith(
    "banner",
    victory.draw ? i18n("banner.draw") : i18n("banner.win", { team: String(victory.winnerTeam) }),
  );
}
