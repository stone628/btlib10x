import {
  CLUSTER_COLUMNS,
  CLUSTER_TABLE,
  HIT_LOCATION_TABLE,
  LEFT_SIDE_TABLE,
  RIGHT_SIDE_TABLE,
} from "btlib10x";
import {
  buildHeaderTableChunkFromColumns,
  buildHeaderTableChunkFromRows,
  buildLinesChunk,
  type Chunk,
} from "./format.js";
import type { LocaleId } from "./i18n/index.js";
import { i18n } from "./i18n/index.js";

const CLUSTER_SIZES = CLUSTER_COLUMNS;

function critResult(locale: LocaleId, roll: number): string {
  if (roll <= 7) return i18n(locale, "res.critNone");
  if (roll <= 9) return i18n(locale, "res.critOne");
  if (roll <= 11) return i18n(locale, "res.critTwo");
  return i18n(locale, "res.critThree");
}

export function renderClusterTable(locale: LocaleId): Chunk[] {
  const header = [
    i18n(locale, "table.cluster.col.roll"),
    ...CLUSTER_SIZES.map((s) => i18n(locale, "table.cluster.col.size", { size: String(s) })),
  ];
  const rows: string[][] = [];
  for (let roll = 2; roll <= 12; roll++) {
    const row = [String(roll)];
    for (let col = 0; col < CLUSTER_SIZES.length; col++) {
      const val = CLUSTER_TABLE[roll - 2]?.[col];
      row.push(val !== undefined ? String(val) : "—");
    }
    rows.push(row);
  }
  return [
    buildLinesChunk([i18n(locale, "table.cluster.title")]),
    buildHeaderTableChunkFromRows(header, rows),
  ];
}

export function renderHitLocationTables(locale: LocaleId): Chunk[] {
  const dice: string[] = [];
  const fr: string[] = [];
  const ls: string[] = [];
  const rs: string[] = [];

  for (let roll = 2; roll <= 12; roll++) {
    dice.push(String(roll));
    fr.push(HIT_LOCATION_TABLE[roll] ?? "-");
    ls.push(LEFT_SIDE_TABLE[roll] ?? "-");
    rs.push(RIGHT_SIDE_TABLE[roll] ?? "-");
  }

  return [
    buildLinesChunk([i18n(locale, "table.hitloc.title")]),
    buildHeaderTableChunkFromColumns(
      [
        i18n(locale, "table.hitloc.col.roll"),
        i18n(locale, "table.hitloc.frontRear"),
        i18n(locale, "table.hitloc.leftSide"),
        i18n(locale, "table.hitloc.rightSide"),
      ],
      [dice, fr, ls, rs],
    ),
  ];
}

export function renderCriticalTable(locale: LocaleId): Chunk[] {
  const header = [i18n(locale, "table.crit.col.roll"), i18n(locale, "table.crit.col.result")];
  const rows: string[][] = [];
  for (let roll = 2; roll <= 12; roll++) {
    rows.push([String(roll), critResult(locale, roll)]);
  }
  return [
    buildLinesChunk([i18n(locale, "table.crit.title")]),
    buildHeaderTableChunkFromRows(header, rows),
  ];
}

export function renderHeatScaleTable(locale: LocaleId): Chunk[] {
  const header = [
    i18n(locale, "table.heat.col.heat"),
    i18n(locale, "table.heat.col.toHit"),
    i18n(locale, "table.heat.col.mp"),
    i18n(locale, "table.heat.col.shutdown"),
    i18n(locale, "table.heat.col.ammo"),
  ];
  const rows: string[][] = [
    ["0–7", "0", "0", i18n(locale, "table.heat.shutdownSafe"), i18n(locale, "table.heat.ammoSafe")],
    [
      "8–12",
      "+1",
      "0",
      i18n(locale, "table.heat.shutdownSafe"),
      i18n(locale, "table.heat.ammoSafe"),
    ],
    [
      "13–16",
      "+2",
      "0",
      i18n(locale, "table.heat.shutdownSafe"),
      i18n(locale, "table.heat.ammoSafe"),
    ],
    ["14–17", "+2", "0", "2D6 < 4", i18n(locale, "table.heat.ammoSafe")],
    ["17–19", "+3", "+1", "2D6 < 6", i18n(locale, "table.heat.ammoSafe")],
    ["19–21", "+3", "+1", "2D6 < 6", "2D6 < 4"],
    ["20–22", "+3", "+2", "2D6 < 8", "2D6 < 6"],
    ["22–24", "+3", "+3", "2D6 < 8", "2D6 < 6"],
    ["23–25", "+4", "+3", "2D6 < 10", "2D6 < 6"],
    ["24–26", "+4", "+4", "2D6 < 10", "2D6 < 6"],
    ["26–28", "+4", "+4", "2D6 < 10", "2D6 < 8"],
    ["28–29", "+4", "+4", "2D6 < 10", "2D6 < 8"],
    ["30+", "+4", "+5", i18n(locale, "table.heat.shutdownAuto"), "2D6 < 8"],
  ];
  return [
    buildLinesChunk([i18n(locale, "table.heat.title")]),
    buildHeaderTableChunkFromRows(header, rows),
  ];
}

export function listTables(locale: LocaleId): Chunk[] {
  return [
    buildLinesChunk([
      i18n(locale, "table.list.header"),
      i18n(locale, "table.list.cluster"),
      i18n(locale, "table.list.hitloc"),
      i18n(locale, "table.list.crit"),
      i18n(locale, "table.list.heat"),
    ]),
  ];
}
