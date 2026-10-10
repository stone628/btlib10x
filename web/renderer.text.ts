import {
  type BattleState,
  FACINGS,
  type Facing,
  type HexCoord,
  type HexGrid,
  hexKey,
  isUnitRemoved,
  type MapDef,
  type TerrainHexDef,
} from "btlib10x";
import { compensatedLength, i18n, type MessageKey } from "./i18n/index";

// ---- shared presentation types ----

/** Named palette slots; the web layer maps these to CSS variables. */
type ColorName = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "dim";

/** Per-character presentation hints for styled board output. */
export interface CharStyle {
  readonly fg?: ColorName | undefined;
  readonly bg?: ColorName | undefined;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  /** Web-only hook: raw CSS class (e.g. per-terrain scheme `t-lightWoods`). */
  readonly cls?: string | undefined;
}

/** A run of characters sharing one {@link CharStyle} within a board line. */
export interface Span {
  readonly text: string;
  readonly style?: CharStyle | undefined;
}

/**
 * Structured board: the flat text pieces plus optional per-hex style hints.
 * Keys are `"col,row"` in engine coordinates.
 */
export interface BoardModel {
  readonly cols: number;
  readonly rows: number;
  /** Absolute (1-based) column/row of the crop anchor. Hex at `(col,row)` renders at `(col - anchorCol, row - anchorRow)`. */
  readonly anchorCol: number;
  readonly anchorRow: number;
  /** Cell text drawn inside `/...\ ` (unit ids, overlay glyphs). */
  readonly cells: Readonly<Record<string, string>>;
  /** Glyphs drawn at the hex bottom center (e.g. terrain markers). */
  readonly marks: Readonly<Record<string, string>>;
  /** Per-hex ground elevation. */
  readonly elevations: Readonly<Record<string, number>>;
  /** Per-hex mech facing (`"col,row"` → {@link Facing}); drawn on the grid. */
  readonly facings: Readonly<Record<string, Facing>>;
  /**
   * Per-edge style keyed by `"col,row:facing"` — tints the grid edge where
   * that facing's arrow would be placed (e.g. team color on reachable hexes).
   */
  readonly edgeStyles: Readonly<Record<string, CharStyle>>;
  /** Style applied to a hex's characters: grid rows, belly parens and mark. */
  readonly styles: Readonly<Record<string, CharStyle>>;
  /** Style for just the occupant id inside `( )` (e.g. {@link TEAM_STYLES}). */
  readonly idStyles: Readonly<Record<string, CharStyle>>;
  /** Hexes holding at least one ground club token; drawn as {@link CLUB_MARKER}. */
  readonly clubs: Readonly<Record<string, true>>;
}

// ---- board render info (types owned by render.ts) ----

import type { BoardRenderer, BoardRenderInfo } from "./render";

// ---- CSS class helper (web-layer) ----

/** Convert a {@link CharStyle} to a space-separated CSS class string. */
function styleClasses(style: CharStyle | undefined): string {
  if (style === undefined) return "";
  const parts: string[] = [];
  if (style.fg !== undefined) parts.push(`f-${style.fg}`);
  if (style.bg !== undefined) parts.push(`bg-${style.bg}`);
  if (style.bold === true) parts.push("b");
  if (style.italic === true) parts.push("i");
  if (style.cls !== undefined) parts.push(style.cls);
  return parts.join(" ");
}

// ---- constants (used by model builders below) ----

/** Glyphs drawn inside hexes by terrain type. */
const TERRAIN_GLYPHS: Readonly<Record<string, string>> = {
  clear: " ",
  lightWoods: "w",
  heavyWoods: "W",
  rough: "r",
  rubble: "R",
  pavement: "=",
  water1: "\u223c",
  water2: "\u2248",
  water3: "\u224b",
  lightBuilding: "b",
  mediumBuilding: "B",
  heavyBuilding: "#",
  hardenedBuilding: "H",
};

