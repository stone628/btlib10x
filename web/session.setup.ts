import {
  AMMO_POLICIES,
  type AmmoPolicy,
  buildUnitInit,
  createBattle,
  FACINGS,
  type Facing,
  type HexCoord,
  hexKey,
  isValidPilotHitMax,
  type MapDef,
  type MapNameHolder,
  mapDefFor,
  sameHex,
  type UnitInit,
  type UnitSkillRange,
} from "btlib10x";
import { buildLinesChunk, type Chunk } from "./chunk";
import { i18n } from "./i18n";
import { gunneryLabel, requireMechDef, strictInt } from "./misc";
import { startReplay } from "./replay";
import type { Session, SessionGameEvent } from "./session";
import { drive } from "./session";
import { ammoPolicyLabel } from "./session.common";

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
  // The board draws only the first 4 characters of an id.
  const clash = context.roster.find((u) => u.id.slice(0, 4) === id.slice(0, 4));
  if (clash !== undefined) throw new Error(i18n("err.idPrefixClash", { id, other: clash.id }));
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
  context.roster.push(buildUnitInit(id, m.model, team, position, facing));
  return { model: m.model, team };
}

export type UnitProp =
  | "model"
  | "team"
  | "col"
  | "row"
  | "facing"
  | "gunnery"
  | "piloting"
  | "pilotHitMax"
  | "ammoPolicy";

export const UNIT_PROPS: ReadonlyArray<UnitProp> = [
  "model",
  "team",
  "col",
  "row",
  "facing",
  "gunnery",
  "piloting",
  "pilotHitMax",
  "ammoPolicy",
];

export function parseUnitProp(word: string): UnitProp {
  const lower = word.toLowerCase();
  const prop = UNIT_PROPS.find((p) => p.toLowerCase() === lower);
  if (prop !== undefined) return prop;
  throw new Error(i18n("err.unknownProp", { name: word, list: UNIT_PROPS.join(", ") }));
}

/** Parse a CLI word into a policy. Case-insensitive; `least-first` and
 *  `leastfirst` are accepted for `leastFirst`. Null when unrecognized. */
function resolveAmmoPolicy(word: string): AmmoPolicy | null {
  const normalized = word.toLowerCase().replaceAll("-", "");
  return AMMO_POLICIES.find((p) => p.toLowerCase() === normalized) ?? null;
}

function isUnitSkillRange(n: number): n is UnitSkillRange {
  return n >= 0 && n <= 8;
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
      const m = requireMechDef(raw);
      unit.model = m.model;
      return { prop, value: m.model };
    }
    case "team": {
      const n = strictInt(raw) ?? Number.NaN;
      if (!Number.isInteger(n) || n < 0) throw new Error(i18n("err.badTeam"));
      unit.team = n;
      return { prop, value: String(n) };
    }
    case "col": {
      const n = strictInt(raw) ?? Number.NaN;
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
      const n = strictInt(raw) ?? Number.NaN;
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
      const n = strictInt(raw) ?? Number.NaN;
      if (!Number.isInteger(n) || !isUnitSkillRange(n)) throw new Error(i18n("err.badGunnery"));
      unit.gunnery = n;
      return { prop, value: String(n) };
    }
    case "piloting": {
      const n = strictInt(raw) ?? Number.NaN;
      if (!Number.isInteger(n) || !isUnitSkillRange(n)) throw new Error(i18n("err.badPiloting"));
      unit.piloting = n;
      return { prop, value: String(n) };
    }
    case "pilotHitMax": {
      const n = strictInt(raw) ?? Number.NaN;
      if (!isValidPilotHitMax(n)) throw new Error(i18n("err.badPilotHitMax"));
      unit.pilotHitMax = n;
      return { prop, value: String(n) };
    }
    case "ammoPolicy": {
      const policy = resolveAmmoPolicy(raw);
      if (policy === null) throw new Error(i18n("err.badAmmoPolicy"));
      unit.policy = { ammoPolicy: policy };
      return { prop, value: ammoPolicyLabel(policy) };
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
          piloting: u.piloting,
          hitMax: u.pilotHitMax,
          ammo: ammoPolicyLabel(u.policy.ammoPolicy),
          pos: hexKey(u.position),
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
  startReplay(s);
  return drive(s);
}
