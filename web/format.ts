import type {
  AmmoBinId,
  AmmoPolicy,
  AttackResolution,
  BattleState,
  CriticalEffect,
  CriticalResolution,
  CritSoakName,
  CritStructureName,
  DamageTransferStep,
  FireBlockerReason,
  FireWeapon,
  GameEvent,
  HexCell,
  HexCoord,
  Location,
  LocationValue,
  RangeBracket,
  ResolvedMechDef,
  UnitDamageState,
  UnitState,
  WeaponCategory,
  WeaponDef,
} from "btlib10x";
import {
  ammoBinId,
  canFireFromLocation,
  collectAmmoBins,
  getAllMapDefs,
  getAllMechDefs,
  getAllWeaponDefs,
  getMapDefFor,
  getMechDefFor,
  getWeaponDefFor,
  internalStructureForTonnage,
  isArm,
  isImmobile,
  isKilled,
  isTorso,
  LOCATIONS,
  listMapNames,
  listWeaponNames,
  loadAmmoBins,
  reachableLandings,
  shoulderOf,
  suggestFireTargets,
  TORSO_LOCATIONS,
} from "btlib10x";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { i18n } from "./i18n/index.js";
import { lookupMapOrThrow, lookupMechOrThrow, lookupWeaponOrThrow } from "./lookup.js";
import type { BoardModel, BoardRenderer, CharStyle } from "./render.js";
import { battleModel, getBoardRenderer, mapModel, TEAM_STYLES } from "./render.js";
import type { Session, SetupUnit } from "./session.js";
import { moveStepsInfo } from "./session.js";

/** Board renderer type (re-exported from the render layer). */
export type { BoardRenderer } from "./render.js";

/** One presentation chunk of command output. */
export type Chunk =
  | { readonly kind: "lines"; lines: readonly string[]; cls?: string }
  | {
      readonly kind: "board";
      board: { readonly model: BoardModel; readonly renderer?: BoardRenderer };
    }
  | { readonly kind: "columns"; columns: readonly (readonly string[])[] }
  | {
      readonly kind: "collapsible";
      readonly summary: string;
      readonly chunks: readonly Chunk[];
    };

interface BoardChunk {
  readonly board: { readonly model: BoardModel; readonly renderer?: BoardRenderer };
}

function boardChunkOf(model: BoardModel): BoardChunk["board"] {
  const r = getBoardRenderer("css-grid");
  return r !== undefined ? { model, renderer: r } : { model };
}

export function buildLinesChunk(lines: readonly string[], cls?: string): Chunk {
  return cls ? { kind: "lines", lines: lines, cls: cls } : { kind: "lines", lines: lines };
}

export function buildBoardChunk(board: {
  readonly model: BoardModel;
  readonly renderer?: BoardRenderer;
}): Chunk {
  return { kind: "board", board: board };
}

export function buildColumnsChunk(columns: readonly (readonly string[])[]): Chunk {
  return { kind: "columns", columns: columns };
}

/**
 * Whether a Unicode code point occupies 2 columns in a CJK-aware monospace
 * font. Covers Hangul Jamo, CJK Radicals Supplement through CJK Strokes,
 * Hangul Syllables, CJK Compatibility Ideographs, Vertical Forms, CJK
 * Compatibility Forms, Halfwidth and Fullwidth Forms, and CJK Symbols/
 * Punctuation. Astral-plane characters (Emoji, CJK Unified Ideographs
 * Extension B and beyond) are caught by the `cp > 0xffff` final check.
 */
function isWideCodePoint(cp: number): boolean {
  return (
    // Hangul Jamo: U+1100..U+115F — initial/final/trailing jamo syllables.
    (cp >= 0x1100 && cp <= 0x115f) ||
    // Angle brackets rendered as wide in CJK contexts: U+2329 LEFT-POINTING,
    // U+232A RIGHT-POINTING ANGLE BRACKET (the only single-codepoint picks).
    cp === 0x2329 ||
    cp === 0x232a ||
    // CJK Radicals Supplement through CJK Strokes (and Yi syllables in
    // between): U+2E80..U+A4CF — radicals, Kangxi, ideographic description,
    // CJK symbols/punctuation, Hiragana, Katakana, Bopomofo, Hangul
    // Compatibility Jamo, Kanbun, CJK Unified Ideographs Extension A, Yi.
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    // Hangul Syllables: U+AC00..U+D7A3 — precomposed modern Hangul.
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    // CJK Compatibility Ideographs: U+F900..U+FAFF — duplicated Han chars.
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // Vertical Forms: U+FE10..U+FE1F — CJK punctuation rendered vertically.
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    // CJK Compatibility Forms through Small Form Variants: U+FE30..U+FE6F
    // — compatibility punctuation, vertical/horizontal presentation forms.
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    // Halfwidth and Fullwidth Forms: U+FF00..U+FF60 — fullwidth ASCII and
    // halfwidth Katakana variants.
    (cp >= 0xff00 && cp <= 0xff60) ||
    // Fullwidth Signs: U+FFE0..U+FFE6 — fullwidth currency and math signs.
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // Any astral code point (planes 1–16): CJK Unified Ideographs
    // Extension B+, Emoji, historic scripts, etc. All render as wide in
    // CJK-aware monospace fonts.
    cp > 0xffff
  );
}