/** Per-terrain scheme hooks: the web layer maps each class to CSS vars. */
const TERRAIN_STYLES: Readonly<Record<string, CharStyle>> = {
  lightWoods: { cls: "t-lightWoods" },
  heavyWoods: { cls: "t-heavyWoods" },
  rough: { cls: "t-rough" },
  rubble: { cls: "t-rubble" },
  pavement: { cls: "t-pavement" },
  water1: { cls: "t-water1" },
  water2: { cls: "t-water2" },
  water3: { cls: "t-water3" },
  lightBuilding: { cls: "t-lightBuilding" },
  mediumBuilding: { cls: "t-mediumBuilding" },
  heavyBuilding: { cls: "t-heavyBuilding" },
  hardenedBuilding: { cls: "t-hardenedBuilding" },
};

/** Team-tinted unit ids: team 1 cyan, team 2 magenta. */
export const TEAM_STYLES: readonly CharStyle[] = [{ fg: "cyan" }, { fg: "magenta" }];

/** Board style for a team id (1 or 2); undefined for anything else. */
export function teamStyle(team: number): CharStyle | undefined {
  return TEAM_STYLES[team - 1];
}

/** Belly marker drawn in a reachable hex on the reachable map. */
export const REACHABLE_MARKER = "<>";

/** Bottom-row glyph (left of the terrain mark) in a hex holding a ground club. */
export const CLUB_MARKER = "!";

/** Style of the {@link CLUB_MARKER}; ignores terrain/team tints to stay visible. */
const CLUB_STYLE: CharStyle = { cls: "t-club", bold: true };

/**
 * Localised board legend text (e.g. `"legend: w(light woods)  W(heavy woods)"`).
 * `withClubs` appends the club marker entry.
 */
export function boardLegendText(map: MapDef, withClubs = false): string[] {
  const header = i18n("board.legend");
  const headerLen = compensatedLength(header);
  const widthMax = COL_STRIDE * map.width;
  let width = headerLen;
  let legends: string[] = [header];
  const lines: string[] = [];
  const delimiter = " ";
  const delimiterLen = delimiter.length;
  const entries = map.legends.map(
    (l) => `'${TERRAIN_GLYPHS[l]}'(${i18n(`terrain.${l}` as MessageKey)})`,
  );
  if (withClubs) entries.push(`'${CLUB_MARKER}'(${i18n("board.legendClub")})`);
  for (const lt of entries) {
    const ltLen = compensatedLength(lt);
    if (width >= widthMax - ltLen) {
      lines.push(legends.join(delimiter));
      width = headerLen;
      legends = [" ".repeat(headerLen)];
    }
    legends.push(lt);
    width += delimiterLen + ltLen;
  }
  if (legends.length > 0) lines.push(legends.join(delimiter));
  return lines;
}

// ---- canvas constants ----

/** Belly width holding unit ids / overlay glyphs. */
const BELLY_WIDTH = 6;
/** Unit ids clip to this many characters inside the belly. */
const ID_MAX_LEN = 4;
const HEX_WIDTH = 8;
/** Horizontal distance between column origins; columns sit flush. */
const COL_STRIDE = 6;
const ROW_STRIDE = 4;
const STAGGER = 2;

/**
 * Structural characters of the hex grid itself: the three horizontal edge
 * glyphs, the four diagonal wall segments (named by the direction they face
 * from the hex center) and the west/east belly walls. Content glyphs live in
 * {@link TERRAIN_GLYPHS} / `FACING_GLYPH`.
 */
export const GRID_GLYPHS = {
  edgeTop: "_",
  edgeShared: "=",
  edgeBottom: "\u203e",
  edgeNW: "/",
  edgeNE: "\\",
  edgeSE: "/",
  edgeSW: "\\",
  vertW: "(",
  vertE: ")",
} as const;
/** Characters allowed on an edge line. */
type EdgeGlyph =
  | typeof GRID_GLYPHS.edgeTop
  | typeof GRID_GLYPHS.edgeShared
  | typeof GRID_GLYPHS.edgeBottom;

