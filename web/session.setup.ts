import {
  createBattle,
  DEFAULT_GUNNERY,
  DEFAULT_PILOTING,
  FACINGS,
  type Facing,
  type HexCoord,
  type MapDef,
  type MapNameHolder,
  mapDefFor,
  sameHex,
  type UnitInit,
} from "btlib10x";
import { buildLinesChunk, type Chunk } from "./chunk";
import { i18n } from "./i18n";
import { lookupMech } from "./lookup";
import { gunneryLabel, hexCoordStr, requireMechDef } from "./misc";
import type { Session, SessionGameEvent } from "./session";
import { drive } from "./session";

export interface SetupContext extends MapNameHolder {
  seed: number;
  mapName: string | null;
  roster: UnitInit[];
}

export function setupSetMap(context: SetupContext, m: MapDef): void {
  if (context.mapName !== null) {
    for (const u of context.roster) {
      if (u.position.col > m.width) {
        throw new Error(
          i18n("err.unitOutOfBounds", {
            id: u.id,
            label: "col",
            value: u.position.col,
            max: m.width,
          }),
        );
      }
      if (u.position.row > m.height) {
        throw new Error(
          i18n("err.unitOutOfBounds", {
            id: u.id,
            label: "row",
            value: u.position.row,
            max: m.height,
          }),
        );
      }
    }
  }
  context.mapName = m.name;
}

export function setupPickTeam(roster: UnitInit[]): number {
  if (roster.length === 0) return 0;
  const counts: [number, number] = [0, 0];
  for (const u of roster) {
    if (u.team === 0) counts[0]++;
    else if (u.team === 1) counts[1]++;
  }
  return counts[0] <= counts[1] ? 0 : 1;
}

export interface AddUnitResult {
  model: string;
  team: number;
}

export function setupAddUnit(
  context: SetupContext,
  id: string,
  model: string,
  position: HexCoord,
  facing: Facing,
): AddUnitResult {
  const m = requireMechDef(model);
  if (context.roster.some((u) => u.id === id)) throw new Error(i18n("err.duplicateId", { id }));
  if (context.roster.some((u) => sameHex(u.position, position))) {
    throw new Error(i18n("err.hexOccupied", { col: position.col, row: position.row }));
  }
  const map = context.mapName != null ? mapDefFor(context) : undefined;
  if (map !== undefined) {
    if (position.col > map.width) {
      throw new Error(
        i18n("err.outOfBounds", { label: "col", value: position.col, max: map.width }),
      );
    }
    if (position.row > map.height) {
      throw new Error(
        i18n("err.outOfBounds", { label: "row", value: position.row, max: map.height }),
      );
    }
  }
  const team = setupPickTeam(context.roster);
  context.roster.push({
    id,
    model: m.model,
    team,
    gunnery: DEFAULT_GUNNERY,
    piloting: DEFAULT_PILOTING,
    position,
    facing,
  });
  return { model: m.model, team };
}

export type UnitProp = "model" | "team" | "col" | "row" | "facing" | "gunnery" | "piloting";

export const UNIT_PROPS: ReadonlyArray<UnitProp> = [
  "model",
  "team",
  "col",
  "row",
  "facing",
  "gunnery",
  "piloting",
];

export function parseUnitProp(word: string): UnitProp {
  const lower = word.toLowerCase();
  if ((UNIT_PROPS as readonly string[]).includes(lower)) return lower as UnitProp;
  throw new Error(i18n("err.unknownProp", { name: word, list: UNIT_PROPS.join(", ") }));
}

export function setupSetUnitProp(
  context: SetupContext,
  id: string,
  prop: UnitProp,
  raw: string,
): { prop: UnitProp; value: string } {
  const unit = context.roster.find((u) => u.id === id);
  if (unit === undefined) throw new Error(i18n("err.unknownUnitId", { id }));
  switch (prop) {
    case "model": {
      const m = lookupMech(raw);
      if (m === undefined) throw new Error(i18n("err.unknownModel", { model: raw }));
      unit.model = m.model;
      return { prop, value: m.model };
    }
    case "team": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(i18n("err.badTeam"));
      unit.team = n;
      return { prop, value: String(n) };
    }
    case "col": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(i18n("err.oneBased", { label: "col" }));
      const map = context.mapName != null ? mapDefFor(context) : undefined;
      if (map !== undefined && n > map.width)
        throw new Error(i18n("err.outOfBounds", { label: "col", value: n, max: map.width }));
      const newRow = unit.position.row;
      if (
        context.roster.some((u) => u.id !== id && u.position.col === n && u.position.row === newRow)
      )
        throw new Error(i18n("err.hexOccupied", { col: n, row: newRow }));
      unit.position = { col: n, row: newRow };
      return { prop, value: String(n) };
    }
    case "row": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(i18n("err.oneBased", { label: "row" }));
      const map = context.mapName != null ? mapDefFor(context) : undefined;
      if (map !== undefined && n > map.height)
        throw new Error(i18n("err.outOfBounds", { label: "row", value: n, max: map.height }));
      const newCol = unit.position.col;
      if (
        context.roster.some((u) => u.id !== id && u.position.col === newCol && u.position.row === n)
      )
        throw new Error(i18n("err.hexOccupied", { col: newCol, row: n }));
      unit.position = { col: newCol, row: n };
      return { prop, value: String(n) };
    }
    case "facing": {
      const f = FACINGS.find((x) => x === raw.toLowerCase());
      if (!f) throw new Error(i18n("err.faceArg", { facings: FACINGS.join("/") }));
      unit.facing = f;
      return { prop, value: f };
    }
    case "gunnery": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 7) throw new Error(i18n("err.badGunnery"));
      unit.gunnery = n;
      return { prop, value: String(n) };
    }
    case "piloting": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 7) throw new Error(i18n("err.badPiloting"));
      unit.piloting = n;
      return { prop, value: String(n) };
    }
  }
}

export function setupRemoveUnit(context: SetupContext, id: string): void {
  if (!context.roster.some((u) => u.id === id)) throw new Error(i18n("err.noSuchUnit", { id }));
  context.roster = context.roster.filter((u) => u.id !== id);
}

export function setupStatus(setup: SetupContext): Chunk {
  const lines: string[] = [
    i18n("setup.mapLabel", { name: setup.mapName ?? i18n("setup.mapNone") }),
  ];
  const teams = [...new Set(setup.roster.map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(i18n("setup.teamHeader", { team }));
    for (const u of setup.roster.filter((x) => x.team === team)) {
      const def = requireMechDef(u.model);
      lines.push(
        i18n("setup.unitLine", {
          id: u.id,
          model: u.model,
          name: def.name,
          gunnery: gunneryLabel(u.gunnery),
          pos: hexCoordStr(u.position),
          facing: u.facing,
        }),
      );
    }
  }
  if (teams.length === 0) lines.push(i18n("setup.noUnits"));
  return buildLinesChunk(...lines);
}

export function setupStartBattle(s: Session): SessionGameEvent[] {
  if (s.state !== "setup") throw new Error(i18n("err.alreadyStarted"));
  if (s.setup.roster.length < 2) throw new Error(i18n("err.needTwoUnits"));
  const teams = new Set(s.setup.roster.map((u) => u.team));
  if (teams.size < 2) throw new Error(i18n("err.needTwoTeams"));
  const map = mapDefFor(s.setup);
  s.move = null;
  s.attack = null;
  s.over = null;
  s.battle = createBattle(map, s.setup.roster);
  return drive(s);
}