/**
 * Code-unit length padded out to the visual cell count of the string.
 * Each wide code point contributes 1 extra cell beyond its code-unit
 * count (BMP wide = 1 unit + 1 cell; astral wide = 2 units + 0 extra
 * because the wide bonus equals the surrogate-pair size).
 *
 * Pure-ASCII strings short-circuit on the first numeric scan: no
 * iterator allocation, no per-char `codePointAt`, and no range checks
 * — `getCompensatedLength` reduces to `str.length`. Non-ASCII strings
 * fall back to the iterator-based path so the existing
 * `isWideCodePoint` ranges (including astral planes) still apply.
 */
function getCompensatedLength(str: string): number {
  let extra = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) continue;
    for (const ch of str.slice(i)) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp > 0x7f && isWideCodePoint(cp)) extra += 1;
    }
    break;
  }
  return str.length + extra;
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
const LINE_THEME = {
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

function buildHeaderTableChunkFromRows(
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
    LINE_THEME.LIGHT;
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

function buildHeaderTableChunkFromColumns(
  header: readonly (string | null)[],
  columns: readonly (readonly string[])[],
): Chunk {
  const n = header.length;
  if (n === 0) return buildColumnsChunk([]);

  const { tnw, tn, tne, tnh, tnv, tw, tc, te, tcs, twc, tec, tsw, ts, tse, tsh, tsv } =
    LINE_THEME.LIGHT;
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

function mapDims(s: Session): [number, number] | undefined {
  if (!s.mapName) return undefined;
  const map = getMapDefFor(s);
  return [map.width, map.height];
}

/** `board` output: styled grid chunks, or a plain hint when nothing exists. */
export function boardChunk(s: Session): Chunk {
  const dims = mapDims(s);
  if (!s.battle) {
    if (!s.mapName && s.roster.length === 0) {
      return buildLinesChunk([i18n(s.locale, "board.noMap")]);
    }
    const units = Object.fromEntries(
      s.roster.map((u) => [
        u.id,
        { id: u.id, position: u.position, facing: u.facing, removed: false },
      ]),
    ) as BattleState["units"];
    let width = dims?.[0] ?? 0;
    let height = dims?.[1] ?? 0;
    for (const u of s.roster) {
      width = Math.max(width, u.position.col);
      height = Math.max(height, u.position.row);
    }
    if (width < 1) width = 1;
    if (height < 1) height = 1;
    const cells: HexCell[] = new Array<HexCell>(width * height).fill({
      terrain: "clear",
      level: 0,
    });
    for (const t2 of s.terrainDefs) {
      cells[t2.col - 1 + (t2.row - 1) * width] = { terrain: t2.type, level: t2.level ?? 0 };
    }
    const model = battleModel({
      units,
      cells,
      width,
      height,
      turn: 0,
      phase: "initiative",
      initiativeWinnerTeam: null,
      critsDisabled: false,
      actedThisPhase: [],
      events: [],
    } as BattleState);
    return buildBoardChunk(boardChunkOf(model));
  }
  return buildBoardChunk(boardChunkOf(battleModel(s.battle)));
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
      Object.entries(d.weapons).map(([key, mount]) => ({
        weapon: mount.weapon,
        location: mount.location,
        shotsLeft: null,
        shotsMax: loadAmmoBins(d).totals[Number(key)] ?? null,
        jammed: false,
        destroyed: false,
      })),
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
        }),
      ),
    ),
    critChartChunk(d, locale, null),
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
      lines.push(
        `  ${w.name.padEnd(maxNameLen)}  short ${String(w.short).padStart(2)}` +
          ` / medium ${String(w.medium).padStart(2)}` +
          ` / long ${String(w.long).padStart(2)}` +
          `  ${weaponDamageSummary(w)}`,
      );
    }
  }
  return lines;
}