/** Arrow drawn for each {@link Facing}, replacing the matching wall/edge char. */
// facing | arrow | triangle | triangle simple
//--------+-------+----------+-----------------
//   n    | u2191 | u25b2    | u25b2
//   ne   | u2197 | u25e5    | u25bc(s)
//   se   | u2198 | u25e2    | u25b2(n)
//   s    | u2193 | u25bc    | u25bc
//   sw   | u2199 | u25e3    | u25b2(n)
//   nw   | u2196 | u25e4    | u25bc(s)
export const FACING_GLYPH: Readonly<Record<Facing, string>> = {
  n: "\u25b2",
  ne: "\u25bc",
  se: "\u25b2",
  s: "\u25bc",
  sw: "\u25b2",
  nw: "\u25bc",
};

/** Canvas cell (x offset from the hex origin, absolute y) a facing edge sits on. */
function facingEdgePos(
  facing: Facing,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  switch (facing) {
    case "n":
      return { x: x + 3, y };
    case "s":
      return { x: x + 4, y: y + ROW_STRIDE };
    case "nw":
      return { x: x + 1, y: y + 1 };
    case "ne":
      return { x: x + 6, y: y + 1 };
    case "sw":
      return { x: x + 1, y: y + 3 };
    case "se":
      return { x: x + 6, y: y + 3 };
  }
}

// ---- canvas internals ----

/** Fit text into a fixed-width cell; overflow clips, shorter text centers. */
function fitCell(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  return text.padStart(text.length + left).padEnd(width);
}

/** 1-based `XXYY` coordinate label (two fixed digit pairs). */
function coordLabel(coord: HexCoord): string {
  return `${String(coord.col).padStart(2, "0")}${String(coord.row).padStart(2, "0")}`;
}

/** Canvas of painted characters plus per-cell style hints. */
export interface Canvas {
  readonly rows: string[][];
  readonly styles: (CharStyle | null)[][];
}

/** Allocate a blank canvas sized for `model`'s hex crop. */
export function makeCanvas(model: BoardModel): Canvas {
  const { cols, rows } = model;
  const canvasRows = rows * ROW_STRIDE + (cols >= 2 ? STAGGER : 0) + 1;
  const canvasCols = (cols - 1) * COL_STRIDE + HEX_WIDTH;
  return {
    rows: Array.from({ length: canvasRows }, () => Array.from({ length: canvasCols }, () => " ")),
    styles: Array.from({ length: canvasRows }, () =>
      Array.from({ length: canvasCols }, () => null),
    ),
  };
}

/** Paint `text` at (x,y), writing non-space glyphs and skipping spaces. */
function stampInto(
  canvas: Canvas,
  x: number,
  y: number,
  text: string,
  style: CharStyle | null,
): void {
  const line = canvas.rows[y];
  if (!line) return;
  for (let i = 0; i < text.length && x + i < line.length; i++) {
    const ch = text[i]!;
    if (ch !== " ") {
      line[x + i] = ch;
      canvas.styles[y]![x + i] = style;
    }
  }
}

/** Overwrite a single canvas cell (bounds-checked). */
function setChar(canvas: Canvas, x: number, y: number, ch: string, st: CharStyle | null): void {
  const line = canvas.rows[y];
  if (!line || x < 0 || x >= line.length) return;
  line[x] = ch;
  canvas.styles[y]![x] = st;
}

/** Fill a hexside edge with `ch`, never overwriting glyphs already there. */
function stampEdge(canvas: Canvas, x: number, y: number, ch: EdgeGlyph): void {
  const line = canvas.rows[y];
  if (!line) return;
  for (let i = x + 2; i <= x + 5 && i < line.length; i++) {
    if (line[i] === " ") line[i] = ch;
  }
}

