import type {
  ActorQueueActorView,
  AmmoBins,
  AmmoPolicy,
  Arc,
  AttackResolution,
  BattleState,
  CoreComponentStatus,
  CriticalEffect,
  CriticalResolution,
  CritSoakName,
  CritStructureName,
  DamageTransferStep,
  DestroyedReason,
  DestroyedState,
  Facing,
  FireBlockerReason,
  FireSuggestion,
  FireWeapon,
  GameEvent,
  HexCoord,
  Location,
  LocationValue,
  MapNameHolder,
  MoveMode,
  RangeBracket,
  RemovedState,
  ResolvedMechDef,
  RevealedLanding,
  ShutdownState,
  TerrainType,
  UnitDamageState,
  UnitState,
  WeaponCategory,
  WeaponDef,
} from "btlib10x";
import {
  actorQueue,
  ammoBinId,
  ammoExplosionAvoid,
  ammoExplosionAvoidWithThreshold,
  canFireFromLocation,
  collectAmmoBins,
  consciousnessTarget,
  coreComponentStatus,
  countDestroyedEngine,
  DROP_MP_COST,
  ENGINE_SLOTS_KILL,
  effectiveMovement,
  getAllMapDefs,
  getAllMechDefs,
  getAllWeaponDefs,
  getMapDefFor,
  getMechDefFor,
  getWeaponDefFor,
  HEAT_CAP,
  heatDissipation,
  internalStructureForTonnage,
  isArm,
  isTorso,
  isUnitAvailable,
  isUnitDestroyed,
  isUnitImmobile,
  isUnitRemoved,
  listMapNames,
  listWeaponNames,
  loadAmmoBins,
  MP_PER_FACING_CHANGE,
  movementMpPenalty,
  movementMpPenaltyWithThreshold,
  neighbor,
  oppositeFacing,
  pooledTotalsByWeaponName,
  reachableLandings,
  rotateFacing,
  STAND_MP_COST,
  shoulderOf,
  shutdownAvoid,
  TORSO_LOCATIONS,
  toHitHeatModifier,
  toHitHeatModifierWithThreshold,
  wreckAt,
} from "btlib10x";
import { AMMO_EXPLOSION_START_HEAT, heatDissipationMax } from "../src/index.js";
import type { RemovalReason } from "../src/rules/game.js";
import { GYRO_DESTROYED_HITS, GYRO_HIT_MOD, SENSOR_BLIND_HITS } from "../src/rules/piloting.js";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { getCompensatedLength, i18n } from "./i18n/index.js";
import { lookupMap, lookupMech, lookupWeapon } from "./lookup.js";
import type { BoardRenderer, BoardRenderInfo, BoardRenderReachableInfo } from "./render.js";
import {
  createBoardRenderUnit,
  createEjectedBoardRenderUnits,
  getBoardRenderer,
} from "./render.js";
import { budgetFor, currentActor, displayModeFor, fullBudgetFor, type Session } from "./session.js";

const SHEET_FACING_KEYS: Readonly<Record<Facing, MessageKey>> = {
  n: "sheet.facing.n",
  ne: "sheet.facing.ne",
  nw: "sheet.facing.nw",
  s: "sheet.facing.s",
  se: "sheet.facing.se",
  sw: "sheet.facing.sw",
};
export const F = (l: LocaleId, f: Facing): string => i18n(l, SHEET_FACING_KEYS[f]);
export const PRN = (l: LocaleId, prone: boolean): string =>
  i18n(l, prone ? "sheet.postureProne" : "sheet.postureStand");

export const TRN = (l: LocaleId, terrain: TerrainType): string =>
  i18n(l, `terrain.${terrain}` as MessageKey);

/** Board renderer type (re-exported from the render layer). */
export type { BoardRenderer } from "./render.js";

/** One presentation chunk of command output. */
export type Chunk =
  | { readonly kind: "lines"; lines: readonly string[]; cls?: string }
  | {
      readonly kind: "board";
      readonly info: BoardRenderInfo;
      readonly renderer: BoardRenderer | null;
    }
  | { readonly kind: "columns"; columns: readonly (readonly string[])[] }
  | {
      readonly kind: "collapsible";
      readonly summary: string;
      readonly chunks: readonly Chunk[];
    };

export function buildLinesChunk(lines: readonly string[], cls?: string): Chunk {
  return cls ? { kind: "lines", lines: lines, cls: cls } : { kind: "lines", lines: lines };
}

export function buildBoardChunk(info: BoardRenderInfo): Chunk {
  return { kind: "board", info, renderer: getBoardRenderer("css-grid") ?? null };
}

export function buildColumnsChunk(columns: readonly (readonly string[])[]): Chunk {
  return { kind: "columns", columns: columns };
}

/**
 * Render a header + body table as a `columns` Chunk using Unicode box-drawing
 * glyphs. The returned `columns` array has `header.length + 1` entries:
 *
 * Glyphs (data column 0 / data columns 1..n-1 / closing column):
 *   top:    ┌─── / ┬─── / ┐
 *   header: │HEAD  / │HEAD / │
 *   sep:    ├─── / ┼─── / ┤
 *   body:   │C     / │C    / │
 *   bot:    └─── / ┴─── / ┘
 *
 * Column widths come from `max(strlen)` per column. Box-drawing glyphs are
 * assumed to render at 1 ch in the terminal font.
 */
const HEADER_TABLE_THEME = {
  LIGHT: {
    tnw: "┌", // top left corner of header column
    tn: "┬", // separator for top line of header column
    tne: "┐", // top right corner of header column
    tnh: "─", // top line of header column
    tnv: "│", // vertical line of header column

    tw: "├", // left end of bottom line of header column
    tc: "┼", // seperator for bottom line of header column
    te: "┤", // right end of bottom line of header column
    tcs: "┬", // separator for bottom line of header column, for hidden header
    twc: "┌", // left end of bottom line of header column, for hidden header
    tec: "┐", // right end of bottom line of header column, for hidden header

    tsw: "└", // bottom left corner of body column
    ts: "┴", // separator for bottom line of body column
    tse: "┘", // bottom right corner of body column
    tsh: "─", // bottom line of body column
    tsv: "│", // vertical line of body column
  },
  ASCII: {
    tnw: "+",
    tn: "+",
    tne: "+",
    tnh: "-",
    tnv: "|",
    tw: "+",
    tc: "+",
    te: "+",
    tcs: "+",
    twc: "+",
    tec: "+",
    tsw: "+",
    ts: "+",
    tse: "+",
    tsh: "-",
    tsv: "|",
  },
};

export function buildHeaderTableChunkFromRows(
  header: readonly (string | null)[],
  rows: readonly (readonly string[])[],
): Chunk {
  const n = header.length;
  if (n === 0) return buildColumnsChunk([]);

  const widths: number[] = [];
  for (let i = 0; i < n; i++) {
    const currHeader = header[i];
    let w = currHeader == null ? 0 : getCompensatedLength(currHeader!);
    for (const row of rows) {
      const cell = row[i];
      if (cell !== undefined) {
        const cellLen = getCompensatedLength(cell);
        if (cellLen > w) w = cellLen;
      }
    }
    widths.push(w);
  }

  const { tnw, tn, tne, tnh, tnv, tw, tc, te, tcs, twc, tec, tsw, ts, tse, tsh, tsv } =
    HEADER_TABLE_THEME.LIGHT;
  const height = rows.length;
  const cols: string[][] = [];
  let prevHeaderExists = true;
  for (let i = 0; i < n; i++) {
    const w = widths[i] ?? 0;
    const stroke = tnh.repeat(w);
    const isDataFirst = i === 0;
    const botWall = isDataFirst ? tsw : ts;
    const col: string[] = new Array(height + 4);
    const currHeader = header[i];

    if (currHeader === null) {
      if (isDataFirst) {
        col[0] = "";
        col[1] = "";
        col[2] = `${twc}${stroke}`;
      } else {
        if (prevHeaderExists) {
          col[0] = tne;
          col[1] = tnv;
          col[2] = `${tc}${stroke}`;
        } else {
          col[0] = "";
          col[1] = "";
          col[2] = `${tcs}${stroke}`;
        }
      }
      prevHeaderExists = false;
    } else {
      if (isDataFirst) {
        col[0] = `${tnw}${stroke}`;
        col[1] = `${tnv}${currHeader}`;
        col[2] = `${tw}${stroke}`;
      } else {
        const topWall = prevHeaderExists ? tn : tnw;
        col[0] = `${topWall}${stroke}`;
        col[1] = `${tnv}${currHeader}`;
        col[2] = `${tc}${stroke}`;
      }
      prevHeaderExists = true;
    }
    for (let r = 0; r < height; r++) {
      col[3 + r] = `${tsv}${rows[r]?.[i] ?? ""}`;
    }
    col[height + 3] = `${botWall}${tsh.repeat(w)}`;
    cols.push(col);
  }

  const closing: string[] = new Array(height + 3);
  if (prevHeaderExists) {
    closing[0] = tne;
    closing[1] = tnv;
    closing[2] = te;
  } else {
    closing[0] = "";
    closing[1] = "";
    closing[2] = tec;
  }
  for (let r = 0; r < height; r++) closing[3 + r] = tsv;
  closing[height + 3] = tse;
  cols.push(closing);

  return buildColumnsChunk(cols);
}

export function buildHeaderTableChunkFromColumns(
  header: readonly (string | null)[],
  columns: readonly (readonly string[])[],
): Chunk {
  const n = header.length;
  if (n === 0) return buildColumnsChunk([]);

  const { tnw, tn, tne, tnh, tnv, tw, tc, te, tcs, twc, tec, tsw, ts, tse, tsh, tsv } =
    HEADER_TABLE_THEME.LIGHT;
  const widths: number[] = [];
  const cols: string[][] = [];
  const height = columns.map((c) => c.length).reduce((prev, curr) => (prev > curr ? prev : curr));
  for (let i = 0; i < n; i++) {
    const currHeader = header[i];
    let w = currHeader === null ? 0 : getCompensatedLength(currHeader!);
    const argCol = columns[i];
    const col: string[] = new Array(height + 4);

    if (argCol === undefined) {
      for (let r = 0; r < height; r++) {
        col[3 + r] = tsv;
      }
    } else {
      for (let r = 0; r < height; r++) {
        const cell = argCol[r];
        if (cell !== undefined) {
          const cellLen = getCompensatedLength(cell);
          if (cellLen > w) w = cellLen;
          col[3 + r] = `${tsv}${cell}`;
        } else {
          col[3 + r] = tsv;
        }
      }
    }
    widths.push(w);
    cols.push(col);
  }

  let prevHeaderExists = true;
  for (let i = 0; i < n; i++) {
    const w = widths[i] ?? 0;
    const stroke = tnh.repeat(w);
    const isDataFirst = i === 0;
    const botWall = isDataFirst ? tsw : ts;
    const col = cols[i]!;
    const currHeader = header[i];

    if (currHeader == null) {
      if (isDataFirst) {
        col[0] = "";
        col[1] = "";
        col[2] = `${twc}${stroke}`;
      } else {
        if (prevHeaderExists) {
          col[0] = tne;
          col[1] = tnv;
          col[2] = `${tc}${stroke}`;
        } else {
          col[0] = "";
          col[1] = "";
          col[2] = `${tcs}${stroke}`;
        }
      }
      prevHeaderExists = false;
    } else {
      if (isDataFirst) {
        col[0] = `${tnw}${stroke}`;
        col[1] = `${tnv}${currHeader!}`;
        col[2] = `${tw}${stroke}`;
      } else {
        const topWall = prevHeaderExists ? tn : tnw;
        col[0] = `${topWall}${stroke}`;
        col[1] = `${tnv}${currHeader!}`;
        col[2] = `${tc}${stroke}`;
      }
      prevHeaderExists = true;
    }
    col[height + 3] = `${botWall}${tsh!.repeat(w)}`;
  }

  const closing: string[] = new Array(height + 3);
  if (prevHeaderExists) {
    closing[0] = tne;
    closing[1] = tnv;
    closing[2] = te;
  } else {
    closing[0] = "";
    closing[1] = "";
    closing[2] = tec;
  }
  for (let r = 0; r < height; r++) closing[3 + r] = tsv;
  closing[height + 3] = tse;
  cols.push(closing);

  return buildColumnsChunk(cols);
}

