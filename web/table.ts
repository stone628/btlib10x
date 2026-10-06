import type { MechManifestEntry } from "btlib10x";
import {
  allWeaponDefs,
  CLUSTER_COLUMNS,
  CLUSTER_TABLE,
  catalogMaps,
  catalogMechs,
  HIT_LOCATION_TABLE,
  heatScaleEffects,
  LEFT_SIDE_TABLE,
  listMapNames,
  listWeaponNames,
  RIGHT_SIDE_TABLE,
  type WeaponCategory,
  type WeaponDef,
  weightClassForTonnage,
} from "btlib10x";
import {
  buildBoardChunk,
  buildHeaderTableChunkFromColumns,
  buildHeaderTableChunkFromRows,
  buildLinesChunk,
  type Chunk,
} from "./chunk";
import { i18n } from "./i18n/index";
import { lookupMap, lookupWeapon } from "./lookup";
import { weaponCategory } from "./misc";

const CLUSTER_SIZES = CLUSTER_COLUMNS;

function critResult(roll: number): string {
  if (roll <= 7) return i18n("res.critNone");
  if (roll <= 9) return i18n("res.critOne");
  if (roll <= 11) return i18n("res.critTwo");
  return i18n("res.critThree");
}

export function renderClusterTable(): Chunk[] {
  const header = [
    i18n("table.cluster.col.roll"),
    ...CLUSTER_SIZES.map((s) => i18n("table.cluster.col.size", { size: String(s) })),
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
    buildLinesChunk(i18n("table.cluster.title")),
    buildHeaderTableChunkFromRows(header, rows),
  ];
}

export function renderHitLocationTables(): Chunk[] {
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
    buildLinesChunk(i18n("table.hitloc.title")),
    buildHeaderTableChunkFromColumns(
      [
        i18n("table.hitloc.col.roll"),
        i18n("table.hitloc.frontRear"),
        i18n("table.hitloc.leftSide"),
        i18n("table.hitloc.rightSide"),
      ],
      [dice, fr, ls, rs],
    ),
  ];
}

export function renderCriticalTable(): Chunk[] {
  const header = [i18n("table.crit.col.roll"), i18n("table.crit.col.result")];
  const rows: string[][] = [];
  for (let roll = 2; roll <= 12; roll++) {
    rows.push([String(roll), critResult(roll)]);
  }
  return [buildLinesChunk(i18n("table.crit.title")), buildHeaderTableChunkFromRows(header, rows)];
}

/** Top of the displayed Heat Scale: 30+ auto-shuts down, sharing one row. */
const HEAT_TABLE_MAX = 30;

export function renderHeatScaleTable(): Chunk[] {
  const header = [
    i18n("table.heat.col.heat"),
    i18n("table.heat.col.toHit"),
    i18n("table.heat.col.mp"),
    i18n("table.heat.col.shutdown"),
    i18n("table.heat.col.ammo"),
  ];
  const rows: string[][] = [];
  let rangeStart = 0;
  let prevKey: string | null = null;
  let prevCells: string[] | null = null;
  const pushRow = (start: number, end: number, cells: string[]): void => {
    const label =
      start === end ? (start === HEAT_TABLE_MAX ? `${start}+` : `${start}`) : `${start}–${end}`;
    rows.push([label, ...cells]);
  };
  for (let heat = 0; heat <= HEAT_TABLE_MAX; heat++) {
    const fx = heatScaleEffects(heat);
    const toHit = fx.toHitMod === 0 ? "0" : `+${fx.toHitMod}`;
    const mp = fx.mpPenalty === 0 ? "0" : `+${fx.mpPenalty}`;
    const shutdown =
      fx.shutdown === null
        ? i18n("table.heat.shutdownSafe")
        : fx.shutdown === "auto"
          ? i18n("table.heat.shutdownAuto")
          : `2D6 < ${fx.shutdown.avoid}`;
    const ammo =
      fx.ammoExplosion === null ? i18n("table.heat.ammoSafe") : `2D6 < ${fx.ammoExplosion.avoid}`;
    const key = `${toHit}|${mp}|${shutdown}|${ammo}`;
    if (prevKey !== null && key !== prevKey && prevCells !== null) {
      pushRow(rangeStart, heat - 1, prevCells);
      rangeStart = heat;
    }
    prevKey = key;
    prevCells = [toHit, mp, shutdown, ammo];
  }
  if (prevCells !== null) pushRow(rangeStart, HEAT_TABLE_MAX, prevCells);
  return [buildLinesChunk(i18n("table.heat.title")), buildHeaderTableChunkFromRows(header, rows)];
}

export function listTables(): Chunk[] {
  return [
    buildLinesChunk(
      i18n("table.list.header"),
      i18n("table.list.cluster"),
      i18n("table.list.hitloc"),
      i18n("table.list.crit"),
      i18n("table.list.heat"),
    ),
  ];
}