/** Paint-position context for one hex within the model's crop. */
interface HexContext {
  readonly coord: HexCoord;
  readonly x: number;
  readonly y: number;
  readonly key: string;
  readonly cell: string | undefined;
  readonly mark: string | undefined;
  readonly elevation: number;
  readonly facing: Facing | undefined;
  readonly club: boolean;
  readonly idStyle: CharStyle | undefined;
  readonly style: CharStyle | null;
  readonly edgeStyles: Readonly<Record<string, CharStyle>>;
  readonly lastRow: boolean;
}

/** Yield each hex in the model with its canvas geometry and terrain style. */
export function* eachHex(model: BoardModel): Generator<HexContext, void, undefined> {
  const cols = model.cols + (model.anchorCol - 1);
  const rows = model.rows + (model.anchorRow - 1);
  for (let col = model.anchorCol; col <= cols; col++) {
    const baseY = col % 2 === 1 ? 0 : STAGGER;
    for (let row = model.anchorRow; row <= rows; row++) {
      const x = (col - model.anchorCol) * COL_STRIDE;
      const y = baseY + (row - model.anchorRow) * ROW_STRIDE;
      const coord: HexCoord = { col, row };
      const key = hexKey(coord);
      yield {
        coord,
        x,
        y,
        key,
        cell: model.cells[key],
        mark: model.marks[key],
        elevation: model.elevations[key] ?? 0,
        facing: model.facings[key],
        club: model.clubs[key] === true,
        idStyle: model.idStyles[key],
        style: model.styles[key] ?? null,
        edgeStyles: model.edgeStyles,
        lastRow: row === rows,
      };
    }
  }
}

/**
 * Assemble a {@link BoardModel} into the char/style canvases by painting
 * each visual layer per hex in a fixed order (grid → unit ids → terrain →
 * elevation → facing arrows → edge tint). The hexes are visited once,
 * column-major; sibling hexes share edge lines, so the shared `====` edge
 * (upper hex's bottom winning over the lower hex's `_` top) relies on
 * {@link stampEdge} only filling spaces, not on layer batching.
 */
function drawCanvas(model: BoardModel): Canvas {
  const canvas = makeCanvas(model);
  for (const hex of eachHex(model)) {
    drawHexGrid(canvas, hex);
    drawUnitIds(canvas, hex);
    drawTerrainMarks(canvas, hex);
    drawElevationDigits(canvas, hex);
    drawClubMarks(canvas, hex);
    drawFacingArrows(canvas, hex);
    applyEdgeStyles(canvas, hex);
  }
  return canvas;
}

/** Layer 1 — one hex's walls, coordinate labels, and shared/outer edges. */
function drawHexGrid(canvas: Canvas, hex: HexContext): void {
  const { coord, x, y, style, lastRow } = hex;
  stampEdge(canvas, x, y, GRID_GLYPHS.edgeTop);
  stampInto(
    canvas,
    x + 1,
    y + 1,
    `${GRID_GLYPHS.edgeNW}${coordLabel(coord)}${GRID_GLYPHS.edgeNE}`,
    style,
  );
  stampInto(
    canvas,
    x,
    y + 2,
    `${GRID_GLYPHS.vertW}${" ".repeat(BELLY_WIDTH)}${GRID_GLYPHS.vertE}`,
    style,
  );
  stampInto(canvas, x + 1, y + 3, `${GRID_GLYPHS.edgeSW}    ${GRID_GLYPHS.edgeSE}`, style);
  stampEdge(canvas, x, y + ROW_STRIDE, lastRow ? GRID_GLYPHS.edgeBottom : GRID_GLYPHS.edgeShared);
}

/** Layer 2 — one hex's occupant id centered inside its belly. */
function drawUnitIds(canvas: Canvas, hex: HexContext): void {
  const { x, y, cell, style, idStyle } = hex;
  const shown = cell?.slice(0, ID_MAX_LEN) ?? "";
  if (shown.length === 0) return;
  const left = Math.ceil((BELLY_WIDTH - shown.length) / 2);
  stampInto(canvas, x + 1 + left, y + 2, shown, idStyle ?? style);
}