export function buildCollapsibleChunk(summary: string, chunks: readonly Chunk[]): Chunk {
  return { kind: "collapsible", summary: summary, chunks: chunks };
}

/** Display coordinates are 1-based (the internal value itself). */
function disp(hex: { col: number; row: number }): string {
  return `${hex.col},${hex.row}`;
}

/**
 * Pilot rating for gunnery 0..7, rendered as `{name}({gunnery})` using the
 * standard experience bands: 0-1 elite, 2-3 veteran, 4-5 regular, 6-7 green.
 */
function gunneryLabel(locale: LocaleId, gunnery: number): string {
  const band =
    gunnery <= 1
      ? "skill.elite"
      : gunnery <= 3
        ? "skill.veteran"
        : gunnery <= 5
          ? "skill.regular"
          : "skill.green";
  return `${i18n(locale, band)}(${gunnery})`;
}

/** `board` output: styled grid chunks, or a plain hint when nothing exists. */
export function boardChunk(s: Session): Chunk {
  const mapName = s.setup.mapName;
  if (mapName === null) return buildLinesChunk([i18n(s.locale, "board.noMap")]);
  const map = getMapDefFor(s.setup);
  if (s.battle) {
    const battleUnits = s.battle.units;
    const units = Object.values(battleUnits)
      .filter((u) => isUnitAvailable(u))
      .map((u) => createBoardRenderUnit(u));
    const ejectedUnits = createEjectedBoardRenderUnits(battleUnits, s.battle.wrecks);
    if (ejectedUnits.length > 0) units.push(...ejectedUnits);
    return buildBoardChunk({
      map,
      units,
      reachable: null,
      locale: s.locale,
    });
  }
  return buildBoardChunk({
    map,
    units: s.setup.roster.map((u) => createBoardRenderUnit(u)),
    reachable: null,
    locale: s.locale,
  });
}

// ---------------------------------------------------------------- info ----

export function infoMechList(locale: LocaleId): Chunk {
  const list = getAllMechDefs().sort((a, b) => {
    if (a.tonnage !== b.tonnage) return a.tonnage - b.tonnage;
    return a.name.localeCompare(b.name);
  });
  const header = [
    i18n(locale, "info.mechColModel"),
    i18n(locale, "info.mechColName"),
    i18n(locale, "info.mechColClass"),
    i18n(locale, "info.mechColTon"),
    i18n(locale, "info.mechColMove"),
  ];
  const rows = list.map((d) => [
    d.model,
    d.name,
    d.weightClass,
    String(d.tonnage),
    `${d.walking}/${d.running}/${d.jumping}`,
  ]);
  return buildHeaderTableChunkFromRows(header, rows);
}

export function infoMechChunk(locale: LocaleId, model: string): Chunk[] {
  const d = requireMechDef(model, locale);
  const armorRear: Partial<LocationValue> = {};
  for (const loc of TORSO_LOCATIONS) {
    const v = d.armorRear[loc];
    if (v !== undefined) armorRear[loc] = v;
  }
  const is = internalStructureForTonnage(d.tonnage);
  const topLines = [
    i18n(locale, "info.head", {
      model: d.model,
      name: d.name,
      weightClass: d.weightClass,
      tonnage: d.tonnage,
      techBase: d.techBase,
    }),
    i18n(locale, "info.movement", { walk: d.walking, run: d.running, jump: d.jumping }),
  ];
  const weaponLines = [
    i18n(locale, "sheet.weaponsHeader", { n: Object.keys(d.weapons).length }),
    ...weaponMountLines(
      locale,
      buildMountInfos(d, null, () => ({ jammed: false, destroyed: false })),
    ),
  ];
  return [
    buildHeaderTableChunkFromColumns(
      [i18n(locale, "info.specsCol"), i18n(locale, "info.armorStructureCol")],
      mergeDiagramToColumns(
        topLines,
        weaponLines,
        armorDiagramInfo({
          armor: d.armor,
          armorRear,
          internalStructure: is,
          originalArmor: d.armor,
          originalArmorRear: armorRear,
          originalStructure: is,
          dissipMax: heatDissipationMax(d),
        }),
      ),
    ),
    critChartChunk(d, locale, null, null),
  ];
}

export function infoMapList(): string[] {
  return getAllMapDefs().map(
    (m) => `${m.name}: ${m.width}x${m.height}, ${m.terrain.length} terrain hexes`,
  );
}

