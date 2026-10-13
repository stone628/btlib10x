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
  RIGHT_SIDE_TABLE,
  type WeaponCategory,
  type WeaponDef,
  weightClassForTonnage,
} from "btlib10x";
import {
  buildBoardChunk,
  buildCollapsibleChunk,
  buildHeaderTableChunkFromColumns,
  buildHeaderTableChunkFromRows,
  buildLinesChunk,
  type Chunk,
} from "./chunk";
import { i18n } from "./i18n/index";
import { lookupMap, lookupWeapon } from "./lookup";
import { displayModel, weaponCategory } from "./misc";
import {
  isEmptyQuery,
  MECH_FILTER_KEYS,
  parseQuery,
  queryLabel,
  ROW_CAP,
  selectMechs,
  selectWeapons,
  unknownModelError,
  unknownWeaponError,
  WEAPON_FILTER_KEYS,
} from "./query";

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

/** `info mech` resolves to either one sheet or a listing tier. */
export type InfoMechResult =
  | {
      readonly kind: "sheet";
      readonly model: string;
      /** Set when a search (not an exact model key) narrowed to this one 'Mech. */
      readonly note: string | null;
    }
  | { readonly kind: "list"; readonly chunks: Chunk[] };

function mechTable(list: readonly MechManifestEntry[]): Chunk {
  const header = [
    i18n("info.mechColModel"),
    i18n("info.mechColName"),
    i18n("info.mechColClass"),
    i18n("info.mechColTechBase"),
    i18n("info.mechColTon"),
  ];
  // Move ratings live in the registered sheets; the manifest carries identity only.
  const rows = list.map((d) => [
    displayModel(d),
    d.clanName === undefined ? d.name : `${d.name} (${d.clanName})`,
    weightClassForTonnage(d.tonnage),
    d.techBase,
    String(d.tonnage),
  ]);
  return buildHeaderTableChunkFromRows(header, rows);
}

function tonnageSpan(list: readonly MechManifestEntry[]): string {
  const tons = list.map((m) => m.tonnage);
  const lo = Math.min(...tons);
  const hi = Math.max(...tons);
  return lo === hi ? `${lo}t` : `${lo}–${hi}t`;
}

/** Group by chassis name, keeping the list's order of first appearance. */
function groupBy<T>(list: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [item]);
    else g.push(item);
  }
  return groups;
}

/** Model keys shown inline on a collapsed chassis row before an ellipsis. */
const CHASSIS_INLINE_MODELS = 6;

function chassisChunks(chassis: ReadonlyMap<string, readonly MechManifestEntry[]>): Chunk[] {
  const groups = [...chassis.values()];
  const tonW = Math.max(...groups.map((g) => tonnageSpan(g).length));
  const nameW = Math.max(...[...chassis.keys()].map((n) => n.length));
  const countW = Math.max(...groups.map((g) => String(g.length).length));
  return [...chassis].map(([name, variants]) => {
    const models = variants.slice(0, CHASSIS_INLINE_MODELS).map((m) => m.model);
    if (variants.length > CHASSIS_INLINE_MODELS) models.push("…");
    const summary = `${tonnageSpan(variants).padStart(tonW)} ${name.padEnd(nameW)} ${String(variants.length).padStart(countW)}  ${models.join(" ")}`;
    return buildCollapsibleChunk(summary, [mechTable(variants)]);
  });
}

function mechCountsChunk(list: readonly MechManifestEntry[]): Chunk {
  const byClass = groupBy(list, (m) => weightClassForTonnage(m.tonnage));
  const chassisCount = (g: readonly MechManifestEntry[]) => new Set(g.map((m) => m.name)).size;
  if (byClass.size > 1) {
    const order = ["Light", "Medium", "Heavy", "Assault"];
    const rows = [...byClass]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([cls, g]) => [cls, tonnageSpan(g), String(g.length), String(chassisCount(g))]);
    return buildHeaderTableChunkFromRows(
      [
        i18n("info.mechColClass"),
        i18n("info.mechColTon"),
        i18n("info.mechColCount"),
        i18n("info.mechColChassis"),
      ],
      rows,
    );
  }
  const byTon = groupBy(list, (m) => String(m.tonnage));
  const rows = [...byTon]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([ton, g]) => [`${ton}t`, String(g.length), String(chassisCount(g))]);
  return buildHeaderTableChunkFromRows(
    [i18n("info.mechColTon"), i18n("info.mechColCount"), i18n("info.mechColChassis")],
    rows,
  );
}

/**
 * `info mech [model | text] [key:value …] [!]`. An exact model key (or a
 * single match) opens its sheet; otherwise the listing tier depends on the
 * match count: a table up to ROW_CAP 'Mechs, then one collapsible row per
 * chassis up to ROW_CAP chassis, then counts by class (or by tonnage inside
 * one class). `!` always prints the full table.
 */