/** Layer 3 — one hex's terrain glyph at the bottom, with a level digit suffix. */
function drawTerrainMarks(canvas: Canvas, hex: HexContext): void {
  const { x, y, mark, elevation, style } = hex;
  if (mark === undefined || mark.length === 0) return;
  stampInto(canvas, x + 2, y + 3, fitCell(`${mark}${elevation}`, 4), style);
}

/** Layer 4 — one hex's bare elevation digit when no terrain mark is shown. */
function drawElevationDigits(canvas: Canvas, hex: HexContext): void {
  const { x, y, mark, elevation, style } = hex;
  if (mark !== undefined && mark.length > 0) return;
  stampInto(canvas, x + 4, y + 3, String(elevation), style);
}

/** Layer 5 — one hex's club marker in the free bottom-left interior slot. */
function drawClubMarks(canvas: Canvas, hex: HexContext): void {
  if (!hex.club) return;
  stampInto(canvas, hex.x + 2, hex.y + 3, CLUB_MARKER, CLUB_STYLE);
}

/** Layer 6 — one hex's facing arrow overwriting its wall or edge glyph. */
function drawFacingArrows(canvas: Canvas, hex: HexContext): void {
  const { x, y, facing, idStyle, style } = hex;
  if (facing === undefined) return;
  const glyph = FACING_GLYPH[facing]!;
  const p = facingEdgePos(facing, x, y);
  setChar(canvas, p.x, p.y, glyph, idStyle ?? style);
}

/** Layer 7 — one hex's edge tinting: style-only pass over its hexside vertices. */
export function applyEdgeStyles(canvas: Canvas, hex: HexContext): void {
  const { x, y, key } = hex;
  for (const facing of FACINGS) {
    const es = hex.edgeStyles[`${key}:${facing}`];
    if (es === undefined) continue;
    const p = facingEdgePos(facing, x, y);
    const line = canvas.rows[p.y];
    if (line && p.x >= 0 && p.x < line.length) {
      canvas.styles[p.y]![p.x] = es;
    }
  }
}

function styleEquals(a: CharStyle | null, b: CharStyle | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic && a.cls === b.cls
  );
}

// ---- exported text renderers ----

/** Flat text form of a model — identical to the historic renderer output. */
export function boardToText(model: BoardModel): string {
  return drawCanvas(model)
    .rows.map((line) => line.join("").trimEnd())
    .join("\n");
}

/**
 * Styled form: per line, runs of characters sharing a style become one
 * {@link Span}. Concatenating span texts reproduces {@link boardToText}
 * exactly (including per-line trailing-space trimming).
 */
export function boardToSpans(model: BoardModel): Span[][] {
  const canvas = drawCanvas(model);
  return canvas.rows.map((line, y) => {
    const spans: Span[] = [];
    let text = "";
    let style: CharStyle | null = null;
    const flush = (): void => {
      if (text.length > 0) {
        spans.push(style === null ? { text } : { text, style });
      }
      text = "";
    };
    for (let x = 0; x < line.length; x++) {
      const s = canvas.styles[y]![x]!;
      if (!styleEquals(style, s)) flush();
      style = s;
      text += line[x]!;
    }
    flush();

    let end = spans.length;
    let cut = -1;
    for (let i = spans.length - 1; i >= 0; i--) {
      const sp = spans[i]!;
      if (sp.style !== undefined) break;
      const lastReal = sp.text.trimEnd().length;
      if (lastReal > 0) {
        cut = i;
        break;
      }
      end = i;
    }
    if (cut >= 0) {
      const kept = spans.slice(0, cut);
      const tail = spans[cut]!;
      const trimmed = tail.text.trimEnd();
      if (trimmed.length > 0) kept.push(trimmed === tail.text ? tail : { ...tail, text: trimmed });
      return kept;
    }
    return spans.slice(0, end);
  });
}

/**
 * Per-character form for CSS Grid rendering. Each character becomes an
 * independent span (single char), isolating `font-weight: bold` to single
 * glyphs. Trailing whitespace per line is trimmed to match
 * {@link boardToText}.
 */