export function infoWeaponList(locale: LocaleId): string[] {
  const grouped = new Map<WeaponCategory, WeaponDef[]>();
  let maxNameLen = 0;
  for (const w of getAllWeaponDefs()) {
    const list = grouped.get(w.category) ?? [];
    list.push(w);
    grouped.set(w.category, list);
    maxNameLen = Math.max(maxNameLen, w.name.length);
  }
  const lines: string[] = [];
  for (const [cat, weapons] of grouped) {
    lines.push(i18n(locale, "info.weaponCategory", { category: weaponCategory(locale, cat) }));
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
  return lines;
}

export function infoWeapon(locale: LocaleId, name: string): string[] {
  const w = lookupWeapon(name);
  if (w === undefined) {
    throw new Error(
      i18n(locale, "err.unknownWeapon", { name, list: listWeaponNames().join(", ") }),
    );
  }
  const cat = weaponCategory(locale, w.category);
  const lines = [
    i18n(locale, "info.weaponHead", { name: w.name, category: cat }),
    i18n(locale, "info.weaponRange", { short: w.short, medium: w.medium, long: w.long }),
    i18n(locale, "info.weaponDamage", { damage: weaponDamageDetail(w) }),
    i18n(locale, "info.weaponHeat", { heat: w.heat ?? 0 }),
  ];
  if (w.missiles !== undefined)
    lines.push(i18n(locale, "info.weaponMissiles", { count: w.missiles }));
  if (w.pulse) lines.push(i18n(locale, "info.weaponPulse"));
  if (w.rapidFireShots !== undefined)
    lines.push(i18n(locale, "info.weaponRapidFire", { shots: w.rapidFireShots }));
  if (w.antiInfantry) lines.push(i18n(locale, "info.weaponAntiInfantry"));
  return lines;
}

/** `info map <name>` output: header/legend lines followed by the styled grid. */
export function infoMapChunks(locale: LocaleId, name: string): Chunk[] {
  const map = lookupMap(name);
  if (map === undefined) {
    throw new Error(i18n(locale, "err.unknownMap", { name, list: listMapNames().join(", ") }));
  }
  return [
    buildLinesChunk([i18n(locale, "info.mapHead", { name, w: map.width, h: map.height })]),
    buildBoardChunk({ map, units: null, reachable: null, locale }),
  ];
}

function requireMechDef(model: string, locale: LocaleId): ResolvedMechDef {
  const def = lookupMech(model);
  if (def === undefined) {
    throw new Error(i18n(locale, "err.unknownModel", { model }));
  }
  return def;
}

// --------------------------------------------------------------- sheet ----

/** Per-mount presentation info used by sheet and mech-info weapon rows. */
export type WeaponMountInfo = {
  readonly weapon: string;
  readonly location: Location;
  readonly shotsLeft: number | null;
  readonly shotsMax: number | null;
  /**
   * 1-based display index of the leader mount for this weapon's shared ammo
   * pool, when this mount is a trailing follower. `undefined` for leaders and
   * for mounts with no shared pool.
   */
  readonly shotsSharedWith: number | null;
  readonly jammed: boolean;
  readonly destroyed: boolean;
};

interface SheetView {
  readonly id: string;
  readonly team: number;
  readonly model: string;
  readonly name: string;
  readonly weightClass: string;
  readonly tonnage: number;
  readonly gunnery: number | null;
  readonly piloting: number | null;
  readonly pilotHits: number;
  readonly prone: boolean;
  readonly unconscious: boolean;
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  readonly removed: RemovedState;
  readonly destroyed: DestroyedState;
  readonly positionLine: string;
  /** Current ammo status: depletion policy, explosion prob; null when the unit carries no ammo. */
  readonly ammoStatusLine: string | null;
  /** Current heat + shutdown state; null when only design info exists. */
  readonly heat: number;
  readonly dissipMax: number;
  readonly dissipCurr: number;
  readonly engineHit: number;
  readonly gyroHit: number;
  readonly sensorHit: number;
  readonly lifeHit: number;
  readonly shutdown: ShutdownState;
  /** Current front armor per location. */
  readonly armor: LocationValue;
  /** Current layered damage (front armor, rear armor, internal structure). */
  readonly damage: UnitDamageState;
  /** Designed (start-of-game) front armor per location. */
  readonly originalArmor: Readonly<LocationValue>;
  /** Designed (start-of-game) rear torso armor. */
  readonly originalArmorRear: Partial<LocationValue>;
  /** Designed (start-of-game) internal structure per location. */
  readonly originalArmorStructure: LocationValue;
  readonly mounts: readonly WeaponMountInfo[];
  /** Per-unit live crit state for the crit chart; null when only design info exists. */
  readonly critLive: CritChartLive | null;
  /** Aggregate engine/gyro/sensors/life-support counts (destroyed/total); null when only design info exists. */
  readonly critCounts: CoreComponentStatus | null;
}

function battleSheet(unit: UnitState, id: string, locale: LocaleId): SheetView {
  // Engine guarantee: `unit.model` was validated by `createBattle`.
  const def = getMechDefFor(unit);
  let ammoStatusLine: string | null = null;
  if (collectAmmoBins(def).length > 0) {
    const { avoid, threshold } = ammoExplosionAvoidWithThreshold(unit.heat);
    ammoStatusLine = i18n(locale, "sheet.ammoStatus", {
      policy: ammoPolicyLabel(locale, unit.ammoPolicy),
      explosion:
        avoid === 0
          ? i18n(locale, "sheet.ammoNoExplosion", {
              heat: unit.heat,
              threshold: AMMO_EXPLOSION_START_HEAT,
            })
          : i18n(locale, "sheet.ammoExplosion", { heat: unit.heat, avoid, threshold }),
    });
  }
  const ccStatus = coreComponentStatus(def, unit.critSlotsDestroyed);
  return {
    id: id,
    team: unit.team,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    piloting: unit.piloting,
    pilotHits: unit.pilotHits,
    prone: unit.prone,
    unconscious: unit.unconscious,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    removed: unit.removed,
    destroyed: unit.destroyed,
    positionLine: i18n(locale, "sheet.at", {
      pos: disp(unit.position),
      facing: F(locale, unit.facing),
      posture: PRN(locale, unit.prone),
    }),
    ammoStatusLine: ammoStatusLine,
    heat: unit.heat,
    dissipCurr: heatDissipation(def, unit.critSlotsDestroyed),
    dissipMax: heatDissipationMax(def),
    engineHit: ccStatus.engine,
    gyroHit: ccStatus.gyro,
    sensorHit: ccStatus.sensors,
    lifeHit: ccStatus.lifeSupport,
    shutdown: unit.shutdown,
    armor: unit.damage.armor,
    damage: unit.damage,
    originalArmor: def.armor,
    originalArmorRear: def.armorRear,
    originalArmorStructure: def.internalStructure,
    mounts: buildMountInfos(def, unit.ammoBins, (key) => {
      const mount = def.weapons[key];
      return {
        jammed: unit.jammedWeapons.includes(key),
        destroyed:
          unit.destroyedWeapons.includes(key) ||
          (mount !== undefined && !canFireFromLocation(unit.phaseStartDamage, mount.location)),
      };
    }),
    critLive: {
      critSlotsDestroyed: unit.critSlotsDestroyed,
      destroyedWeapons: unit.destroyedWeapons,
      jammedWeapons: unit.jammedWeapons,
      ammoBins: unit.ammoBins,
      locationDestroyed: (loc) => unit.phaseStartDamage.internalStructure[loc] <= 0,
    },
    critCounts: coreComponentStatus(def, unit.critSlotsDestroyed),
  };
}

const SHORT_LOC: Readonly<Record<Location, string>> = {
  head: "HD",
  centerTorso: "CT",
  rightTorso: "RT",
  leftTorso: "LT",
  rightArm: "RA",
  leftArm: "LA",
  rightLeg: "RL",
  leftLeg: "LL",
};

interface ArmorInfo {
  readonly armor: LocationValue;
  readonly armorRear: Partial<LocationValue>;
  readonly internalStructure: LocationValue;
  readonly originalArmor: Readonly<LocationValue>;
  readonly originalArmorRear: Partial<LocationValue>;
  readonly originalStructure: LocationValue;
  readonly dissipMax: number;
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'info mech <model>' command */
function armorDiagramInfo(info: ArmorInfo): string[] {
  const cell = (max: number, label: string) => ` ${String(max).padStart(2)}${label}`;
  const o = info.originalArmor;
  const os = info.originalStructure;
  const or = info.originalArmorRear;
  const rear = (loc: Location) => cell(or[loc] ?? 0, "R");
  const hs = `-${info.dissipMax} `.padStart(4);
  return [
    `          [HD]      [HS]`,
    `          ${cell(os.head, "I")}      ${hs}`,
    `          ${cell(o.head, "A")}`,
    `     [RT] [CT] [LT]`,
    [
      "[RA]",
      cell(os.rightTorso, "I"),
      cell(os.centerTorso, "I"),
      cell(os.leftTorso, "I"),
      "[LA]",
    ].join(" "),
    [
      cell(os.rightArm, "I"),
      cell(o.rightTorso, "F"),
      cell(o.centerTorso, "F"),
      cell(o.leftTorso, "F"),
      cell(os.leftArm, "I"),
    ].join(" "),
    [
      cell(o.rightArm, "A"),
      rear("rightTorso"),
      rear("centerTorso"),
      rear("leftTorso"),
      cell(o.leftArm, "A"),
    ].join(" "),
    `     [RL]      [LL]`,
    `     ${cell(os.rightLeg, "I")}      ${cell(os.leftLeg, "I")}`,
    `     ${cell(o.rightLeg, "A")}      ${cell(o.leftLeg, "A")}`,
  ];
}

function shutdownHeader(view: SheetView): string {
  if (isUnitDestroyed(view.damage)) return "[DESTROYED]";
  switch (view.shutdown) {
    case "manual":
      return "[SHUTDOWN]";
    case "heat":
      return "!SHUTDOWN!";
    case "starting":
      return "[STARTING]";
  }
  if (isUnitImmobile(view.damage)) return "[IMMOBILE]";
  return "[NOMINAL]";
}

// E:#-- L:-
// G:-- S:--
const GLYPH_CORE_COMPONENT_HIT = "#";
const GLYPH_CORE_COMPONENT_UNHIT = "-";

function engineLifeSupport(view: SheetView): string {
  const e = GLYPH_CORE_COMPONENT_HIT.repeat(view.engineHit).padEnd(
    ENGINE_SLOTS_KILL,
    GLYPH_CORE_COMPONENT_UNHIT,
  );
  const l = view.lifeHit > 0 ? GLYPH_CORE_COMPONENT_HIT : GLYPH_CORE_COMPONENT_UNHIT;
  return `E:${e} L:${l}`;
}

function gyroSensors(view: SheetView): string {
  const g = GLYPH_CORE_COMPONENT_HIT.repeat(view.gyroHit).padEnd(
    GYRO_DESTROYED_HITS,
    GLYPH_CORE_COMPONENT_UNHIT,
  );
  const s = GLYPH_CORE_COMPONENT_HIT.repeat(view.sensorHit).padEnd(
    SENSOR_BLIND_HITS,
    GLYPH_CORE_COMPONENT_UNHIT,
  );
  return `G:${g} S:${s}`;
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'sheet <id>' command */
function armorDiagramSheet(view: SheetView): string[] {
  const cell = (val: number, max: number, label: string) =>
    `${String(val).padStart(2)}/${String(max).padStart(2)}${label}`;
  const p = (n: number) => " ".repeat(n);
  const CT = 14,
    RT = 7;
  const a = view.armor;
  const o = view.originalArmor;
  const s = view.damage.internalStructure;
  const os = view.originalArmorStructure;
  const ar = view.damage.armorRear;
  const or = view.originalArmorRear;
  const rear = (loc: Location) => cell(ar[loc] ?? 0, or[loc] ?? 0, "R");
  const pRT = p(RT);
  const statusHeader = shutdownHeader(view).padEnd(CT);
  const heatHeader = "[HEAT]".padStart(CT);
  const heat = cell(view.heat, HEAT_CAP, " ").padStart(CT);
  const dissip = cell(-view.dissipCurr, view.dissipMax, " ").padStart(CT);
  const el = engineLifeSupport(view).padEnd(CT);
  const gs = gyroSensors(view).padEnd(CT);
  return [
    `${statusHeader}[ HD ]${heatHeader}`,
    `${el}${cell(s.head, os.head, "I")}${heat}`,
    `${gs}${cell(a.head, o.head, "A")}${dissip}`,
    `       [ RT ] [ CT ] [ LT ]`,
    [
      "[ RA ]",
      cell(s.rightTorso, os.rightTorso, "I"),
      cell(s.centerTorso, os.centerTorso, "I"),
      cell(s.leftTorso, os.leftTorso, "I"),
      "[ LA ]",
    ].join(" "),
    [
      cell(s.rightArm, os.rightArm, "I"),
      cell(a.rightTorso, o.rightTorso, "F"),
      cell(a.centerTorso, o.centerTorso, "F"),
      cell(a.leftTorso, o.leftTorso, "F"),
      cell(s.leftArm, os.leftArm, "I"),
    ].join(" "),
    [
      cell(a.rightArm, o.rightArm, "A"),
      rear("rightTorso"),
      rear("centerTorso"),
      rear("leftTorso"),
      cell(a.leftArm, o.leftArm, "A"),
    ].join(" "),
    `${pRT}[ RL ]        [ LL ]`,
    `${pRT}${cell(s.rightLeg, os.rightLeg, "I")}        ${cell(s.leftLeg, os.leftLeg, "I")}`,
    `${pRT}${cell(a.rightLeg, o.rightLeg, "A")}        ${cell(a.leftLeg, o.leftLeg, "A")}`,
  ];
}

// ------------------------------------------------------- crit slot chart ----

/** Per-unit live crit state shown per slot on the `sheet <id>` chart. */
interface CritChartLive {
  readonly critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>;
  readonly destroyedWeapons: readonly number[];
  readonly jammedWeapons: readonly number[];
  /** Per-crit-slot ammo state (identity + remaining shots). */
  readonly ammoBins: Readonly<AmmoBins>;
  /** Location destroyed by damage (phase-start internal structure at 0). */
  readonly locationDestroyed: (location: Location) => boolean;
}

/** i18n key per ammo depletion policy. */
const AMMO_POLICY_KEY: Readonly<Record<AmmoPolicy, MessageKey>> = {
  exposed: "ammo.policy.exposed",
  core: "ammo.policy.core",
  spread: "ammo.policy.spread",
  leastFirst: "ammo.policy.leastFirst",
};

/** Human-friendly i18n label for an ammo depletion policy. */
export function ammoPolicyLabel(locale: LocaleId, policy: AmmoPolicy): string {
  return i18n(locale, AMMO_POLICY_KEY[policy]);
}

/** Human-friendly i18n key for a structure component name. */
const CRIT_COMPONENT_KEY: Readonly<Record<CritStructureName, MessageKey>> = {
  cockpit: "critChart.component.cockpit",
  sensors: "critChart.component.sensors",
  lifeSupport: "critChart.component.lifeSupport",
  engine: "critChart.component.engine",
  gyro: "critChart.component.gyro",
  heatSink: "critChart.component.heatSink",
  doubleHeatSink: "critChart.component.doubleHeatSink",
  jumpJet: "critChart.component.jumpJet",
  shoulder: "critChart.component.shoulder",
  upperArmActuator: "critChart.component.upperArmActuator",
  lowerArmActuator: "critChart.component.lowerArmActuator",
  handActuator: "critChart.component.handActuator",
  upperLegActuator: "critChart.component.upperLegActuator",
  lowerLegActuator: "critChart.component.lowerLegActuator",
  footActuator: "critChart.component.footActuator",
  hip: "critChart.component.hip",
  targetingComputer: "critChart.component.targetingComputer",
};

/** Human-friendly i18n key for a soak (armor-tech) component name. */
const CRIT_SOAK_KEY: Readonly<Record<CritSoakName, MessageKey>> = {
  endoSteel: "critChart.soak.endoSteel",
  ferroFibrous: "critChart.soak.ferroFibrous",
  case: "critChart.soak.case",
  caseII: "critChart.soak.caseII",
};

/** One slot line: dice number + component label, plus live markers. */
function critSlotText(
  def: ResolvedMechDef,
  loc: Location,
  slotIndex: number,
  locale: LocaleId,
  live: CritChartLive | null,
): string {
  const slot = def.critSlots[loc][slotIndex - 1] ?? { kind: "empty" };
  const dice = slotIndex.toString().padStart(2);
  const markers: string[] = [];
  let body: string;
  if (slot.kind === "empty") {
    body = i18n(locale, "critChart.empty");
  } else if (slot.kind === "soak") {
    const key = CRIT_SOAK_KEY[slot.name];
    body = `(${key !== undefined ? i18n(locale, key) : slot.name})`;
  } else if (slot.kind === "weapon") {
    body = slot.weapon;
  } else if (slot.kind === "ammo") {
    body = slot.weapon;
    const binId = ammoBinId(loc, slotIndex);
    const max = loadAmmoBins(def)[binId]?.shots;
    if (max !== undefined) {
      const curr = live !== null ? (live.ammoBins[binId]?.shots ?? max) : max;
      markers.push(
        live === null
          ? i18n(locale, "critChart.ammoDesign", { max })
          : i18n(locale, "critChart.ammoSuffix", { curr, max }),
      );
    }
  } else {
    const key = CRIT_COMPONENT_KEY[slot.name as CritStructureName];
    body = key !== undefined ? i18n(locale, key) : slot.name;
  }
  const line = ` ${dice} ${body}`;
  if (live !== null && live.critSlotsDestroyed[loc] !== undefined) {
    const slotHit = live.critSlotsDestroyed[loc]?.[slotIndex - 1] ?? false;
    const mountDestroyed =
      slot.kind === "weapon" && live.destroyedWeapons.includes(slot.weaponIndex);
    const mountJammed = slot.kind === "weapon" && live.jammedWeapons.includes(slot.weaponIndex);
    // A location whose internal structure is gone has every slot in it
    // destroyed, even when no crit roll marked them (matches the mount list).
    const locationGone = slot.kind !== "empty" && live.locationDestroyed(loc);
    if (mountJammed) markers.push(i18n(locale, "critChart.jammedSuffix"));
    if (slotHit || mountDestroyed || locationGone) {
      markers.push(i18n(locale, "critChart.destroyedSuffix"));
    }
  }
  return markers.length > 0 ? `${line}${markers.join("")}` : line;
}

function critCountLine(
  locale: LocaleId,
  comp: CritStructureName,
  hit: number,
  messageForHit: MessageKey[],
): string {
  const maxHit = messageForHit.length;
  const effectiveHit = Math.min(hit, maxHit);
  const effect = effectiveHit === 0 ? "" : `: ${i18n(locale, messageForHit[effectiveHit - 1]!)}`;

  return i18n(locale, "critChart.coreComponent", {
    name: i18n(locale, CRIT_COMPONENT_KEY[comp]),
    hit: effectiveHit,
    total: maxHit,
    effect,
  });
}

function critCountLines(locale: LocaleId, counts: CoreComponentStatus | null): string[] {
  const out: string[] = new Array<string>(7).fill("");
  if (counts !== null) {
    out[1] = critCountLine(locale, "engine", counts.engine, [
      "critChart.coreComponentEffect.engine1",
      "critChart.coreComponentEffect.engine2",
      "critChart.coreComponentEffect.engine3",
    ]);
    out[2] = critCountLine(locale, "gyro", counts.gyro, [
      "critChart.coreComponentEffect.gyro1",
      "critChart.coreComponentEffect.gyro2",
    ]);
    out[3] = critCountLine(locale, "sensors", counts.sensors, [
      "critChart.coreComponentEffect.sensor1",
      "critChart.coreComponentEffect.sensor2",
    ]);
    out[4] = critCountLine(locale, "lifeSupport", counts.lifeSupport, [
      "critChart.coreComponentEffect.lifeSupport1",
    ]);
  }
  return out;
}

/** Render one location's crit slots as a vertical column (unpadded). */
function critCell(
  def: ResolvedMechDef,
  loc: Location,
  locale: LocaleId,
  live: CritChartLive | null,
): string[] {
  const lines = [`[ ${SHORT_LOC[loc]} ]`];
  for (let i = 0; i < def.critSlots[loc].length; i++) {
    lines.push(critSlotText(def, loc, i + 1, locale, live));
  }
  return lines;
}

const GRID_THEME = {
  LIGHT: {
    tnw: "┌", // top left corner of grid
    tn: "┬", // separator for top line of grid
    tne: "┐", // top right corner of grid
    tw: "├", // left end of bottom line of grid
    tc: "┼", // seperator for bottom line of grid
    te: "┤", // right end of bottom line of grid
    tsw: "└", // bottom left corner of grid
    ts: "┴", // separator for bottom line of grid
    tse: "┘", // bottom right corner of grid

    th: "─", // horizontal line of grid
    tv: "│", // vertical line of grid
  },
};

/** Collapsible crit chart: one columns chunk per row (arena / torso / legs). */
function critChartChunk(
  def: ResolvedMechDef,
  locale: LocaleId,
  live: CritChartLive | null,
  counts: CoreComponentStatus | null,
): Chunk {
  const { tnw, tn, tne, tw, tc, te, tsw, /*ts,*/ tse, th, tv } = GRID_THEME.LIGHT;
  const raLines = critCell(def, "rightArm", locale, live);
  const hdLines = [...critCell(def, "head", locale, live), ...new Array<string>(6).fill("")];
  const laLines = critCell(def, "leftArm", locale, live);
  const rtLines = critCell(def, "rightTorso", locale, live);
  const ctLines = critCell(def, "centerTorso", locale, live);
  const ltLines = critCell(def, "leftTorso", locale, live);
  const rlLines = critCell(def, "rightLeg", locale, live);
  // const infoLines = new Array<string>(7).fill("");
  const infoLines = critCountLines(locale, counts);
  const llLines = critCell(def, "leftLeg", locale, live);
  const built = [raLines, hdLines, laLines, rtLines, ctLines, ltLines, rlLines, infoLines, llLines];
  const maxLineLen = built
    .flat()
    .map((l) => getCompensatedLength(l))
    .reduce((prev, curr) => (prev > curr ? prev : curr));
  const horzLine = th.repeat(maxLineLen);
  const tvPrefix = (l: string) => tv + l;
  return buildCollapsibleChunk(i18n(locale, "critChart.summary"), [
    buildColumnsChunk([
      [`${tnw}${horzLine}`, ...raLines.map(tvPrefix)],
      [`${tn}${horzLine}`, ...hdLines.map(tvPrefix)],
      [`${tn}${horzLine}`, ...laLines.map(tvPrefix)],
      [tne, ...new Array<string>(13).fill(tv)],
    ]),
    buildColumnsChunk([
      [`${tw}${horzLine}`, ...rtLines.map(tvPrefix)],
      [`${tc}${horzLine}`, ...ctLines.map(tvPrefix)],
      [`${tc}${horzLine}`, ...ltLines.map(tvPrefix)],
      [te, ...new Array<string>(13).fill(tv)],
    ]),
    buildColumnsChunk([
      [`${tw}${horzLine}`, ...rlLines.map(tvPrefix), `${tsw}${horzLine}`],
      [`${tc}${horzLine}`, ...infoLines.map(tvPrefix), tse],
      [`${tc}${horzLine}`, ...llLines.map(tvPrefix), `${tsw}${horzLine}`],
      [te, ...new Array<string>(7).fill(tv), tse],
    ]),
  ]);
}

const REMOVAL_REASON_KEY: Readonly<Record<RemovalReason, MessageKey>> = {
  destroyed: "sheet.remove.destroyed",
  pilotEjected: "sheet.remove.pilotEjected",
  pilotKilled: "sheet.remove.pilotKilled",
};
const DESTROYED_REASON_KEY: Readonly<Record<DestroyedReason, MessageKey>> = {
  headDestroyed: "sheet.remove.hdDestroyed",
  centerTorsoDestroyed: "sheet.remove.ctDestroyed",
  cockpitDestroyed: "sheet.remove.cockpitDestroyed",
  headBlownOff: "sheet.remove.hdBlownOff",
  engineDestroyed: "sheet.remove.engineDestroyed",
};

function sheetIdLine(locale: LocaleId, view: SheetView): string {
  if (view.removed === "not") return i18n(locale, "sheet.idLine", { id: view.id, team: view.team });
  if (view.removed === "destroyed" && view.destroyed !== "not") {
    return `${i18n(locale, "sheet.idLine", { id: view.id, team: view.team })}${i18n(locale, "sheet.removedId", { reason: i18n(locale, DESTROYED_REASON_KEY[view.destroyed]) })}`;
  }
  return `${i18n(locale, "sheet.idLine", { id: view.id, team: view.team })}${i18n(locale, "sheet.removedId", { reason: i18n(locale, REMOVAL_REASON_KEY[view.removed]) })}`;
}

function sheetMovementLine(locale: LocaleId, view: SheetView): string {
  const { penalty, threshold } = movementMpPenaltyWithThreshold(view.heat);
  if (penalty > 0) {
    return i18n(locale, "info.movementHeat", {
      walk: view.walking,
      run: view.running,
      jump: view.jumping,
      penalty,
      threshold,
    });
  }
  return i18n(locale, "info.movement", {
    walk: view.walking,
    run: view.running,
    jump: view.jumping,
  });
}

/** Record sheet with armor status per location, side-by-side with ASCII diagram. */
export function sheetLines(view: SheetView, locale: LocaleId): Chunk[] {
  const topLines = [
    i18n(locale, "sheet.modelLine", {
      model: view.model,
      name: view.name,
      weightClass: view.weightClass,
      tonnage: view.tonnage,
    }),
  ];
  if (view.gunnery !== null) topLines.push(sheetGunneryLine(locale, view));
  if (view.piloting !== null) topLines.push(sheetPilotLine(locale, view));
  topLines.push(sheetMovementLine(locale, view));
  topLines.push(view.positionLine);
  if (view.ammoStatusLine !== null) topLines.push(view.ammoStatusLine);
  const weaponLines: string[] = [i18n(locale, "sheet.weaponsHeader", { n: view.mounts.length })];
  weaponLines.push(...weaponMountLines(locale, view.mounts));
  return [
    buildHeaderTableChunkFromColumns(
      [sheetIdLine(locale, view), i18n(locale, "info.armorStructureCol")],
      mergeDiagramToColumns(topLines, weaponLines, armorDiagramSheet(view)),
    ),
    critChartChunk(requireMechDef(view.model, locale), locale, view.critLive, view.critCounts),
  ];
}

function mergeDiagramToColumns(
  topLines: string[],
  weaponLines: string[],
  diagram: string[],
): (readonly string[])[] {
  const leftLineCount = topLines.length + weaponLines.length;
  const rightLineCount = diagram.length;
  if (leftLineCount > rightLineCount) {
    const lineDiff = leftLineCount - rightLineCount;
    const topPad = Math.floor(lineDiff / 2);
    return [
      [...topLines, ...weaponLines],
      [...new Array(topPad).fill(""), ...diagram, ...new Array(lineDiff - topPad).fill("")],
    ];
  }
  if (leftLineCount < rightLineCount) {
    return [
      [...topLines, ...new Array(rightLineCount - leftLineCount).fill(""), ...weaponLines],
      diagram,
    ];
  }
  return [[...topLines, ...weaponLines], diagram];
}

export function sheetForUnit(s: Session, id: string): Chunk[] {
  if (s.battle) {
    const unit = s.battle.units[id];
    const locale = s.locale;
    if (!unit) throw new Error(i18n(locale, "err.unknownUnitId", { id }));
    return sheetLines(battleSheet(unit, id, locale), locale);
  }
  return [];
}

/** Brief unit list grouped by team: id, model, position with facing. */
export function unitBriefList(s: Session): string[] {
  const battle = s.battle;
  if (!battle) return [];
  const lines: string[] = [];
  const teams = [...new Set(Object.values(battle.units).map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(i18n(s.locale, "setup.teamHeader", { team }));
    for (const [uid, unit] of Object.entries(battle.units).filter(([, u]) => u.team === team)) {
      // Engine guarantee: `unit.model` was validated by `createBattle`.
      const def = getMechDefFor(unit);
      const flags = `${unit.prone ? " PRONE" : ""}${unit.unconscious ? " UNCONSCIOUS" : ""}`;
      lines.push(`  ${uid}  ${def.model}  ${disp(unit.position)} facing ${unit.facing}${flags}`);
      const view = battleSheet(unit, uid, s.locale);
      lines.push(...mechStatusLines(view, s.locale).map((l) => `    ${l}`));
    }
  }
  return lines;
}

// -------------------------------------------------------------- status ----

export function fmtSetupStatus(s: Session): string[] {
  const lines: string[] = [
    i18n(s.locale, "setup.mapLabel", { name: s.setup.mapName ?? i18n(s.locale, "setup.mapNone") }),
  ];
  const teams = [...new Set(s.setup.roster.map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(i18n(s.locale, "setup.teamHeader", { team }));
    for (const u of s.setup.roster.filter((x) => x.team === team)) {
      const def = requireMechDef(u.model, s.locale);
      lines.push(
        i18n(s.locale, "setup.unitLine", {
          id: u.id,
          model: u.model,
          name: def.name,
          gunnery: gunneryLabel(s.locale, u.gunnery),
          pos: disp(u.position),
          facing: u.facing,
        }),
      );
    }
  }
  if (teams.length === 0) lines.push(i18n(s.locale, "setup.noUnits"));
  return lines;
}

/** Full heat-scale status for one unit, driven by the `heat` CLI command. */
export function heatStatusLines(s: Session, id: string): string[] {
  const battle = s.battle;
  if (!battle) throw new Error(i18n(s.locale, "err.noBattle"));
  const unit = battle.units[id];
  if (!unit) throw new Error(i18n(s.locale, "err.unknownUnitId", { id }));
  const def = getMechDefFor(unit);
  const engineOut = countDestroyedEngine(def, unit.critSlotsDestroyed);
  const sinks = heatDissipation(def, unit.critSlotsDestroyed);
  const toHit = toHitHeatModifier(unit.heat);
  const mpPenalty = movementMpPenalty(unit.heat);
  const shutdown = shutdownAvoid(unit.heat);
  const ammo = ammoExplosionAvoid(unit.heat);

  const lines: string[] = [
    i18n(s.locale, "heat.title", { id, heat: unit.heat }),
    i18n(s.locale, "heat.sinks", { sinks, engineOut }),
  ];
  if (toHit > 0) lines.push(i18n(s.locale, "heat.toHit", { mod: toHit }));
  if (mpPenalty > 0) lines.push(i18n(s.locale, "heat.mp", { penalty: mpPenalty }));
  if (shutdown === null) lines.push(i18n(s.locale, "heat.shutdownSafe"));
  else lines.push(i18n(s.locale, "heat.shutdown", { avoid: shutdown }));
  if (ammo === null) lines.push(i18n(s.locale, "heat.ammoSafe"));
  else lines.push(i18n(s.locale, "heat.ammo", { avoid: ammo }));
  lines.push(heatStateLabel(s.locale, unit.shutdown));
  if (unit.heat >= 30) lines.push(i18n(s.locale, "heat.shutdownAuto"));
  return lines;
}

function heatStateLabel(locale: LocaleId, shutdown: ShutdownState): string {
  if (shutdown === "not") return i18n(locale, "heat.stateOnline");
  if (shutdown === "starting") return i18n(locale, "heat.stateStarting");
  return i18n(locale, "heat.stateDown");
}

function sheetGunneryLine(locale: LocaleId, view: SheetView): string {
  const { toHit, threshold } = toHitHeatModifierWithThreshold(view.heat);
  const gunnery = view.gunnery!;
  return toHit > 0
    ? i18n(locale, "sheet.gunneryLineHeat", {
        gunnery: gunneryLabel(locale, gunnery),
        toHit,
        threshold,
      })
    : i18n(locale, "sheet.gunneryLine", { gunnery: gunneryLabel(locale, gunnery) });
}

function sheetPilotLine(locale: LocaleId, view: SheetView): string {
  const killed = consciousnessTarget(view.pilotHits) === null;
  return i18n(locale, "sheet.pilotLine", {
    piloting: view.piloting!,
    hits: view.pilotHits,
    state: i18n(
      locale,
      killed ? "sheet.pilotKilled" : view.unconscious ? "sheet.pilotOut" : "sheet.pilotOk",
    ),
  });
}

export function sheetLinesShort(locale: LocaleId, view: SheetView): string[] {
  const head = i18n(locale, "sheet.modelLine", {
    model: view.model,
    name: view.name,
    weightClass: view.weightClass,
    tonnage: view.tonnage,
  });
  const lines = [head];
  if (view.gunnery !== null) lines.push(sheetGunneryLine(locale, view));
  if (view.piloting !== null) lines.push(sheetPilotLine(locale, view));
  lines.push(view.positionLine);
  lines.push(...mechStatusLines(view, locale));
  return lines;
}

/** One-line summary of each crit-affected component (engine/gyro/sensors/life-support). */
function critEffectLines(counts: CoreComponentStatus | null, locale: LocaleId): string[] {
  if (counts === null) return [];
  const out: string[] = [];
  if (counts.engine >= 1) {
    out.push(
      `  ${i18n(locale, "sheet.critEffect.engine", { destroyed: counts.engine, total: ENGINE_SLOTS_KILL })}`,
    );
  }
  if (counts.gyro >= 1) {
    const key =
      counts.gyro >= GYRO_DESTROYED_HITS
        ? "sheet.critEffect.gyroDestroyed"
        : "sheet.critEffect.gyroHit";
    out.push(
      `  ${i18n(locale, key, { destroyed: counts.gyro, total: GYRO_DESTROYED_HITS, mod: GYRO_HIT_MOD })}`,
    );
  }
  if (counts.sensors >= 1) {
    const key =
      counts.sensors >= SENSOR_BLIND_HITS
        ? "sheet.critEffect.sensorsBlind"
        : "sheet.critEffect.sensorsHit";
    out.push(`  ${i18n(locale, key, { destroyed: counts.sensors, total: SENSOR_BLIND_HITS })}`);
  }
  if (counts.lifeSupport >= 1) {
    out.push(`  ${i18n(locale, "sheet.critEffect.lifeSupport")}`);
  }
  return out;
}

/** Compact two-line armor summary: head+torso on line 1, limbs on line 2.
 * Each location shows front + rear + internal-structure summed as `cur/max`,
 * with `[-F]`/`[-R]`/`[-A]`/`[-I]` annotations for depleted pools. */
function mechStatusLines(view: SheetView, locale: LocaleId): string[] {
  const status = isUnitDestroyed(view.damage)
    ? i18n(locale, "sheet.statusDestroyed")
    : view.shutdown === "not"
      ? i18n(locale, "sheet.statusOnline")
      : view.shutdown === "starting"
        ? i18n(locale, "sheet.statusStarting")
        : i18n(locale, "sheet.statusShutdown");
  return [
    i18n(locale, "sheet.statusHeader", { status, currHeat: view.heat, maxHeat: HEAT_CAP }),
    `  ${durabilityFrag(view, "head")} ${durabilityFrag(view, "leftTorso")} ${durabilityFrag(view, "centerTorso")} ${durabilityFrag(view, "rightTorso")}`,
    `  ${durabilityFrag(view, "leftArm")} ${durabilityFrag(view, "rightArm")} ${durabilityFrag(view, "leftLeg")} ${durabilityFrag(view, "rightLeg")}`,
    ...critEffectLines(view.critCounts, locale),
  ];
}

function durabilityFrag(view: SheetView, loc: Location): string {
  const frontCur = view.armor[loc];
  const torso = isTorso(loc);
  const frontMax = view.originalArmor[loc];
  const structCur = view.damage.internalStructure[loc];
  const structMax = view.originalArmorStructure[loc];
  const rearCur = torso ? (view.damage.armorRear[loc] ?? 0) : 0;
  const rearMax = torso ? (view.originalArmorRear[loc] ?? 0) : 0;
  const cur = frontCur + rearCur + structCur;
  const max = frontMax + rearMax + structMax;

  // Build annotation from depleted pool letters
  let note = "";
  if (cur > 0) {
    if (torso) {
      if (frontCur <= 0) note += "F";
      if (rearCur <= 0) note += "R";
    } else {
      if (frontCur <= 0) note += "A";
    }
    if (structCur <= 0) note += "I";
    if (note.length > 0) note = `[-${note}]`;
  }

  return `${SHORT_LOC[loc]}(${cur}/${max}${note})`;
}

export function overStatusLines(s: Session): string[] {
  if (!s.battle || !s.over) return [];
  const lines: string[] = [];
  const teams = [...new Set(Object.values(s.battle.units).map((u) => u.team))].sort(
    (a, b) => a - b,
  );
  const locale = s.locale;
  for (const team of teams) {
    lines.push(i18n(locale, "setup.teamHeader", { team }));
    for (const [uid, unit] of Object.entries(s.battle.units).filter(([, u]) => u.team === team)) {
      const view = battleSheet(unit, uid, locale);
      lines.push(`  ${sheetIdLine(locale, view)}`);
      for (const line of sheetLinesShort(s.locale, view)) lines.push(`    ${line}`);
    }
  }
  return lines;
}

function queueActorViewStr(locale: LocaleId, av: ActorQueueActorView | undefined): string {
  if (av === undefined) return i18n(locale, "status.none");
  return i18n(locale, av.hasPriority ? "status.actorViewPriority" : "status.actorView", {
    id: av.id,
    team: av.team,
  });
}

/** Turn-order section for the `status` command: who acted, who is next, who
 *  remains. Appended to the phase-specific status lines. */
function actorOrderLines(s: Session): string[] {
  if (!s.battle) return [];
  const q = actorQueue(s.battle);
  const lines: string[] = [];
  const list = (ids: readonly ActorQueueActorView[]): string =>
    ids.length > 0
      ? ids.map((a) => queueActorViewStr(s.locale, a)).join(", ")
      : i18n(s.locale, "status.none");
  lines.push(i18n(s.locale, "status.orderHeader", { init: q.initiative ?? "-" }));
  lines.push(i18n(s.locale, "status.done", { ids: list(q.acted) }));
  lines.push(i18n(s.locale, "status.current", { id: queueActorViewStr(s.locale, q.pending[0]) }));
  lines.push(i18n(s.locale, "status.pendingAfter", { ids: list(q.pending.slice(1)) }));
  return lines;
}

export function stepResultFromLine(locale: LocaleId, s: Session): string {
  const actor = currentActor(s)!;
  return i18n(locale, "stepResult.from", {
    col: actor.position.col,
    row: actor.position.row,
    facing: F(locale, actor.facing),
    posture: PRN(locale, actor.prone),
  });
}

/** Header plus one line per path step, for `place` output. Costs come
 *  straight from `MovePathStep` (`baseMp` per step, `totalMp` cumulative);
 *  destination hexes are recomputed by walking fragments from the actor start
 *  (turns rotate the cursor, `F`/`J`/`P`/`U` go forward, `B` goes backward).
 *  Jump re-facing fragments cost 0 and render no line (landing facing rides
 *  in the header). */
export function stepResultLines(s: Session, landing: RevealedLanding): string[] {
  const locale = s.locale;
  const actor = currentActor(s)!;
  const path = landing.path;
  const last = path[path.length - 1];
  const m = s.move;
  const mode = m?.moveMode ?? null;
  const postureCost = mode === "prone" ? DROP_MP_COST : mode === "standup" ? STAND_MP_COST : 0;
  const locomotion =
    mode === "standup" || mode === "prone"
      ? (m?.postureMove ?? "walk")
      : mode === "turn"
        ? "walk"
        : (mode ?? "standStill");
  const lines = [
    i18n(locale, "ok.stepResult", {
      id: m?.actorId ?? "",
      mode: displayModeFor(s),
      col: landing.hex.col,
      row: landing.hex.row,
      facing: F(locale, landing.facing),
      posture: PRN(locale, actor.prone),
      spent: postureCost + (last?.totalMp ?? 0),
      budget: fullBudgetFor(s),
    }),
    stepResultFromLine(locale, s),
  ];
  const jumping = locomotion === "jump";
  let hex = { ...actor.position };
  let facing = actor.facing;
  for (const step of path) {
    const frag = step.fragment;
    if (frag === "R" || frag === "L") {
      facing = rotateFacing(facing, frag === "R" ? 1 : -1);
      if (!jumping) {
        lines.push(
          i18n(locale, "stepResult.turn", {
            dir: frag,
            facings: 1,
            mp: step.baseMp,
            perFacing: MP_PER_FACING_CHANGE,
          }),
        );
      }
      continue;
    }
    hex = neighbor(hex, frag === "B" ? oppositeFacing(facing) : facing);
    if (jumping) {
      lines.push(i18n(locale, "stepResult.jump", { col: hex.col, row: hex.row, mp: step.baseMp }));
    } else {
      lines.push(
        i18n(locale, "stepResult.enter", {
          type: locomotion === "walk" ? "walk" : "run",
          col: hex.col,
          row: hex.row,
          terrain: TRN(locale, step.terrain),
          surcharge: step.terrainSurcharge,
          climb: step.climbCost,
          levels: step.climbLevels,
          mp: step.baseMp,
        }),
      );
    }
  }
  return lines;
}

export function queuedMoveLines(s: Session): string[] {
  const locale = s.locale;
  const actor = currentActor(s)!;
  const landing = s.move?.placedLanding ?? null;
  if (landing === null) {
    return [
      i18n(locale, "ok.modeDeclared", {
        id: actor.id,
        mode: displayModeFor(s),
        budget: budgetFor(s),
      }),
      stepResultFromLine(locale, s),
    ];
  }
  return stepResultLines(s, landing);
}

export function moveStatusLines(s: Session): string[] {
  const lines: string[] = [];
  lines.push(...actorOrderLines(s));
  lines.push(i18n(s.locale, "moveStatus.headLine"));
  const mode = s.move?.moveMode ?? null;
  if (mode === null || mode === "shutdown" || mode === "startup" || mode === "eject") {
    lines.push(i18n(s.locale, "moveStatus.noMode"));
  } else {
    lines.push(...queuedMoveLines(s).map((l) => `  ${l}`));
  }
  return lines;
}

/**
 * Board render info of the reachable hex map for the declared mode, or null
 * when no reachable hexes exist. Every reachable (hex, facing) landing is
 * handed to `createBoardModel` (in the render layer), which crops the model
 * to the reachable bounding box and tints markers/edges with the actor team.
 * Raw `RevealedLanding.path` data is retained on the landing and rendered
 * by the `place`/`status` preview straight from the candidate.
 */
export function reachablesInfo(s: Session): BoardRenderReachableInfo | null {
  const actor = currentActor(s);
  const mode = s.move?.moveMode ?? null;
  if (
    !actor ||
    !s.battle ||
    mode === null ||
    mode === "shutdown" ||
    mode === "startup" ||
    mode === "eject"
  ) {
    return null;
  }
  // Engine guarantee: `actor.model` was validated by `createBattle`.
  const def = getMechDefFor(actor);
  const effMove = effectiveMovement(def, actor.critSlotsDestroyed);
  const heatPenalty = movementMpPenalty(actor.heat);
  // Posture-change modes share one budget: candidate assumes posture succeeds.
  // prone turn: drop first (1 MP) then in-place turns (walk + prone, 1 MP each).
  // prone pronestill: drop in place, no map. turn: in-place turns on walk budget.
  // pronestill: no map, `place` stays shut.
  // standup: stand first (2 MP) then chosen locomotion as standing unit.
  let locomotion: MoveMode;
  let proneFlag = actor.prone;
  let walking = Math.max(0, effMove.walking - heatPenalty);
  let running = Math.max(0, effMove.running - heatPenalty);
  let jumping = Math.max(0, effMove.jumping - heatPenalty);
  const postureMove = s.move?.postureMove ?? null;
  if (mode === "prone") {
    if ((postureMove ?? "walk") === "standStill") return null; // drop in place: no map
    locomotion = "walk";
    proneFlag = true;
    walking = Math.max(0, walking - DROP_MP_COST);
  } else if (mode === "turn") {
    locomotion = "walk";
    proneFlag = true;
  } else if (mode === "pronestill") {
    return null; // stay prone: no map, `place` stays shut
  } else if (mode === "standup") {
    locomotion = postureMove ?? "standStill";
    proneFlag = false;
    if (locomotion === "standStill") return null; // stand in place: no map, `place` stays shut
    if (locomotion === "walk") walking = Math.max(0, walking - STAND_MP_COST);
    else if (locomotion === "run") running = Math.max(0, running - STAND_MP_COST);
    else if (locomotion === "jump") jumping = Math.max(0, jumping - STAND_MP_COST);
    else walking = Math.max(0, walking - STAND_MP_COST);
  } else {
    locomotion = mode;
  }
  const landings = reachableLandings({ ...actor.position }, actor.facing, {
    mode: locomotion,
    walking,
    running,
    jumping,
    prone: proneFlag,
    grid: s.battle,
    team: actor.team,
    wreckAt: (hex: HexCoord): boolean => wreckAt(s.battle!, hex) !== undefined,
    occupantTeam: (hex: HexCoord): number | undefined => {
      for (const u of Object.values(s.battle!.units)) {
        if (isUnitRemoved(u)) continue;
        if (u.position.col === hex.col && u.position.row === hex.row) return u.team;
      }
      return undefined;
    },
  });
  return { team: actor.team, revealed: landings };
}

export function reachableChunk(
  locale: LocaleId,
  mapNameHolder: MapNameHolder,
  battle: BattleState,
  info: BoardRenderReachableInfo,
): Chunk {
  const map = getMapDefFor(mapNameHolder);
  const battleUnits = battle.units;
  const units = Object.values(battleUnits)
    .filter((u) => !isUnitRemoved(u))
    .map((u) => createBoardRenderUnit(u));
  const ejectedUnits = createEjectedBoardRenderUnits(battleUnits, battle.wrecks);
  if (ejectedUnits.length > 0) units.push(...ejectedUnits);
  return buildBoardChunk({ map, units, reachable: info, locale });
}

export function attackStatusLines(s: Session): string[] {
  const actor = currentActor(s);
  if (!actor || !s.battle)
    throw new Error(i18n(s.locale, "err.wrongPhase", { phase: "weaponAttack" }));
  const lines: string[] = [];
  lines.push(...actorOrderLines(s));
  lines.push(i18n(s.locale, "attackStatus.header"));
  const decls = s.attack?.fireDecls ?? [];
  if (decls.length === 0) {
    lines.push(i18n(s.locale, "attackStatus.none"));
    return lines;
  }
  // Engine guarantee: `actor.model` was validated by `createBattle`.
  const def = getMechDefFor(actor);
  for (const decl of decls) {
    const mount = def.weapons[decl.weaponIndex];
    const name = mount ? mount.weapon : `#${decl.weaponIndex}`;
    const rapid = mount ? getWeaponDefFor(mount).rapidFireShots : undefined;
    const suffix = decl.rapidFire && rapid !== undefined ? ` (rapid-fire x${rapid})` : "";
    lines.push(
      i18n(s.locale, "attackStatus.weapon", {
        weaponIndex: decl.weaponIndex,
        weaponName: name,
        targetId: decl.targetId,
        suffix,
      }),
    );
  }
  return lines;
}

const BRACKET_LABEL: Readonly<Record<RangeBracket, string>> = {
  short: "S",
  medium: "M",
  long: "L",
};

const BLOCKER_LABEL: Readonly<Record<FireBlockerReason, MessageKey>> = {
  jammed: "fireSuggestion.reason.jammed",
  destroyed: "fireSuggestion.reason.destroyed",
  outOfRange: "fireSuggestion.reason.outOfRange",
  outOfArc: "fireSuggestion.reason.outOfArc",
  noLos: "fireSuggestion.reason.noLos",
  outOfAmmo: "fireSuggestion.reason.outOfAmmo",
  autoMiss: "fireSuggestion.reason.autoMiss",
  prone: "fireSuggestion.reason.prone",
  noSensor: "fireSuggestion.reason.noSensor",
};

const ARC_LABEL: Readonly<Record<Arc, MessageKey>> = {
  front: "fireSuggestion.arc.front",
  rear: "fireSuggestion.arc.rear",
  leftSide: "fireSuggestion.arc.leftSide",
  rightSide: "fireSuggestion.arc.rightSide",
};

const TWIST_LABEL: Readonly<Record<Arc, MessageKey>> = {
  front: "fireSuggestion.twist.front",
  leftSide: "fireSuggestion.twist.left",
  rightSide: "fireSuggestion.twist.right",
  rear: "fireSuggestion.twist.front",
};

function fireWeaponTable(locale: LocaleId, weapons: readonly FireWeapon[]): Chunk {
  const header = [
    i18n(locale, "fireSuggestion.colIndex"),
    i18n(locale, "fireSuggestion.colWeapon"),
    i18n(locale, "fireSuggestion.colLoc"),
    i18n(locale, "fireSuggestion.colBracket"),
    i18n(locale, "fireSuggestion.colTn"),
    i18n(locale, "fireSuggestion.colHeat"),
    i18n(locale, "fireSuggestion.colDmg"),
    i18n(locale, "fireSuggestion.colShots"),
  ];
  const rows = weapons.map((w) => [
    `#${w.weaponIndex}`,
    w.weapon,
    SHORT_LOC[w.location],
    w.minRangePenalty !== undefined
      ? `[${BRACKET_LABEL[w.rangeBracket]}!]`
      : `[${BRACKET_LABEL[w.rangeBracket]}]`,
    w.minRangePenalty !== undefined
      ? `${w.tn - w.minRangePenalty}+${w.minRangePenalty}`
      : String(w.tn),
    String(w.heat),
    w.cluster !== undefined
      ? `${w.expectedDamage} (${i18n(locale, "fireSuggestion.cluster", {
          shots: String(w.cluster.shots),
          per: String(w.cluster.perMissile),
        })})`
      : String(w.expectedDamage),
    w.shots !== null ? `${w.shots}` : "",
  ]);
  return buildHeaderTableChunkFromRows(header, rows);
}

function blockedLines(
  locale: LocaleId,
  list: readonly { weaponIndex: number; weapon: string; reason: FireBlockerReason }[],
): string[] {
  return list.map(
    (b) =>
      `${i18n(locale, "fireSuggestion.blocked")}: #${b.weaponIndex} ${b.weapon} — ${i18n(locale, BLOCKER_LABEL[b.reason])}`,
  );
}

function blockedChunks(locale: LocaleId, list: ReturnType<typeof blockedLines>): Chunk[] {
  if (list.length === 0) return [];
  if (list.length > 3) {
    return [
      buildCollapsibleChunk(i18n(locale, "fireSuggestion.blockedSummary", { num: list.length }), [
        buildLinesChunk(list, "hint"),
      ]),
    ];
  }
  return [buildLinesChunk(list, "hint")];
}

export function fireSuggestionChunks(
  locale: LocaleId,
  sugg: FireSuggestion,
  twist: Arc | null = null,
): Chunk[] {
  const chunks: Chunk[] = [
    buildLinesChunk([i18n(locale, "fireSuggestion.header", { id: sugg.targetId })], "hint"),
  ];
  if (twist !== null) {
    chunks.push(
      buildLinesChunk(
        [i18n(locale, "fireSuggestion.twist", { dir: i18n(locale, TWIST_LABEL[twist]) })],
        "hint",
      ),
    );
  }
  if (sugg.targets.length === 0) {
    chunks.push(buildLinesChunk([i18n(locale, "fireSuggestion.noTargets")], "hint"));
    return chunks;
  }
  for (const target of sugg.targets) {
    chunks.push(
      buildLinesChunk(
        [
          i18n(locale, "fireSuggestion.target", {
            id: target.targetId,
            distance: String(target.distance),
            arc: target.arc !== null ? i18n(locale, ARC_LABEL[target.arc]) : "—",
          }),
        ],
        "hint",
      ),
    );
    const split =
      target.weaponsIfPropLeft.length !== target.weaponsIfPropRight.length ||
      target.weaponsIfPropLeft.some(
        (w, i) => w.weaponIndex !== target.weaponsIfPropRight[i]?.weaponIndex,
      ) ||
      target.blockedIfPropLeft.length !== target.blockedIfPropRight.length;
    if (split) {
      chunks.push(
        buildLinesChunk(
          [i18n(locale, "fireSuggestion.propLeft", { num: target.weaponsIfPropLeft.length })],
          "hint",
        ),
      );
      if (target.weaponsIfPropLeft.length > 0) {
        chunks.push(fireWeaponTable(locale, target.weaponsIfPropLeft));
      }
      chunks.push(...blockedChunks(locale, blockedLines(locale, target.blockedIfPropLeft)));
      chunks.push(
        buildLinesChunk(
          [i18n(locale, "fireSuggestion.propRight", { num: target.weaponsIfPropRight.length })],
          "hint",
        ),
      );
      if (target.weaponsIfPropRight.length > 0) {
        chunks.push(fireWeaponTable(locale, target.weaponsIfPropRight));
      }
      chunks.push(...blockedChunks(locale, blockedLines(locale, target.blockedIfPropRight)));
      continue;
    }
    if (target.weapons.length > 0) {
      chunks.push(fireWeaponTable(locale, target.weapons));
    }
    chunks.push(...blockedChunks(locale, blockedLines(locale, target.blocked)));
  }
  return chunks;
}

// ------------------------------------------------------------------ log ----
export function formatLog(
  locale: LocaleId,
  events: readonly GameEvent[],
  n: number = events.length,
): string[] {
  const slice = events.slice(-n);
  if (slice.length === 0) return [];
  const lines: string[] = [];
  let prev: GameEvent | null = null;
  let removedLines: string[] = [];
  let lastUnitPrefix: string = "";
  const onEnterEvent = (prev: GameEvent | null, curr: GameEvent): void => {
    if (isAttackResolutionKind(curr.kind)) {
      if (prev === null || !isAttackResolutionKind(prev.kind)) {
        lines.push(i18n(locale, "res.attackResolutionStart"));
      }
    }
  };
  const onEvent = (event: GameEvent): void => {
    const el = eventLines(locale, event);
    if (isAttackResolutionKind(event.kind)) {
      switch (event.kind) {
        case "unitRemoved":
          removedLines.push(...el);
          return;
        case "attackResolved":
          {
            const unitPrefix = `[${event.unitId} -> ${event.targetId}]`;
            if (lastUnitPrefix !== unitPrefix) {
              lines.push(unitPrefix);
              lastUnitPrefix = unitPrefix;
            }
            lines.push(`  ${el.shift()}`);
            if (el.length > 0) {
              lines.push(...el.map((l) => `    ${l}`));
            }
          }
          return;
        case "heatWeapon":
          lines.push(...el.map((l) => `    ${l}`));
          return;
      }
    }
    lines.push(...el);
  };
  const onExitEvent = (curr: GameEvent, next: GameEvent | null): void => {
    if (isAttackResolutionKind(curr.kind)) {
      if (next === null || !isAttackResolutionKind(next.kind)) {
        lines.push(i18n(locale, "res.attackResolutionEnd"));
        if (removedLines.length > 0) {
          lines.push(...removedLines);
          removedLines = [];
        }
      }
    }
  };
  for (let i = 0; i < slice.length; i++) {
    const e = slice[i]!;
    const prevKind: GameEvent["kind"] | null = prev === null ? null : prev.kind;
    const currKind = e.kind;

    if (prevKind !== currKind) {
      if (prev !== null) onExitEvent(prev, e);
      onEnterEvent(prev, e);
    }
    onEvent(e);
    prev = e;
  }
  onExitEvent(prev!, null);
  return lines;
}

function isAttackResolutionKind(kind: GameEvent["kind"] | null): boolean {
  return (
    kind === "attackResolved" ||
    kind === "unitDestroyed" ||
    kind === "unitRemoved" ||
    kind === "heatWeapon" ||
    kind === "buildingDamaged" ||
    kind === "collapseDamage"
  );
}

function phaseLines(locale: LocaleId, e: Extract<GameEvent, { kind: "phase" }>): string[] {
  const phaseLine = i18n(locale, "log.phase", { turn: e.turn, phase: e.phase });
  const len = getCompensatedLength(phaseLine);
  const separator = "-".repeat(len);
  return [" ", separator, phaseLine, separator, " "];
}

function eventLines(locale: LocaleId, e: GameEvent): string[] {
  switch (e.kind) {
    case "phase":
      return phaseLines(locale, e);
    case "initiative": {
      const rolls = Object.entries(e.rolls)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([team, roll]) => `team ${team} (2D6: ${roll})`)
        .join(", ");
      return [i18n(locale, "log.initiative", { rolls, winner: e.winnerTeam })];
    }
    case "moveDeclared":
      return [i18n(locale, "log.moveDeclared", { id: e.unitId, mode: e.mode })];
    case "moved":
      if (e.mode === "prone") {
        return [i18n(locale, "log.droppedProne", { id: e.unitId })];
      }
      if (e.prevMode === "prone") {
        return [i18n(locale, "log.stoodUp", { id: e.unitId })];
      }
      return [
        i18n(locale, "log.moved", {
          id: e.unitId,
          mode: e.mode,
          pos: disp(e.position),
          facing: e.facing,
          mp: e.mpSpent,
          budget: e.mpBudget,
        }),
      ];
    case "attacksDeclared":
      return [
        i18n(locale, e.count === 1 ? "log.attacksDeclaredOne" : "log.attacksDeclaredOther", {
          id: e.unitId,
          target: e.targetId,
          count: e.count,
          rangeCtx: `range ${e.distance} (${e.rangeBracket}, ${signedMod(e.rangeMod)})`,
        }),
      ];
    case "attackResolved":
      return resolutionLines(locale, e.resolution);
    case "unitDestroyed":
      return [i18n(locale, "log.destroyed", { id: e.unitId, destroyed: e.destroyed })];
    case "unitRemoved":
      if (e.reason === "pilotEjected") return [i18n(locale, "log.ejected", { id: e.unitId })];
      if (e.reason === "pilotKilled") return [i18n(locale, "log.pilotKilled", { id: e.unitId })];
      return [i18n(locale, "log.removedEvent", { id: e.unitId })];
    case "buildingCollapsed":
      return [i18n(locale, "log.buildingCollapsed", { hex: `${e.col},${e.row}` })];
    case "buildingDamaged":
      return [
        i18n(locale, "log.buildingDamaged", {
          hex: `${e.col},${e.row}`,
          damage: e.damage,
          cf: e.cf,
        }),
      ];
    case "collapseDamage":
      return [
        i18n(locale, "log.collapseDamage", {
          id: e.unitId,
          hex: `${e.col},${e.row}`,
          loc: SHORT_LOC[e.location],
          damage: e.damage,
        }),
      ];
    case "heatMove":
      return [i18n(locale, "log.heatMove", { id: e.unitId, heat: e.heat })];
    case "heatWeapon":
      return [
        i18n(locale, "log.heatWeapon", {
          id: e.unitId,
          weapon: e.weapon,
          heat: e.heat,
          prev: e.prevHeat,
          curr: e.currHeat,
        }),
      ];
    case "heatEngineCrit":
      return [
        i18n(locale, "log.heatEngineCrit", {
          id: e.unitId,
          heat: e.heat,
          prev: e.prevHeat,
          curr: e.currHeat,
        }),
      ];
    case "heatDissipated":
      return [
        i18n(locale, "log.heatDissipated", {
          id: e.unitId,
          dissip: e.dissip,
          prev: e.prevHeat,
          curr: e.currHeat,
          cap: e.capacity,
        }),
      ];
    case "shutdownCheck":
      if (e.manual) {
        return [i18n(locale, "log.shutdownManual", { id: e.unitId })];
      }
      if (e.avoided) {
        return [
          i18n(locale, "log.shutdownAvoided", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
            threshold: e.threshold,
          }),
        ];
      }
      if (e.avoid >= 12) {
        return [
          i18n(locale, "log.shutdownAuto", { id: e.unitId, heat: e.heat, threshold: e.threshold }),
        ];
      }
      return [
        i18n(locale, "log.shutdown", {
          id: e.unitId,
          roll: e.roll,
          heat: e.heat,
          avoid: e.avoid,
          threshold: e.threshold,
        }),
      ];
    case "restartCheck":
      if (e.manual && e.success) {
        return [
          i18n(locale, "log.startupSuccess", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
          }),
        ];
      }
      if (e.manual) {
        return [
          i18n(locale, "log.startupFailed", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
          }),
        ];
      }
      if (e.success && e.avoid === 0) {
        return [
          i18n(locale, "log.restartedNoCheck", {
            id: e.unitId,
            heat: e.heat,
            threshold: e.threshold,
          }),
        ];
      }
      if (e.success) {
        return [
          i18n(locale, "log.restarted", {
            id: e.unitId,
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
            threshold: e.threshold,
          }),
        ];
      }
      return [
        i18n(locale, "log.restartFailed", {
          id: e.unitId,
          roll: e.roll,
          heat: e.heat,
          avoid: e.avoid,
          threshold: e.threshold,
        }),
      ];
    case "ammoExplosionCheck":
      if (e.avoided) {
        return [
          i18n(locale, "log.ammoExplosionAvoided", {
            id: e.unitId,
            weapon: e.weapon,
            loc: SHORT_LOC[e.location],
            slot: String(e.slotIndex),
            roll: e.roll,
            heat: e.heat,
            avoid: e.avoid,
            threshold: e.threshold,
          }),
        ];
      }
      return [
        i18n(locale, "log.heatAmmoExplosion", {
          id: e.unitId,
          weapon: e.weapon,
          loc: SHORT_LOC[e.location],
          slot: String(e.slotIndex),
          roll: e.roll,
          heat: e.heat,
          avoid: e.avoid,
          threshold: e.threshold,
          shots: e.shotsRemaining,
          damage: e.damage,
        }),
      ];
    case "pilotingCheck": {
      const verdict = e.success ? i18n(locale, "log.psrSuccess") : i18n(locale, "log.psrFail");
      return [
        i18n(locale, "log.pilotingCheck", {
          id: e.unitId,
          reason: e.reason,
          target: e.target,
          roll: e.roll === null ? i18n(locale, "log.psrAuto") : String(e.roll),
          verdict,
        }),
      ];
    }
    case "unitFell": {
      const lines = [
        i18n(locale, "log.unitFell", {
          id: e.unitId,
          cause: e.cause,
          facing: e.facingAfter,
          groups: e.groups.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" "),
          damage: e.totalDamage,
          levels: e.levelsFallen,
        }),
      ];
      for (const crit of e.crits) {
        for (const line of critLines(locale, crit)) lines.push(`  ${line}`);
      }
      return lines;
    }
    case "pilotDamaged":
      return [
        i18n(locale, "log.pilotDamaged", { id: e.unitId, reason: e.reason, total: e.totalHits }),
      ];
    case "consciousnessCheck": {
      const { unitId, roll, target, success, consciousBefore } = e;
      if (consciousBefore && !success) {
        return [i18n(locale, "log.pilotUnconscious", { id: unitId, roll, target })];
      }
      if (!consciousBefore && success) {
        return [i18n(locale, "log.pilotRecovered", { id: unitId, roll, target })];
      }
      return [
        i18n(locale, success ? "log.consciousnessCheckSuccess" : "log.consciousnessCheckFail", {
          id: unitId,
          roll,
          target,
        }),
      ];
    }
    case "buildingCrash": {
      const lines = [
        i18n(locale, "log.buildingCrash", {
          id: e.unitId,
          hex: `${e.col},${e.row}`,
          groups: e.groups.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" "),
          damage: e.totalDamage,
        }),
      ];
      for (const crit of e.crits) {
        for (const line of critLines(locale, crit)) lines.push(`  ${line}`);
      }
      return lines;
    }
    default: {
      // Exhaustiveness guard: adding a GameEvent kind must add a case above.
      const unreachable: never = e;
      return unreachable;
    }
  }
}