export function infoMechListChunk(): Chunk {
  const list = [...catalogMechs()].sort((a: MechManifestEntry, b: MechManifestEntry) => {
    if (a.tonnage !== b.tonnage) return a.tonnage - b.tonnage;
    return a.name.localeCompare(b.name);
  });
  const header = [
    i18n("info.mechColModel"),
    i18n("info.mechColName"),
    i18n("info.mechColClass"),
    i18n("info.mechColTechBase"),
    i18n("info.mechColTon"),
  ];
  const rows = list.map((d: MechManifestEntry) => {
    // Move ratings live in the registered sheets (sync registry is fully
    // loaded); the manifest carries identity only.
    return [
      d.model,
      d.clanName === undefined ? d.name : `${d.name} (${d.clanName})`,
      weightClassForTonnage(d.tonnage),
      d.techBase,
      String(d.tonnage),
    ];
  });
  return buildHeaderTableChunkFromRows(header, rows);
}

export function infoMapListChunk(): Chunk {
  return buildLinesChunk(...catalogMaps().map((m) => `${m.name}: ${m.width}x${m.height}`));
}

function weaponDamageSummary(w: WeaponDef): string {
  if (w.variableDamage)
    return `${w.variableDamage[0]} / ${w.variableDamage[1]} / ${w.variableDamage[2]}`;
  if (w.missileDamage !== undefined && w.missiles !== undefined)
    return `${w.missileDamage * w.missiles} = ${w.missileDamage} per missile × ${w.missiles}`;
  return String(w.damage ?? 0);
}

export function infoWeaponListChunk(): Chunk {
  const grouped = new Map<WeaponCategory, WeaponDef[]>();
  let maxNameLen = 0;
  for (const w of allWeaponDefs()) {
    const list = grouped.get(w.category) ?? [];
    list.push(w);
    grouped.set(w.category, list);
    maxNameLen = Math.max(maxNameLen, w.name.length);
  }
  const lines: string[] = [];
  for (const [cat, weapons] of grouped) {
    lines.push(i18n("info.weaponCategory", { category: weaponCategory(cat) }));
    for (const w of weapons) {
      const rs = `S${w.short}`.padStart(3);
      const rm = `M${w.medium}`.padStart(3);
      const rl = `L${w.long}`.padStart(3);
      const rh = `H${w.heat ?? 0}`.padStart(3);

      lines.push(
        `  ${w.name.padEnd(maxNameLen)} ${rs} /${rm} /${rl}  ${rh}  D${weaponDamageSummary(w)}`,
      );
    }
  }
  return buildLinesChunk(...lines);
}

function weaponDamageDetail(w: WeaponDef): string {
  if (w.variableDamage)
    return `${w.variableDamage[0]} (short) / ${w.variableDamage[1]} (medium) / ${w.variableDamage[2]} (long)`;
  if (w.missileDamage !== undefined && w.missiles !== undefined)
    return i18n("info.damagePerMissile", { damage: w.missileDamage! });
  return `${w.damage ?? 0} (direct fire)`;
}

export function infoWeaponChunk(name: string): Chunk {
  const w = lookupWeapon(name);
  if (w === undefined) {
    throw new Error(i18n("err.unknownWeapon", { name, list: listWeaponNames().join(", ") }));
  }
  const cat = weaponCategory(w.category);
  const lines = [
    i18n("info.weaponHead", { name: w.name, category: cat }),
    i18n("info.weaponRange", { short: w.short, medium: w.medium, long: w.long }),
    i18n("info.weaponDamage", { damage: weaponDamageDetail(w) }),
    i18n("info.weaponHeat", { heat: w.heat ?? 0 }),
  ];
  if (w.missiles !== undefined) lines.push(i18n("info.weaponMissiles", { count: w.missiles }));
  if (w.pulse) lines.push(i18n("info.weaponPulse"));
  // Non-pulse weapons with a To-Hit Mod column value (TW p.303-304: MRM +1,
  // Clan heavy lasers +1). Pulse lasers already show their -2 above.
  if (w.toHitMod !== undefined && w.toHitMod !== 0 && w.pulse !== true) {
    lines.push(
      i18n("info.weaponToHitMod", { mod: w.toHitMod > 0 ? `+${w.toHitMod}` : `${w.toHitMod}` }),
    );
  }
  if (w.rapidFireShots !== undefined)
    lines.push(i18n("info.weaponRapidFire", { shots: w.rapidFireShots }));
  if (w.antiInfantry) lines.push(i18n("info.weaponAntiInfantry"));
  return buildLinesChunk(...lines);
}

/** `info map <name>` output: header/legend lines followed by the styled grid. */
export function infoMapChunks(name: string): Chunk[] {
  const map = lookupMap(name);
  if (map === undefined) {
    throw new Error(i18n("err.unknownMap", { name, list: listMapNames().join(", ") }));
  }
  return [
    buildLinesChunk(i18n("info.mapHead", { name, w: map.width, h: map.height })),
    buildBoardChunk({ map, units: null, reachable: null, clubHexes: null }),
  ];
}