export function infoWeapon(locale: LocaleId, name: string): string[] {
  const w = (() => {
    try {
      return lookupWeaponOrThrow(name);
    } catch {
      throw new Error(
        i18n(locale, "err.unknownWeapon", { name, list: listWeaponNames().join(", ") }),
      );
    }
  })();
  const cat = weaponCategory(locale, w.category);
  const lines = [
    i18n(locale, "info.weaponHead", { name: w.name, category: cat }),
    i18n(locale, "info.weaponRange", { short: w.short, medium: w.medium, long: w.long }),
    i18n(locale, "info.weaponDamage", { damage: weaponDamageDetail(w) }),
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
  const map = (() => {
    try {
      return lookupMapOrThrow(name);
    } catch {
      throw new Error(i18n(locale, "err.unknownMap", { name, list: listMapNames().join(", ") }));
    }
  })();
  const counts = new Map<string, number>();
  for (const t2 of map.terrain) counts.set(t2.type, (counts.get(t2.type) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type} ${n}`)
    .join(", ");
  const elevationCounts = new Map<number, number>();
  const elevationMap: Record<string, number> = {};
  for (const t2 of map.terrain) {
    if (t2.level !== undefined && t2.level !== 0) {
      elevationMap[`${t2.col},${t2.row}`] = t2.level;
      elevationCounts.set(t2.level, (elevationCounts.get(t2.level) ?? 0) + 1);
    }
  }
  const elevationBreakdown =
    [...elevationCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([level, n]) => `L${level} ${n}`)
      .join(", ") || i18n(locale, "info.terrainNone");
  return [
    buildLinesChunk([
      i18n(locale, "info.mapHead", { name, w: map.width, h: map.height }),
      i18n(locale, "info.terrainLine", {
        breakdown: breakdown || i18n(locale, "info.terrainNone"),
      }),
      i18n(locale, "info.elevationLine", { breakdown: elevationBreakdown }),
    ]),
    buildBoardChunk(
      boardChunkOf(
        mapModel(
          map.terrain,
          map.width,
          map.height,
          undefined,
          Object.keys(elevationMap).length > 0 ? elevationMap : undefined,
        ),
      ),
    ),
  ];
}

function requireMechDef(model: string, locale: LocaleId): ResolvedMechDef {
  const def = (() => {
    try {
      return lookupMechOrThrow(model);
    } catch {
      throw new Error(i18n(locale, "err.unknownModel", { model }));
    }
  })();
  return def;
}

// --------------------------------------------------------------- sheet ----

/** Per-mount presentation info used by sheet and mech-info weapon rows. */
export type WeaponMountInfo = {
  readonly weapon: string;
  readonly location: Location;
  readonly shotsLeft: number | null;
  readonly shotsMax: number | null;
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
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
  readonly removed: boolean;
  readonly positionLine: string;
  readonly modeLine: string | null;
  /** Current ammo depletion policy; null when the unit carries no ammo. */
  readonly ammoPolicyLine: string | null;
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
}

function battleSheet(unit: UnitState, id: string, locale: LocaleId): SheetView {
  // Engine guarantee: `unit.model` was validated by `createBattle`.
  const def = getMechDefFor(unit);
  return {
    id: id,
    team: unit.team,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    removed: unit.removed,
    positionLine: i18n(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }),
    modeLine:
      unit.moveMode !== null
        ? i18n(locale, "sheet.modeSuffix", { mode: unit.moveMode, mp: unit.mpSpent })
        : null,
    ammoPolicyLine:
      collectAmmoBins(def).length > 0
        ? i18n(locale, "sheet.ammoPolicy", { policy: ammoPolicyLabel(locale, unit.ammoPolicy) })
        : null,
    armor: unit.damage.armor,
    damage: unit.damage,
    originalArmor: def.armor,
    originalArmorRear: def.armorRear,
    originalArmorStructure: def.internalStructure,
    mounts: Object.entries(def.weapons).map(([key, mount]) => ({
      weapon: mount.weapon,
      location: mount.location,
      shotsLeft: mount.shots !== undefined ? (unit.shotsLeft[Number(key)] ?? 0) : null,
      shotsMax: loadAmmoBins(def).totals[Number(key)] ?? null,
      jammed: unit.jammedWeapons.includes(Number(key)),
      destroyed:
        unit.destroyedWeapons.includes(Number(key)) ||
        !canFireFromLocation(unit.phaseStartDamage, mount.location),
    })),
    critLive: {
      critSlotsDestroyed: unit.critSlotsDestroyed,
      destroyedWeapons: unit.destroyedWeapons,
      jammedWeapons: unit.jammedWeapons,
      shotsLeft: unit.shotsLeft,
      ammoBins: unit.ammoBins,
    },
  };
}

function setupSheet(unit: SetupUnit, id: string, locale: LocaleId): SheetView {
  const def = requireMechDef(unit.model, locale);
  const armorRear: Partial<LocationValue> = {};
  for (const loc of TORSO_LOCATIONS) {
    const v = def.armorRear[loc];
    if (v !== undefined) armorRear[loc] = v;
  }
  const damage: UnitDamageState = {
    armor: { ...def.armor },
    armorRear,
    internalStructure: internalStructureForTonnage(def.tonnage),
  };
  return {
    id: id,
    team: unit.team,
    model: def.model,
    name: def.name,
    weightClass: def.weightClass,
    tonnage: def.tonnage,
    gunnery: unit.gunnery,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    removed: false,
    positionLine: i18n(locale, "sheet.at", { pos: disp(unit.position), facing: unit.facing }),
    modeLine: null,
    ammoPolicyLine: null,
    armor: damage.armor,
    damage,
    originalArmor: def.armor,
    originalArmorRear: armorRear,
    originalArmorStructure: damage.internalStructure,
    mounts: Object.entries(def.weapons).map(([key, mount]) => ({
      weapon: mount.weapon,
      location: mount.location,
      shotsLeft: null,
      shotsMax: loadAmmoBins(def).totals[Number(key)] ?? null,
      jammed: false,
      destroyed: false,
    })),
    critLive: null,
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
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'info mech <model>' command */
function armorDiagramInfo(info: ArmorInfo): string[] {
  const cell = (max: number, label: string) => ` ${String(max).padStart(2)}${label}`;
  const p = (n: number) => " ".repeat(n);
  const CT = 10,
    RT = 5,
    LT = 17;
  const o = info.originalArmor;
  const os = info.originalStructure;
  const or = info.originalArmorRear;
  const rear = (loc: Location) => cell(or[loc] ?? 0, "R");
  return [
    `${p(CT)}[HD]`,
    `${p(CT)}${cell(os.head, "I")}`,
    `${p(CT)}${cell(o.head, "A")}`,
    `[RA] [RT] [CT] [LT] [LA]`,
    [
      cell(os.rightArm, "I"),
      cell(os.rightTorso, "I"),
      cell(os.centerTorso, "I"),
      cell(os.leftTorso, "I"),
      cell(os.leftArm, "I"),
    ].join(" "),
    [
      cell(o.rightArm, "A"),
      cell(o.rightTorso, "F"),
      cell(o.centerTorso, "F"),
      cell(o.leftTorso, "F"),
      cell(o.leftArm, "A"),
    ].join(" "),
    `${p(RT)}${[rear("rightTorso"), rear("centerTorso"), rear("leftTorso")].join(" ")}`,
    `${p(RT)}[RL]${p(LT - RT - 6)}[LL]`,
    `${p(RT)}${[cell(os.rightLeg, "I"), cell(os.leftLeg, "I")].join(p(LT - RT - 6))}`,
    `${p(RT)}${[cell(o.rightLeg, "A"), cell(o.leftLeg, "A")].join(p(LT - RT - 6))}`,
  ];
}

/** ASCII humanoid armor diagram: internal structure (I), front armor (F/A), rear (R). */
/** for 'sheet <id>' command */
function armorDiagramSheet(info: ArmorInfo): string[] {
  const cell = (val: number, max: number, label: string) =>
    `${String(val).padStart(2)}/${String(max).padStart(2)}${label}`;
  const p = (n: number) => " ".repeat(n);
  const CT = 14,
    RT = 7,
    LT = 21;
  const { armor: a, originalArmor: o } = info;
  const s = info.internalStructure;
  const os = info.originalStructure;
  const ar = info.armorRear;
  const or = info.originalArmorRear;
  const rear = (loc: Location) => cell(ar[loc] ?? 0, or[loc] ?? 0, "R");
  return [
    `${p(CT)}[ HD ]`,
    `${p(CT)}${cell(s.head, os.head, "I")}`,
    `${p(CT)}${cell(a.head, o.head, "A")}`,
    `[ RA ] [ RT ] [ CT ] [ LT ] [ LA ]`,
    [
      cell(s.rightArm, os.rightArm, "I"),
      cell(s.rightTorso, os.rightTorso, "I"),
      cell(s.centerTorso, os.centerTorso, "I"),
      cell(s.leftTorso, os.leftTorso, "I"),
      cell(s.leftArm, os.leftArm, "I"),
    ].join(" "),
    [
      cell(a.rightArm, o.rightArm, "A"),
      cell(a.rightTorso, o.rightTorso, "F"),
      cell(a.centerTorso, o.centerTorso, "F"),
      cell(a.leftTorso, o.leftTorso, "F"),
      cell(a.leftArm, o.leftArm, "A"),
    ].join(" "),
    `${p(RT)}${[rear("rightTorso"), rear("centerTorso"), rear("leftTorso")].join(" ")}`,
    `${p(RT)}[ RL ]${p(LT - RT - 6)}[ LL ]`,
    `${p(RT)}${[cell(s.rightLeg, os.rightLeg, "I"), cell(s.leftLeg, os.leftLeg, "I")].join(p(LT - RT - 6))}`,
    `${p(RT)}${[cell(a.rightLeg, o.rightLeg, "A"), cell(a.leftLeg, o.leftLeg, "A")].join(p(LT - RT - 6))}`,
  ];
}

// ------------------------------------------------------- crit slot chart ----

/** Per-unit live crit state shown per slot on the `sheet <id>` chart. */
interface CritChartLive {
  readonly critSlotsDestroyed: Readonly<Record<Location, readonly boolean[]>>;
  readonly destroyedWeapons: readonly number[];
  readonly jammedWeapons: readonly number[];
  /** Derived per-weapon total shots (for weapon lines); kept for the sheet. */
  readonly shotsLeft: Readonly<Record<number, number>>;
  /** Per-crit-slot ammo remaining. */
  readonly ammoBins: Readonly<Record<AmmoBinId, number>>;
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
    const max = loadAmmoBins(def).bins[binId];
    if (max !== undefined) {
      const curr = live !== null ? (live.ammoBins[binId] ?? max) : max;
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
    if (mountJammed) markers.push(i18n(locale, "critChart.jammedSuffix"));
    if (slotHit || mountDestroyed) markers.push(i18n(locale, "critChart.destroyedSuffix"));
  }
  return markers.length > 0 ? `${line}${markers.join("")}` : line;
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

/** Collapsible crit chart: one columns chunk per row (arena / torso / legs). */
function critChartChunk(def: ResolvedMechDef, locale: LocaleId, live: CritChartLive | null): Chunk {
  const raLines = critCell(def, "rightArm", locale, live);
  const hdLines = critCell(def, "head", locale, live);
  const laLines = critCell(def, "leftArm", locale, live);
  const rtLines = critCell(def, "rightTorso", locale, live);
  const ctLines = critCell(def, "centerTorso", locale, live);
  const ltLines = critCell(def, "leftTorso", locale, live);
  const rlLines = critCell(def, "rightLeg", locale, live);
  const infoLines = [" "];
  const llLines = critCell(def, "leftLeg", locale, live);
  const built = [raLines, hdLines, laLines, rtLines, ctLines, ltLines, rlLines, infoLines, llLines];
  const maxLineLen = built
    .flat()
    .map((l) => getCompensatedLength(l))
    .reduce((prev, curr) => Math.max(prev, curr));
  built.forEach((lines) => {
    lines[0] = lines[0]!.padEnd(maxLineLen);
  });
  return buildCollapsibleChunk(i18n(locale, "critChart.summary"), [
    buildColumnsChunk([raLines, hdLines, laLines]),
    buildColumnsChunk([rtLines, ctLines, ltLines]),
    buildColumnsChunk([rlLines, infoLines, llLines]),
  ]);
}

/** Record sheet with armor status per location, side-by-side with ASCII diagram. */
export function sheetLines(view: SheetView, locale: LocaleId): Chunk[] {
  const idLine = view.removed
    ? `${i18n(locale, "sheet.idLine", { id: view.id, team: view.team })}${i18n(locale, "sheet.removedId")}`
    : i18n(locale, "sheet.idLine", { id: view.id, team: view.team });
  const topLines = [
    i18n(locale, "sheet.modelLine", {
      model: view.model,
      name: view.name,
      weightClass: view.weightClass,
      tonnage: view.tonnage,
    }),
  ];
  if (view.gunnery !== null) {
    topLines.push(
      i18n(locale, "sheet.gunneryLine", { gunnery: gunneryLabel(locale, view.gunnery) }),
    );
  }
  topLines.push(
    i18n(locale, "info.movement", { walk: view.walking, run: view.running, jump: view.jumping }),
  );
  topLines.push(view.positionLine);
  if (view.ammoPolicyLine !== null) topLines.push(view.ammoPolicyLine);
  const weaponLines: string[] = [i18n(locale, "sheet.weaponsHeader", { n: view.mounts.length })];
  weaponLines.push(...weaponMountLines(locale, view.mounts));
  return [
    buildHeaderTableChunkFromColumns(
      [idLine, i18n(locale, "info.armorStructureCol")],
      mergeDiagramToColumns(
        topLines,
        weaponLines,
        armorDiagramSheet({
          armor: view.armor,
          armorRear: view.damage.armorRear,
          internalStructure: view.damage.internalStructure,
          originalArmor: view.originalArmor,
          originalArmorRear: view.originalArmorRear,
          originalStructure: view.originalArmorStructure,
        }),
      ),
    ),
    critChartChunk(requireMechDef(view.model, locale), locale, view.critLive),
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
    if (!unit) throw new Error(i18n(s.locale, "err.unknownUnitId", { id }));
    return sheetLines(battleSheet(unit, id, s.locale), s.locale);
  }
  const placed = s.roster.find((u) => u.id === id);
  if (!placed) throw new Error(i18n(s.locale, "err.noSuchUnit", { id }));
  return sheetLines(setupSheet(placed, id, s.locale), s.locale);
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
      lines.push(`  ${uid}  ${def.model}  ${disp(unit.position)} facing ${unit.facing}`);
      const view = battleSheet(unit, uid, s.locale);
      lines.push(`    ${durabilityLine(view, s.locale)}`);
    }
  }
  return lines;
}

// -------------------------------------------------------------- status ----

export function fmtSetupStatus(s: Session): string[] {
  const lines: string[] = [
    i18n(s.locale, "setup.mapLabel", { name: s.mapName ?? i18n(s.locale, "setup.mapNone") }),
    i18n(s.locale, "setup.terrainCount", { n: s.terrainDefs.length }),
  ];
  const teams = [...new Set(s.roster.map((u) => u.team))].sort((a, b) => a - b);
  for (const team of teams) {
    lines.push(i18n(s.locale, "setup.teamHeader", { team }));
    for (const u of s.roster.filter((x) => x.team === team)) {
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

export function sheetLinesShort(view: SheetView, locale: LocaleId, showMode = true): string[] {
  const head = i18n(locale, "sheet.modelLine", {
    model: view.model,
    name: view.name,
    weightClass: view.weightClass,
    tonnage: view.tonnage,
  });
  const lines = [head];
  if (view.gunnery !== null) {
    lines.push(
      `${i18n(locale, "sheet.gunneryLine", { gunnery: gunneryLabel(locale, view.gunnery) })}`,
    );
  }
  lines.push(view.positionLine);
  if (showMode && view.modeLine) lines.push(view.modeLine);
  lines.push(`${durabilityLine(view, locale)}`);
  return lines;
}

/** Compact armor summary per location: front + rear + internal-structure summed
 * as `cur/max`, with `*` when the front pool is depleted (structure still
 * intact) and `!` when internal structure is depleted. */
function durabilityLine(view: SheetView, locale: LocaleId): string {
  return i18n(locale, "sheet.durabilityLine", {
    list: LOCATIONS.map((loc) => {
      const frontCur = view.armor[loc];
      const frontMax = view.originalArmor[loc];
      const structCur = view.damage.internalStructure[loc];
      const structMax = view.originalArmorStructure[loc];
      const rearCur = isTorso(loc) ? (view.damage.armorRear[loc] ?? 0) : 0;
      const rearMax = isTorso(loc) ? (view.originalArmorRear[loc] ?? 0) : 0;
      const cur = frontCur + rearCur + structCur;
      const max = frontMax + rearMax + structMax;
      const marker = structCur <= 0 ? "!" : frontCur <= 0 ? "*" : "";
      return `${SHORT_LOC[loc]} ${cur}/${max}${marker}`;
    }).join(" | "),
  });
}

export function overStatusLines(s: Session): string[] {
  if (!s.battle || !s.victory) return [];
  const lines: string[] = [];
  const teams = [...new Set(Object.values(s.battle.units).map((u) => u.team))].sort(
    (a, b) => a - b,
  );
  for (const team of teams) {
    lines.push(i18n(s.locale, "setup.teamHeader", { team }));
    for (const [uid, unit] of Object.entries(s.battle.units).filter(([, u]) => u.team === team)) {
      const view = battleSheet(unit, uid, s.locale);
      const idLine = view.removed
        ? `${i18n(s.locale, "over.idLine", { id: view.id })}${i18n(s.locale, "sheet.removedId")}`
        : i18n(s.locale, "over.idLine", { id: view.id });
      lines.push(`  ${idLine}`);
      for (const line of sheetLinesShort(view, s.locale, false)) lines.push(`    ${line}`);
    }
  }
  return lines;
}

export function moveStatusLines(s: Session): string[] {
  const info = moveStepsInfo(s);
  const modeText =
    info.mode === null
      ? i18n(s.locale, "moveStatus.noMode")
      : i18n(s.locale, "moveStatus.mode", { mode: info.mode });
  const lines = [modeText, i18n(s.locale, "moveStatus.budget", { budget: info.budget })];
  if (info.steps.length === 0) {
    lines.push(i18n(s.locale, "moveStatus.none"));
  } else {
    for (const step of info.steps) {
      lines.push(
        i18n(s.locale, "moveStatus.stepLine", {
          label: step.label,
          cost: step.mpCost,
          total: step.mpAfter,
        }),
      );
    }
  }
  return lines;
}

/** Belly marker drawn in a reachable hex on the reachable map. */
export const REACHABLE_MARKER = "<>";

/**
 * Clipped ASCII-hex map of the reachable hexes for the declared mode.
 *
 * The model crops exactly to the smallest axis-aligned bounding box that holds
 * every reachable hex and is clamped to the board bounds (no padding). All
 * units inside the crop keep their ids (team-tinted); no facing arrows are
 * drawn, reachable hexes show a team-tinted `<>` in the belly, and every
 * reachable (hex, facing) landing tints its grid edge with the actor's team
 * color. Raw `RevealedLanding.path` data is retained on the landing but not
 * rendered here (kept for later use).
 */
export function reachableModel(s: Session): BoardModel | null {
  const actor = s.battle?.units[s.actorId ?? ""];
  if (!actor || !s.battle || s.moveMode === null) return null;
  const w = s.battle.width;
  const h = s.battle.height;
  // Engine guarantee: `actor.model` was validated by `createBattle`.
  const def = getMechDefFor(actor);
  const landings = reachableLandings({ ...actor.position }, actor.facing, {
    mode: s.moveMode,
    walking: def.walking,
    running: def.running,
    jumping: def.jumping,
    grid: s.battle,
    team: actor.team,
    occupantTeam: (hex: HexCoord): number | undefined => {
      for (const u of Object.values(s.battle!.units)) {
        if (u.removed) continue;
        if (u.position.col === hex.col && u.position.row === hex.row) return u.team;
      }
      return undefined;
    },
  });
  if (landings.length === 0) return null;

  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const l of landings) {
    if (l.hex.col < minC) minC = l.hex.col;
    if (l.hex.col > maxC) maxC = l.hex.col;
    if (l.hex.row < minR) minR = l.hex.row;
    if (l.hex.row > maxR) maxR = l.hex.row;
  }
  const col0 = Math.max(1, minC);
  const row0 = Math.max(1, minR);
  const col1 = Math.min(w, maxC);
  const row1 = Math.min(h, maxR);

  const base = battleModel(s.battle);
  const cells = { ...(base.cells ?? {}) };
  const cellStyles = { ...(base.cellStyles ?? {}) };
  const edgeStyles: Record<string, CharStyle> = {};
  const team = TEAM_STYLES[actor.team];
  const actorKey = `${actor.position.col},${actor.position.row}`;
  for (const l of landings) {
    const key = `${l.hex.col},${l.hex.row}`;
    if (key !== actorKey && cells[key] === undefined) {
      cells[key] = REACHABLE_MARKER;
      if (team !== undefined) cellStyles[key] = team;
    }
    if (team !== undefined) edgeStyles[`${l.hex.col},${l.hex.row}:${l.facing}`] = team;
  }

  return {
    cols: col1 - col0 + 1,
    rows: row1 - row0 + 1,
    col0,
    row0,
    cells,
    ...(Object.keys(edgeStyles).length > 0 ? { edgeStyles } : {}),
    ...(base.styles !== undefined ? { styles: base.styles } : {}),
    ...(Object.keys(cellStyles).length > 0 ? { cellStyles } : {}),
    ...(base.marks !== undefined ? { marks: base.marks } : {}),
    ...(base.elevations !== undefined ? { elevations: base.elevations } : {}),
  };
}

/** Board chunk of the reachable hex map, or null when none can be drawn. */
export function reachChunk(s: Session): Chunk | null {
  const model = reachableModel(s);
  if (model === null) return null;
  return buildBoardChunk(boardChunkOf(model));
}

export function attackStatusLines(s: Session): string[] {
  const actor = s.battle?.units[s.actorId ?? ""];
  if (!actor || !s.battle)
    throw new Error(i18n(s.locale, "err.wrongPhase", { phase: "weaponAttack" }));
  if (s.fireDecls.length === 0) return [i18n(s.locale, "attackStatus.none")];
  // Engine guarantee: `actor.model` was validated by `createBattle`.
  const def = getMechDefFor(actor);
  return s.fireDecls.map((decl) => {
    const mount = def.weapons[decl.weaponIndex];
    const name = mount ? mount.weapon : `#${decl.weaponIndex}`;
    const rapid = mount ? getWeaponDefFor(mount).rapidFireShots : undefined;
    const suffix = decl.rapidFire && rapid !== undefined ? ` (rapid-fire x${rapid})` : "";
    return `#${decl.weaponIndex} ${name} -> ${decl.targetId}${suffix}`;
  });
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
};