function signedMod(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/** Labeled GATOR breakdown: "gunnery 4 + move 1 + terrain 1 + range 2". */
function gatorText(locale: LocaleId, r: AttackResolution): string {
  if (r.breakdown.outOfRange) return i18n(locale, "res.outOfRange");
  const b = r.breakdown;
  const parts = [`gunnery ${b.gunnery}`];
  if (b.attackerMod) parts.push(`move ${b.attackerMod}`);
  if (b.targetMod) parts.push(`target ${b.targetMod}`);
  if (b.terrainMod) parts.push(`terrain ${b.terrainMod}`);
  if (b.rangeMod) parts.push(`range ${b.rangeMod}`);
  if (b.minRangeMod) parts.push(`min ${b.minRangeMod}`);
  if (b.pulseMod) parts.push(`pulse ${b.pulseMod}`);
  if (b.heatMod) parts.push(`heat ${b.heatMod}`);
  if (b.sensorMod) parts.push(`sensors ${b.sensorMod}`);
  const total = b.automatic === "hit" ? i18n(locale, "res.needAuto") : String(b.total);
  return `${i18n(locale, "res.need", { total })} (${parts.join(" + ")})`;
}

export function resolutionLines(locale: LocaleId, r: AttackResolution): string[] {
  if (r.breakdown.outOfRange) {
    return [i18n(locale, "res.outOfRangeLine", { weapon: r.weapon, distance: r.distance })];
  }
  const verdict =
    r.breakdown.automatic === "hit"
      ? i18n(locale, "res.autoHit")
      : r.hit
        ? i18n(locale, "res.hit")
        : i18n(locale, "res.miss");
  const lines = [
    i18n(locale, "res.line", {
      weapon: r.weapon,
      gator: gatorText(locale, r),
      roll: r.toHitRoll === null ? "—" : String(r.toHitRoll),
      verdict,
      jam: r.jammed ? i18n(locale, "res.jamSuffix") : "",
    }),
  ];
  if (r.ammoExhausted === true) lines.push(i18n(locale, "res.outOfAmmo", { weapon: r.weapon }));
  if (r.clusterRoll !== null) lines.push(i18n(locale, "res.clusterRoll", { roll: r.clusterRoll }));
  if (r.hit && r.groups.length > 0) {
    lines.push(
      i18n(locale, "res.hits", {
        groups: r.groups.map((g) => formatHitGroup(locale, g)).join(" "),
        arc: i18n(locale, ARC_LABEL[r.arc]),
      }),
    );
    const detail = transferDetail(locale, r);
    if (detail) lines.push(`  ${detail}`);
  }
  for (const crit of r.crits) {
    for (const line of critLines(locale, crit)) lines.push(`  ${line}`);
  }
  return lines;
}

/** One damage group label, tagged when the hit location rolled a through-armor 2. */
function formatHitGroup(
  locale: LocaleId,
  g: { location: Location; damage: number; throughArmor?: boolean },
): string {
  const base = `${SHORT_LOC[g.location]}(${g.damage})`;
  return g.throughArmor === true ? `${base} [${i18n(locale, "res.throughArmorTag")}]` : base;
}

/** Pretty-print one CriticalResolution into one or more terminal lines. */
export function critLines(locale: LocaleId, c: CriticalResolution): string[] {
  const headerKey =
    c.determiningRoll <= 7
      ? "res.critNone"
      : c.determiningRoll <= 9
        ? "res.critOne"
        : c.determiningRoll <= 11
          ? "res.critTwo"
          : "res.critThree";
  const lines: string[] = [
    i18n(locale, "res.critHeader", {
      roll: String(c.determiningRoll),
      count: `${i18n(locale, headerKey)}${c.throughArmor ? ` [${i18n(locale, "res.throughArmorTag")}]` : ""}`,
    }),
  ];
  for (const eff of c.rows) lines.push(`  ${formatCritEffect(locale, eff)}`);
  return lines;
}

function formatCritEffect(locale: LocaleId, eff: CriticalEffect): string {
  switch (eff.kind) {
    case "headBlownOff":
      return i18n(locale, "res.critHeadBlownOff");
    case "armBlownOff":
      return i18n(locale, "res.critArmBlownOff", { arm: SHORT_LOC[eff.arm] });
    case "legBlownOff":
      return i18n(locale, "res.critLegBlownOff", { leg: SHORT_LOC[eff.leg] });
    case "weaponDestroyed":
      return i18n(locale, "res.critWeaponDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        weapon: eff.weaponName,
      });
    case "ammoExplosion":
      return i18n(locale, "res.critAmmoExplosion", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        weapon: eff.weaponName,
        damage: String(eff.damage),
      });
    case "cockpitDestroyed":
      return i18n(locale, "res.critCockpitDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
      });
    case "componentDestroyed":
      return i18n(locale, "res.critComponentDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        name: eff.name,
      });
    case "engineDestroyed":
      return i18n(locale, "res.critEngineDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
      });
    case "noEffect":
      return i18n(locale, "res.critNoEffect", { loc: "reroll" });
  }
  return "";
}