export function boardToChars(model: BoardModel): Span[][] {
  return boardToSpans(model).map((line) => {
    const spans: Span[] = [];
    for (const sp of line) {
      if (sp.style === undefined) {
        for (const ch of sp.text) spans.push({ text: ch });
      } else {
        for (const ch of sp.text) spans.push({ text: ch, style: sp.style });
      }
    }
    return spans;
  });
}

// ---- BoardModel record derivation ----

/**
 * Derive per-terrain `CharStyle` keyed by `"col,row"` (non-clear cells only)
 * from a flat `HexCell[]` grid.
 */
function deriveTerrainStyles(grid: HexGrid): Record<string, CharStyle> {
  const m: Record<string, CharStyle> = {};
  const cells = grid.cells;
  const width = grid.width;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.terrain !== "clear") {
      const key = `${(i % width) + 1},${Math.floor(i / width) + 1}`;
      const st = TERRAIN_STYLES[cell.terrain];
      if (st !== undefined) m[key] = st;
    }
  }
  return m;
}

/**
 * Derive terrain mark glyphs keyed by `"col,row"` (non-clear cells only)
 * from a flat `HexCell[]` grid.
 */
function deriveTerrainMarks(grid: HexGrid): Record<string, string> {
  const m: Record<string, string> = {};
  const cells = grid.cells;
  const width = grid.width;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.terrain === "clear") continue;
    const key = `${(i % width) + 1},${Math.floor(i / width) + 1}`;
    const g = TERRAIN_GLYPHS[cell.terrain];
    if (g !== undefined) m[key] = g;
  }
  return m;
}

/**
 * Derive non-zero elevation entries keyed by `"col,row"` from a flat
 * `HexCell[]` grid.
 */
function deriveElevations(grid: HexGrid): Record<string, number> {
  const m: Record<string, number> = {};
  const cells = grid.cells;
  const width = grid.width;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.level !== 0) {
      m[`${(i % width) + 1},${Math.floor(i / width) + 1}`] = cell.level;
    }
  }
  return m;
}

/**
 * Derive terrain mark glyphs keyed by `"col,row"` from
 * {@link TerrainHexDef} entries (map display).
 */
function deriveMapMarks(terrain: readonly TerrainHexDef[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of terrain) {
    const glyph = TERRAIN_GLYPHS[t.type];
    if (glyph !== undefined) m[hexKey(t)] = glyph;
  }
  return m;
}

/**
 * Derive per-terrain `CharStyle` keyed by `"col,row"` from
 * {@link TerrainHexDef} entries (map display).
 */
function deriveMapStyles(terrain: readonly TerrainHexDef[]): Record<string, CharStyle> {
  const m: Record<string, CharStyle> = {};
  for (const t of terrain) {
    const st = TERRAIN_STYLES[t.type];
    if (st !== undefined) m[hexKey(t)] = st;
  }
  return m;
}

/**
 * Derive non-zero elevation entries keyed by `"col,row"` from
 * {@link TerrainHexDef} entries (map display). Hexes without an explicit
 * `level` default to 0 and are omitted.
 */
function deriveMapElevations(terrain: readonly TerrainHexDef[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const t of terrain) {
    const level = t.level ?? 0;
    if (level !== 0) m[hexKey(t)] = level;
  }
  return m;
}

// ---- model builders ----

/**
 * Structured static map sheet: terrain hexes draw their
 * {@link TERRAIN_GLYPHS} marker at the bottom center of the hex (`\ w /`),
 * tinted via {@link TERRAIN_STYLES}. Pass `styles` to override tinting.
 * Pass `elevations` to override the ground levels derived from
 * `map.terrain` (non-zero levels render beside the terrain mark, or as a
 * bare digit on clear hexes).
 */