export function infoMechQuery(
  args: readonly string[],
  entries: readonly MechManifestEntry[] = catalogMechs(),
): InfoMechResult {
  const q = parseQuery(args, MECH_FILTER_KEYS);
  if (q.text !== "" && q.filters.size === 0) {
    const needle = q.text.toLowerCase();
    const exact = entries.find((m) => m.model.toLowerCase() === needle);
    if (exact !== undefined) return { kind: "sheet", model: exact.model, note: null };
  }
  const list = selectMechs(entries, q);
  if (list.length === 0) {
    if (q.filters.size === 0) throw unknownModelError(q.text, entries);
    throw new Error(i18n("err.noMechMatch", { query: queryLabel(q) }));
  }
  const first = list[0]!;
  if (list.length === 1 && !q.force) {
    const note = i18n("info.mechSingleMatch", { query: queryLabel(q), model: first.model });
    return { kind: "sheet", model: first.model, note };
  }
  const chassis = groupBy(list, (m) => m.name);
  const head = isEmptyQuery(q)
    ? i18n("info.mechTotal", { count: list.length, chassis: chassis.size })
    : i18n("info.mechMatches", { count: list.length, chassis: chassis.size, query: queryLabel(q) });
  if (list.length <= ROW_CAP || q.force) {
    return { kind: "list", chunks: [buildLinesChunk(head), mechTable(list)] };
  }
  const hint = buildLinesChunk(i18n("info.mechHint"));
  if (chassis.size <= ROW_CAP) {
    return {
      kind: "list",
      chunks: [buildLinesChunk(head, i18n("info.chassisHint")), ...chassisChunks(chassis), hint],
    };
  }
  const classes = new Set(list.map((m) => weightClassForTonnage(m.tonnage)));
  const tonnages = new Set(list.map((m) => m.tonnage));
  if (classes.size > 1 || tonnages.size > 1) {
    return { kind: "list", chunks: [buildLinesChunk(head), mechCountsChunk(list), hint] };
  }
  // One tonnage, still too many chassis: the first ROW_CAP chassis, then a tally.
  const shown = new Map([...chassis].slice(0, ROW_CAP));
  return {
    kind: "list",
    chunks: [
      buildLinesChunk(head, i18n("info.chassisHint")),
      ...chassisChunks(shown),
      buildLinesChunk(
        i18n("info.moreChassis", { count: chassis.size - ROW_CAP }),
        i18n("info.mechHint"),
      ),
    ],
  };
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

function weaponStatLine(w: WeaponDef, nameLen: number): string {
  const rs = `S${w.short}`.padStart(3);
  const rm = `M${w.medium}`.padStart(3);
  const rl = `L${w.long}`.padStart(3);
  const rh = `H${w.heat ?? 0}`.padStart(3);
  return `  ${w.name.padEnd(nameLen)} ${rs} /${rm} /${rl}  ${rh}  D${weaponDamageSummary(w)}`;
}

/** Stat lines, under `[Category]` headers when listed in catalog order. */
function weaponStatLines(list: readonly WeaponDef[], grouped: boolean): string[] {
  const nameLen = Math.max(...list.map((w) => w.name.length));
  if (!grouped) return list.map((w) => weaponStatLine(w, nameLen));
  const lines: string[] = [];
  for (const [cat, weapons] of groupBy(list, (w) => w.category)) {
    lines.push(i18n("info.weaponCategory", { category: weaponCategory(cat as WeaponCategory) }));
    for (const w of weapons) lines.push(weaponStatLine(w, nameLen));
  }
  return lines;
}

/**
 * `info weapon [name | text] [key:value …] [!]`. An exact name (or a single
 * match) shows its detail; up to ROW_CAP matches print stat lines; more print
 * names only, one line per category. `!` always prints every stat line.
 */
export function infoWeaponQuery(
  args: readonly string[],
  entries: readonly WeaponDef[] = allWeaponDefs(),
): Chunk {
  const q = parseQuery(args, WEAPON_FILTER_KEYS);
  if (q.text !== "" && q.filters.size === 0) {
    const needle = q.text.toLowerCase();
    const exact = entries.find((w) => w.name.toLowerCase() === needle);
    if (exact !== undefined) return infoWeaponChunk(exact.name);
  }
  const list = selectWeapons(entries, q);
  if (list.length === 0) {
    if (q.filters.size === 0) throw unknownWeaponError(q.text, entries);
    throw new Error(i18n("err.noWeaponMatch", { query: queryLabel(q) }));
  }
  if (list.length === 1 && !q.force) {
    const only = infoWeaponChunk(list[0]!.name);
    const note = i18n("info.weaponSingleMatch", { query: queryLabel(q), name: list[0]!.name });
    return buildLinesChunk(note, ...(only.kind === "lines" ? only.lines : []));
  }
  const head = isEmptyQuery(q)
    ? i18n("info.weaponTotal", { count: list.length })
    : i18n("info.weaponMatches", { count: list.length, query: queryLabel(q) });
  const sorted = q.filters.has("sort") && q.filters.get("sort")!.toLowerCase() !== "cat";
  if (list.length <= ROW_CAP || q.force) {
    return buildLinesChunk(head, ...weaponStatLines(list, !sorted));
  }
  const lines = [head];
  for (const [cat, weapons] of groupBy(list, (w) => w.category)) {
    lines.push(
      i18n("info.weaponNamesLine", {
        category: weaponCategory(cat as WeaponCategory),
        count: weapons.length,
        names: weapons.map((w) => w.name).join(", "),
      }),
    );
  }
  lines.push(i18n("info.weaponHint"));
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
  if (w === undefined) throw unknownWeaponError(name);
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