/**
 * Per-pool, per-location running totals over `app.steps`. Start from `app.before`
 * so each step's decrement reads the value present *before that step ran*,
 * which is the value visible to the player in the per-step `before→after`
 * label. The engine provides `app.before` directly (snapshot taken at
 * `applyDamage` entry), so no reconstruction from `after` is needed.
 */
function stepLabel(step: DamageTransferStep, before: UnitDamageState): string {
  if (step.pool === "armor") {
    // A location carrying a defined rear pool stores its active value as
    // front armor (F); one without a rear pool holds plain armor (A).
    return before.armorRear[step.location] !== undefined ? "F" : "A";
  }
  return step.pool === "armorRear" ? "R" : "I";
}

function poolValue(
  step: DamageTransferStep,
  run: {
    armor: LocationValue;
    armorRear: Partial<LocationValue>;
    structure: LocationValue;
  },
): number {
  switch (step.pool) {
    case "armor":
      return run.armor[step.location] ?? 0;
    case "armorRear":
      return run.armorRear[step.location] ?? 0;
  }
  return run.structure[step.location] ?? 0;
}

function setPoolValue(
  step: DamageTransferStep,
  value: number,
  run: {
    armor: LocationValue;
    armorRear: Partial<LocationValue>;
    structure: LocationValue;
  },
): void {
  if (step.pool === "armor") run.armor[step.location] = value;
  else if (step.pool === "armorRear") run.armorRear[step.location] = value;
  else run.structure[step.location] = value;
}