export function mapModel(
  map: MapDef,
  styles?: Readonly<Record<string, CharStyle>>,
  elevations?: Readonly<Record<string, number>>,
): BoardModel {
  const filteredElevations =
    elevations === undefined
      ? deriveMapElevations(map.terrain)
      : Object.fromEntries(Object.entries(elevations).filter(([, v]) => v !== 0));
  return {
    cols: Math.max(1, map.width),
    rows: Math.max(1, map.height),
    anchorCol: 1,
    anchorRow: 1,
    cells: {},
    marks: deriveMapMarks(map.terrain),
    elevations: filteredElevations,
    facings: {},
    edgeStyles: {},
    styles: styles === undefined ? deriveMapStyles(map.terrain) : styles,
    idStyles: {},
    clubs: {},
  };
}

/**
 * Render a static map sheet from non-clear terrain hex definitions
 * (engine coordinates) at the given size. Terrain hexes draw their
 * {@link TERRAIN_GLYPHS} marker at the bottom center of the hex
 * (`\ w /`); everything else is clear ground.
 */
export function renderMap(map: MapDef): string {
  return boardToText(mapModel(map));
}

/**
 * Structured battle board: unit ids take precedence over hex contents.
 * Removed units are omitted; bounds come from `state.width`/`state.height`
 * when set, else the units + terrain extent. When `marks` is omitted,
 * terrain glyphs are derived automatically from `state.terrain`.
 */
export function battleModel(
  state: BattleState,
  overlay?: Readonly<Record<string, string>>,
  marks?: Readonly<Record<string, string>>,
  styles?: Readonly<Record<string, CharStyle>>,
): BoardModel {
  const width = state.width;
  const height = state.height;

  const cells: Record<string, string> = {};
  const facings: Record<string, Facing> = {};
  if (overlay !== undefined) Object.assign(cells, overlay);
  for (const unit of Object.values(state.units)) {
    if (isUnitRemoved(unit)) continue;
    const key = hexKey(unit.position);
    cells[key] = unit.id;
    facings[key] = unit.facing;
  }

  const elevations = deriveElevations(state);
  const autoCells: Record<string, CharStyle> = {};
  if (styles === undefined) {
    for (const unit of Object.values(state.units)) {
      if (isUnitRemoved(unit)) continue;
      const key = hexKey(unit.position);
      const team = teamStyle(unit.team);
      if (team !== undefined) autoCells[key] = team;
    }
  }
  return {
    cols: Math.max(1, width),
    rows: Math.max(1, height),
    anchorCol: 1,
    anchorRow: 1,
    cells,
    marks: marks ?? deriveTerrainMarks(state),
    elevations,
    facings,
    edgeStyles: {},
    styles: styles ?? deriveTerrainStyles(state),
    idStyles: autoCells,
    clubs: {},
  };
}

// ---- compose a BoardModel from BoardRenderInfo ----

/**
 * Build the {@link BoardModel} described by {@link BoardRenderInfo} for a
 * {@link BoardRenderer}. Terrain marks/styles/elevations always come from
 * `info.map`; when `info.units` is set, each unit draws its id (team-tinted)
 * and facing in its hex. When `info.reachables` is set, the model is cropped
 * to the reachable-landing bounding box (clamped to the map) and every
 * reachable landing tints its edge; empty non-actor reachable hexes show the
 * {@link REACHABLE_MARKER} belly glyph tinted with the acting unit's team
 * (`info.reachableTeam`).
 */