function fireWeaponTable(locale: LocaleId, weapons: readonly FireWeapon[]): Chunk {
  const header = [
    i18n(locale, "fireSuggestion.colIndex"),
    i18n(locale, "fireSuggestion.colWeapon"),
    i18n(locale, "fireSuggestion.colLoc"),
    i18n(locale, "fireSuggestion.colBracket"),
    i18n(locale, "fireSuggestion.colTn"),
    i18n(locale, "fireSuggestion.colDmg"),
    i18n(locale, "fireSuggestion.colShots"),
  ];
  const rows = weapons.map((w) => [
    `#${w.weaponIndex}`,
    w.weapon,
    SHORT_LOC[w.location],
    `[${BRACKET_LABEL[w.rangeBracket]}]`,
    String(w.tn),
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

/** Automatic hint shown at the start of a unit's fire turn. */
export function fireSuggestionLines(s: Session): Chunk[] {
  const battle = s.battle;
  if (!battle || s.actorId === null) {
    throw new Error(i18n(s.locale, "err.wrongPhase", { phase: "weaponAttack" }));
  }
  const sugg = suggestFireTargets(battle, s.actorId);
  const chunks: Chunk[] = [
    buildLinesChunk([i18n(s.locale, "fireSuggestion.header", { id: sugg.targetId })], "hint"),
  ];
  if (sugg.targets.length === 0) {
    chunks.push(buildLinesChunk([i18n(s.locale, "fireSuggestion.noTargets")], "hint"));
    return chunks;
  }
  for (const target of sugg.targets) {
    chunks.push(
      buildLinesChunk(
        [
          i18n(s.locale, "fireSuggestion.target", {
            id: target.targetId,
            distance: String(target.distance),
          }),
        ],
        "hint",
      ),
    );
    if (target.weapons.length > 0) {
      chunks.push(fireWeaponTable(s.locale, target.weapons));
    }
    for (const b of target.blocked) {
      chunks.push(
        buildLinesChunk(
          [
            `${i18n(s.locale, "fireSuggestion.blocked")}: #${b.weaponIndex} ${b.weapon} — ${i18n(s.locale, BLOCKER_LABEL[b.reason])}`,
          ],
          "hint",
        ),
      );
    }
  }
  return chunks;
}

export function weaponsLines(s: Session, unitId?: string): string[] {
  const id = unitId ?? s.actorId;
  const unit = typeof id === "string" && id.length > 0 ? s.battle?.units[id] : undefined;
  if (!unit || !s.battle) {
    throw new Error(
      i18n(s.locale, "err.unknownUnitId", { id: unitId ?? i18n(s.locale, "weapons.noActorId") }),
    );
  }
  // Engine guarantee: `unit.model` was validated by `createBattle`.
  const def = getMechDefFor(unit);
  const totals = loadAmmoBins(def).totals;
  return Object.entries(def.weapons).map(([key, mount]) => {
    const w = getWeaponDefFor(mount);
    const index = Number(key);
    const max = totals[index];
    const bits = [
      `#${index}`,
      mount.weapon,
      mount.location,
      `S${w.short}/M${w.medium}/L${w.long}`,
      max !== undefined
        ? i18n(s.locale, "sheet.shotsRange", { curr: unit.shotsLeft[index] ?? 0, max })
        : null,
      unit.jammedWeapons.includes(index) ? i18n(s.locale, "sheet.jammed") : null,
      unit.destroyedWeapons.includes(index) ? i18n(s.locale, "sheet.destroyed") : null,
      !unit.destroyedWeapons.includes(index) &&
      !canFireFromLocation(unit.phaseStartDamage, mount.location)
        ? i18n(s.locale, "sheet.destroyed")
        : null,
    ].filter((b) => b !== null);
    return bits.join("  ");
  });
}

// ------------------------------------------------------------------ log ----

export function fmtLog(
  locale: LocaleId,
  events: readonly GameEvent[],
  n: number = events.length,
): string[] {
  const slice = events.slice(-n);
  const lines: string[] = [];
  let prevKind: GameEvent["kind"] | null = null;
  let removedLines: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    const e = slice[i]!;
    const currKind = e.kind;
    if (isAttackResolutionKind(e.kind)) {
      if (!isAttackResolutionKind(prevKind)) {
        lines.push(i18n(locale, "res.attackResolutionStart"));
      }
      if (currKind === "unitRemoved") {
        removedLines.push(...eventLines(locale, e));
      } else if (currKind === "attackResolved") {
        const resolvedLines = eventLines(locale, e);
        const unitPrefix = `[${e.unitId} -> ${e.targetId}] `;
        lines.push(unitPrefix + resolvedLines.shift());
        if (resolvedLines.length > 0) {
          const indent = " ".repeat(unitPrefix.length);
          lines.push(...resolvedLines.map((l) => indent + l));
        }
      } else {
        lines.push(...eventLines(locale, e));
      }
      if (!isAttackResolutionKind(getKindInBatch(i + 1, slice))) {
        lines.push(i18n(locale, "res.attackResolutionEnd"));
        if (removedLines.length > 0) {
          lines.push(...removedLines);
          removedLines = [];
        }
      }
    } else {
      lines.push(...eventLines(locale, e));
    }
    prevKind = currKind;
  }
  return lines;
}

function isAttackResolutionKind(kind: GameEvent["kind"] | null): boolean {
  return kind === "attackResolved" || kind === "unitDestroyed" || kind === "unitRemoved";
}

function getKindInBatch(i: number, slice: readonly GameEvent[]): GameEvent["kind"] | null {
  return i >= 0 && i < slice.length ? slice[i]!.kind : null;
}

function eventLines(locale: LocaleId, e: GameEvent): string[] {
  switch (e.kind) {
    case "turn":
      return [i18n(locale, "log.turn", { turn: e.turn })];
    case "phase":
      return [i18n(locale, "log.phase", { phase: e.phase })];
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
      return [i18n(locale, "log.destroyed", { id: e.unitId })];
    case "unitRemoved":
      return [i18n(locale, "log.removedEvent", { id: e.unitId })];
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
      roll: String(r.toHitRoll),
      verdict,
      jam: r.jammed ? i18n(locale, "res.jamSuffix") : "",
    }),
  ];
  if (r.clusterRoll !== null) lines.push(i18n(locale, "res.clusterRoll", { roll: r.clusterRoll }));
  if (r.hit && r.groups.length > 0) {
    lines.push(
      i18n(locale, "res.hits", {
        groups: r.groups.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" "),
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
      count: i18n(locale, headerKey),
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
    case "noEffect":
      return i18n(locale, "res.critNoEffect", { loc: "reroll" });
  }
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
  const wasImmobile = isImmobile(app.before);
  const wasKilled = isKilled(app.before);
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
  if (isImmobile(app.after) && !wasImmobile) text += i18n(locale, "res.immobilized");
  if (app.killed && !wasKilled) text += i18n(locale, "res.killed");
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

function weaponMountLines(locale: LocaleId, mounts: readonly WeaponMountInfo[]): string[] {
  let nameWidth = 0;
  for (const m of mounts) {
    if (m.weapon.length > nameWidth) nameWidth = m.weapon.length;
  }
  return mounts.map((mount, i) => {
    const w = getWeaponDefFor(mount);
    const flags = [
      mount.shotsMax !== null
        ? mount.shotsLeft !== null
          ? i18n(locale, "sheet.shotsRange", { curr: mount.shotsLeft, max: mount.shotsMax })
          : i18n(locale, "sheet.shotsDesign", { max: mount.shotsMax })
        : null,
      mount.jammed ? i18n(locale, "sheet.jammed") : null,
      mount.destroyed ? i18n(locale, "sheet.destroyed") : null,
    ].filter((x) => x !== null);
    const index = `#${i + 1}`.padStart(3);
    const name = mount.weapon.padEnd(nameWidth);
    const short = `S${w.short}`.padStart(3);
    const medium = `M${w.medium}`.padStart(3);
    const long = `L${w.long}`.padStart(3);
    return `${index} ${name} [${SHORT_LOC[mount.location]}] ${short}/${medium}/${long}${flags.length ? ` ${flags.join(" ")}` : ""}`;
  });
}