export function transferDetail(locale: LocaleId, r: AttackResolution): string | null {
  const app = r.application;
  if (!app || app.steps.length === 0) return null;
  const wasImmobile = isUnitImmobile(app.before);
  const wasDestroyed = isUnitDestroyed(app.before);
  const run = {
    armor: { ...app.before.armor },
    armorRear: { ...app.before.armorRear } as Partial<LocationValue>,
    structure: { ...app.before.internalStructure },
  };
  const bits: string[] = [];
  for (const step of app.steps) {
    const before = poolValue(step, run);
    const after = before - step.damageApplied;
    setPoolValue(step, after, run);
    bits.push(
      `${SHORT_LOC[step.location]}${stepLabel(step, app.before)} ${before}->${after}${step.depleted ? "*" : ""}`,
    );
  }
  let text = bits.join(", ");
  for (const arm of app.blownOffArms) {
    if (!isArm(arm)) continue;
    const cause = shoulderOf(arm);
    text += i18n(locale, "res.armBlownOff", { cause: SHORT_LOC[cause], arm: SHORT_LOC[arm] });
  }
  const otherDestroyed = app.newlyDestroyed.filter((loc) => !app.blownOffArms.includes(loc));
  if (otherDestroyed.length > 0) {
    text += i18n(locale, "res.destroyedTail", {
      locs: otherDestroyed.map((l) => SHORT_LOC[l]).join(", "),
    });
  }
  if (isUnitImmobile(app.after) && !wasImmobile) text += i18n(locale, "res.immobilized");
  if (app.killed && !wasDestroyed) text += i18n(locale, "res.killed");
  return text;
}

