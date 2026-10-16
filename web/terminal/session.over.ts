import {
  createBattle,
  hexKey,
  type Location,
  mapDefFor,
  mechDefFor,
  type ResolvedMechDef,
  type SalvageEntry,
  type SalvageEquipmentName,
  type SalvageItem,
  salvageReport,
} from "btlib10x";
import {
  buildHeaderTableChunkFromColumns,
  buildHeaderTableChunkFromRows,
  buildLinesChunk,
  buildLinesChunkWith,
  type Chunk,
} from "./chunk";
import { compensatedLength, i18n, type MessageKey } from "./i18n";
import { PRN, SHORT_LOC } from "./misc";
import { startReplay } from "./replay";
import { createRng } from "./rng";
import { drive, type Session, type SessionGameEvent } from "./session";
import {
  armorDiagramSalvage,
  battleSheet,
  componentLabel,
  removalLabel,
  sheetIdLine,
  sheetLinesShort,
} from "./session.common";

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

const SALVAGE_LOCATIONS = Object.keys(SHORT_LOC) as Location[];

function salvageSummaryChunk(report: readonly SalvageEntry[]): Chunk {
  const header = [
    i18n("salvage.col.id"),
    i18n("salvage.col.model"),
    i18n("salvage.col.team"),
    i18n("salvage.col.kind"),
    i18n("salvage.col.reason"),
    i18n("salvage.col.hex"),
    i18n("salvage.col.posture"),
    i18n("salvage.col.wreckage"),
  ];
  const rows = report.map((e) => [
    e.unitId,
    e.model,
    String(e.team),
    i18n(e.kind === "hull" ? "salvage.kind.hull" : "salvage.kind.wreckage"),
    removalLabel(e.reason, e.destroyReason ?? "not"),
    hexKey(e.hex),
    PRN(e.prone),
    i18n(e.leftWreckage ? "salvage.yes" : "salvage.no"),
  ]);
  return buildHeaderTableChunkFromRows(header, rows);
}

/** `Medium Laser`, `Heat Sink x2`: one item with its device count. */
function salvageItemLabel(item: SalvageItem): string {
  const name =
    item.kind === "weapon" ? item.name : componentLabel(item.name as SalvageEquipmentName);
  return item.count > 1 ? `${name} x${item.count}` : name;
}

/** Widest a salvageables line grows before its list wraps. */
const SALVAGE_WRAP = 48;

/** `  LOC: a, b, c` lines, wrapping the list under its first item. */
function locationLines(where: string, labels: readonly string[]): string[] {
  const prefix = `  ${where}: `;
  const indent = " ".repeat(compensatedLength(prefix));
  const lines: string[] = [];
  let line = prefix;
  labels.forEach((label, i) => {
    const piece = i < labels.length - 1 ? `${label},` : label;
    const fresh = line === prefix || line === indent;
    if (!fresh && compensatedLength(`${line} ${piece}`) > SALVAGE_WRAP) {
      lines.push(line);
      line = `${indent}${piece}`;
    } else {
      line = fresh ? `${line}${piece}` : `${line} ${piece}`;
    }
  });
  lines.push(line);
  return lines;
}

/** A header line then one entry per location (in diagram order), or the
 *  header alone carrying "none". */
function groupedLines(
  headerKey: MessageKey,
  groups: ReadonlyMap<Location, { severed: boolean; labels: string[] }>,
): string[] {
  if (groups.size === 0) return [i18n(headerKey, { list: i18n("salvage.none") })];
  const lines = [i18n(headerKey, { list: "" }).trimEnd()];
  for (const loc of SALVAGE_LOCATIONS) {
    const group = groups.get(loc);
    if (group === undefined) continue;
    const where = group.severed
      ? i18n("salvage.severedLoc", { loc: SHORT_LOC[loc] })
      : SHORT_LOC[loc];
    lines.push(...locationLines(where, group.labels));
  }
  return lines;
}

/** Salvageables column: intact weapons and equipment, then stranded ammo,
 *  each grouped by location; a severed limb lying on the ground is marked. */
function salvageableLines(e: SalvageEntry): string[] {
  const items = new Map<Location, { severed: boolean; labels: string[] }>();
  for (const item of e.salvageable) {
    const group = items.get(item.location) ?? { severed: item.severed, labels: [] };
    group.labels.push(salvageItemLabel(item));
    items.set(item.location, group);
  }
  const ammo = new Map<Location, { severed: boolean; labels: string[] }>();
  for (const bin of e.strandedAmmo) {
    const loc = bin.binId.split(":")[0] as Location;
    const group = ammo.get(loc) ?? { severed: false, labels: [] };
    group.labels.push(i18n("salvage.ammoBin", { weapon: bin.weapon, shots: bin.shots }));
    ammo.set(loc, group);
  }
  return [...groupedLines("salvage.items", items), ...groupedLines("salvage.ammo", ammo)];
}

/** One entry's detail: a unit line, then the salvageables column beside
 *  the hull's armor and structure diagram (wreckage has no hull column). */
function salvageEntryChunks(e: SalvageEntry, def: ResolvedMechDef): Chunk[] {
  const header = buildLinesChunk(
    i18n("salvage.entryHeader", {
      id: e.unitId,
      model: e.model,
      team: e.team,
      kind: i18n(e.kind === "hull" ? "salvage.kind.hull" : "salvage.kind.wreckage"),
      reason: removalLabel(e.reason, e.destroyReason ?? "not"),
      hex: hexKey(e.hex),
      posture: PRN(e.prone),
    }),
  );
  const left = salvageableLines(e);
  if (e.kind !== "hull") {
    return [header, buildHeaderTableChunkFromColumns([i18n("salvage.col.salvageables")], [left])];
  }
  return [
    header,
    buildHeaderTableChunkFromColumns(
      [i18n("salvage.col.salvageables"), i18n("salvage.col.hull")],
      [left, armorDiagramSalvage(e.damage, def)],
    ),
  ];
}

/** `salvage [id]`: the engine's salvage report (hulls and destroyed frames)
 *  as a summary table plus one detail block per entry; over state only. */
export function salvageChunks(s: Session, id?: string): Chunk[] {
  if (s.state !== "over" || s.battle === null) throw new Error(i18n("err.notOver"));
  const report = salvageReport(s.battle);
  if (id !== undefined) {
    if (!Object.hasOwn(s.battle.units, id)) throw new Error(i18n("err.unknownUnitId", { id }));
    const entry = report.find((e) => e.unitId === id);
    if (entry === undefined) throw new Error(i18n("salvage.notSalvage", { id }));
    return salvageEntryChunks(entry, mechDefFor(s.battle.units[id]!));
  }
  if (report.length === 0) return [buildLinesChunk(i18n("salvage.empty"))];
  return [
    buildLinesChunk(i18n("salvage.title", { n: report.length })),
    salvageSummaryChunk(report),
  ];
}