export function createBoardModel(info: BoardRenderInfo): BoardModel {
  const base = mapModel(info.map);
  const cells = { ...base.cells };
  const facings: Record<string, Facing> = {};
  const idStyles: Record<string, CharStyle> = {};
  const clubs: Record<string, true> = {};
  for (const key of info.clubHexes ?? []) clubs[key] = true;
  if (info.units !== null) {
    for (const unit of info.units) {
      const key = hexKey(unit.position);
      cells[key] = unit.ejected ? `-${unit.id}` : unit.id;
      facings[key] = unit.facing;
      const team = teamStyle(unit.team);
      if (team !== undefined) idStyles[key] = team;
    }
  }

  if (info.reachable === null) {
    return {
      cols: base.cols,
      rows: base.rows,
      anchorCol: base.anchorCol,
      anchorRow: base.anchorRow,
      cells,
      marks: base.marks,
      elevations: base.elevations,
      facings,
      edgeStyles: base.edgeStyles,
      styles: base.styles,
      idStyles,
      clubs,
    };
  }

  let minC = Infinity;
  let minR = Infinity;
  let maxC = -Infinity;
  let maxR = -Infinity;
  for (const l of info.reachable.revealed) {
    if (l.hex.col < minC) minC = l.hex.col;
    if (l.hex.col > maxC) maxC = l.hex.col;
    if (l.hex.row < minR) minR = l.hex.row;
    if (l.hex.row > maxR) maxR = l.hex.row;
  }
  const anchorCol = Math.max(1, minC);
  const anchorRow = Math.max(1, minR);
  const col1 = Math.min(base.cols, maxC);
  const row1 = Math.min(base.rows, maxR);

  const edgeStyles: Record<string, CharStyle> = {};
  const team = teamStyle(info.reachable.team);
  for (const l of info.reachable.revealed) {
    const key = hexKey(l.hex);
    if (team !== undefined) edgeStyles[`${key}:${l.facing}`] = team;
    if (cells[key] === undefined) {
      cells[key] = REACHABLE_MARKER;
      if (team !== undefined) idStyles[key] = team;
    }
  }

  return {
    cols: col1 - anchorCol + 1,
    rows: row1 - anchorRow + 1,
    anchorCol,
    anchorRow,
    cells,
    marks: base.marks,
    elevations: base.elevations,
    facings: {},
    edgeStyles,
    styles: base.styles,
    idStyles,
    clubs,
  };
}

// ---- board renderers (DOM) ----

function renderLegend(map: MapDef, el: Element, withClubs: boolean): void {
  const legendDiv = document.createElement("div");
  legendDiv.className = "board-legend";
  legendDiv.textContent = boardLegendText(map, withClubs).join("\n");
  el.appendChild(legendDiv);
}

/**
 * Row renderer: one `<div>` per board row. Runs of printable ASCII sharing a
 * style merge into one text span; any other glyph (water marks, Hangul ids)
 * gets its own inline-block 1ch cell, which keeps hex columns aligned when a
 * fallback font's advance differs. Text reads as whole lines for copy/paste
 * and screen readers.
 */
export const cssGridRenderer: BoardRenderer = (info, el) => {
  renderLegend(info.map, el, (info.clubHexes?.length ?? 0) > 0);
  const grid = document.createElement("div");
  grid.className = "board-grid board-rows";
  for (const line of boardToChars(createBoardModel(info))) {
    const row = document.createElement("div");
    let run: HTMLSpanElement | null = null;
    let runCls = "";
    for (const sp of line) {
      const cls = styleClasses(sp.style);
      if (sp.text.length !== 1 || sp.text.charCodeAt(0) > 126) {
        const cell = document.createElement("span");
        cell.className = cls === "" ? "cell" : `${cls} cell`;
        cell.textContent = sp.text;
        row.appendChild(cell);
        run = null;
        continue;
      }
      if (run === null || cls !== runCls) {
        run = document.createElement("span");
        run.className = cls;
        runCls = cls;
        row.appendChild(run);
      }
      run.textContent += sp.text;
    }
    grid.appendChild(row);
  }
  el.appendChild(grid);
};

/** Text renderer: flat text inside a `<div>`. */
export const textRenderer: BoardRenderer = (info, el) => {
  renderLegend(info.map, el, (info.clubHexes?.length ?? 0) > 0);
  const board = document.createElement("div");
  board.className = "board";
  const lines = boardToText(createBoardModel(info)).split("\n");
  lines.forEach((line, i) => {
    if (i > 0) board.append("\n");
    const span = document.createElement("span");
    span.textContent = line;
    board.appendChild(span);
  });
  el.appendChild(board);
};