function weaponDamageSummary(w: WeaponDef): string {
  if (w.variableDamage)
    return `${w.variableDamage[0]} / ${w.variableDamage[1]} / ${w.variableDamage[2]}`;
  if (w.missileDamage !== undefined && w.missiles !== undefined)
    return `${w.missileDamage * w.missiles} = ${w.missileDamage} per missile × ${w.missiles}`;
  return String(w.damage ?? 0);
}

function weaponDamageDetail(w: WeaponDef): string {
  if (w.variableDamage)
    return `${w.variableDamage[0]} (short) / ${w.variableDamage[1]} (medium) / ${w.variableDamage[2]} (long)`;
  if (w.missileDamage !== undefined && w.missiles !== undefined)
    return `${w.missileDamage} per missile`;
  return `${w.damage ?? 0} (direct fire)`;
}

const CATEGORY_LABEL: Readonly<Record<WeaponCategory, MessageKey>> = {
  MISSILE: "info.weaponCategoryMissile",
  BALLISTIC: "info.weaponCategoryBallistic",
  ENERGY: "info.weaponCategoryEnergy",
};

function weaponCategory(locale: LocaleId, category: WeaponCategory): string {
  return i18n(locale, CATEGORY_LABEL[category]);
}

/**
 * Build the per-mount info rows for sheet / mech-info displays. Every mount
 * of a shared-pool weapon gets the same `shotsMax` (and, if `liveBins` is
 * supplied, the same `shotsLeft`). The first mount by `weapons`-array order
 * is the leader; trailing mounts carry `shotsSharedWith` = leader's 1-based
 * display index so the row can render a `(see #N)` pointer.
 */
function buildMountInfos(
  def: ResolvedMechDef,
  liveBins: Readonly<AmmoBins> | null,
  status: (key: number) => {
    readonly jammed: boolean;
    readonly destroyed: boolean;
  },
): WeaponMountInfo[] {
  const designPool = pooledTotalsByWeaponName(def, loadAmmoBins(def));
  const livePool = liveBins !== null ? pooledTotalsByWeaponName(def, liveBins) : null;
  const entries = Object.entries(def.weapons);
  const firstDisplayByWeapon = new Map<string, number>();
  entries.forEach(([_key, mount], displayIndex) => {
    if (!firstDisplayByWeapon.has(mount.weapon)) {
      firstDisplayByWeapon.set(mount.weapon, displayIndex + 1);
    }
  });
  return entries.map(([keyStr, mount], displayIndex) => {
    const key = Number(keyStr);
    const st = status(key);
    const max = designPool[mount.weapon] ?? null;
    const left = livePool !== null ? (livePool[mount.weapon] ?? 0) : null;
    const leaderDisplay = firstDisplayByWeapon.get(mount.weapon) ?? displayIndex + 1;
    const sharedWith = leaderDisplay !== displayIndex + 1 ? leaderDisplay : null;
    return {
      weapon: mount.weapon,
      location: mount.location,
      shotsLeft: max !== null ? left : null,
      shotsMax: max,
      shotsSharedWith: sharedWith,
      jammed: st.jammed,
      destroyed: st.destroyed,
    };
  });
}

function weaponMountLines(locale: LocaleId, mounts: readonly WeaponMountInfo[]): string[] {
  let nameWidth = 0;
  for (const m of mounts) {
    if (m.weapon.length > nameWidth) nameWidth = m.weapon.length;
  }
  return mounts.map((mount, i) => {
    const w = getWeaponDefFor(mount);
    const shots =
      mount.shotsMax !== null
        ? mount.shotsSharedWith !== null
          ? i18n(locale, "sheet.shotsShared", { ref: mount.shotsSharedWith })
          : mount.shotsLeft !== null
            ? i18n(locale, "sheet.shotsRange", { curr: mount.shotsLeft, max: mount.shotsMax })
            : i18n(locale, "sheet.shotsDesign", { max: mount.shotsMax })
        : null;
    const flags = [shots, mount.jammed ? i18n(locale, "sheet.jammed") : null].filter(
      (x) => x !== null,
    );
    const index = (mount.destroyed ? i18n(locale, "sheet.destroyed") : `#${i + 1}`).padStart(3);
    const name = mount.weapon.padEnd(nameWidth);
    const min = (w.minRange === undefined ? "" : `m${w.minRange}/`).padStart(4);
    const short = `S${w.short}`.padStart(3);
    const medium = `M${w.medium}`.padStart(3);
    const long = `L${w.long}`.padStart(3);
    const heat = `H${w.heat ?? 0}`.padStart(3);
    return `${index} ${name} [${SHORT_LOC[mount.location]}] ${min}${short}/${medium}/${long} ${heat}${flags.length ? ` ${flags.join(" ")}` : ""}`;
  });
}

export {
  listTables,
  renderClusterTable,
  renderCriticalTable,
  renderHeatScaleTable,
  renderHitLocationTables,
} from "./table.js";
