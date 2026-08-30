import type { BattleState, Facing, TerrainHexDef } from "btlib10x";
import { type LocaleId, t } from "./i18n/index.js";
import type { BoardModel, CharStyle, Span } from "./render.js";

// ---- BoardRenderer type ----

/**
 * Board renderer: populates a parent container. The renderer owns its DOM —
 * creates a legend div and its own board element.
 */
export type BoardRenderer = (model: BoardModel, el: Element) => void;

// ---- CSS class helper (web-layer) ----

/** Convert a {@link CharStyle} to a space-separated CSS class string. */
export function styleClasses(style: CharStyle | undefined): string {
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
export const TERRAIN_GLYPHS: Readonly<Record<string, string>> = {
  lightWoods: "w",
  heavyWoods: "W",
};

/** Per-terrain scheme hooks: the web layer maps each class to CSS vars. */
export const TERRAIN_STYLES: Readonly<Record<string, CharStyle>> = {
  lightWoods: { cls: "t-lightWoods" },
  heavyWoods: { cls: "t-heavyWoods" },
};

/** Team-tinted unit ids: team 0 cyan, team 1 magenta, others unstyled. */
export const TEAM_STYLES: readonly CharStyle[] = [{ fg: "cyan" }, { fg: "magenta" }];

/** Terrain legend list: `"w(lightWoods)  W(heavyWoods)"`. */
function terrainLegendList(): string {
  return Object.entries(TERRAIN_GLYPHS)
    .map(([type, glyph]) => `${glyph}(${type})`)
    .join("  ");
}

/** Localised board legend text (e.g. `"legend: w(lightWoods)  W(heavyWoods)"`). */
export function boardLegendText(locale: LocaleId): string {
  return t(locale, "board.legend", { list: terrainLegendList() });
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
const FACING_GLYPH: Readonly<Record<Facing, string>> = {
  n: "\u2191",
  ne: "\u2197",
  se: "\u2198",
  s: "\u2193",
  sw: "\u2199",
  nw: "\u2196",
};

// ---- canvas internals ----

/** Fit text into a fixed-width cell; overflow clips, shorter text centers. */
function fitCell(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  return text.padStart(text.length + left).padEnd(width);
}

/** 1-based `XXYY` coordinate label (two fixed digit pairs). */
function coordLabel(col: number, row: number): string {
  return `${String(col).padStart(2, "0")}${String(row).padStart(2, "0")}`;
}

interface Canvas {
  readonly rows: string[][];
  readonly styles: (CharStyle | null)[][];
}

function makeCanvas(model: BoardModel): Canvas {
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

/** Assemble a {@link BoardModel} into the char/style canvases. */
function drawCanvas(model: BoardModel): Canvas {
  const canvas = makeCanvas(model);
  const { cols, rows, cells, marks, elevations, styles, cellStyles, facings } = model;

  const setChar = (x: number, y: number, ch: string, st: CharStyle | null): void => {
    const line = canvas.rows[y];
    if (!line || x < 0 || x >= line.length) return;
    line[x] = ch;
    canvas.styles[y]![x] = st;
  };

  const stamp = (x: number, y: number, text: string, style: CharStyle | null = null): void =>
    stampInto(canvas, x, y, text, style);

  const stampEdge = (x: number, y: number, ch: EdgeGlyph): void => {
    const line = canvas.rows[y];
    if (!line) return;
    for (let i = x + 2; i <= x + 5 && i < line.length; i++) {
      if (line[i] === " ") line[i] = ch;
    }
  };

  for (let col = 1; col <= cols; col++) {
    const baseY = col % 2 === 1 ? STAGGER : 0;
    for (let row = 1; row <= rows; row++) {
      const y = baseY + (row - 1) * ROW_STRIDE;
      const key = `${col},${row}`;
      const cell = cells[key];
      const style = styles?.[key] ?? null;
      const x = (col - 1) * COL_STRIDE;
      stampEdge(x, y, GRID_GLYPHS.edgeTop);
      stamp(
        x + 1,
        y + 1,
        `${GRID_GLYPHS.edgeNW}${coordLabel(col, row)}${GRID_GLYPHS.edgeNE}`,
        style,
      );
      const shown = cell === undefined ? "" : cell.slice(0, ID_MAX_LEN);
      stamp(x, y + 2, `${GRID_GLYPHS.vertW}${" ".repeat(BELLY_WIDTH)}${GRID_GLYPHS.vertE}`, style);
      if (shown.length > 0) {
        const left = Math.ceil((BELLY_WIDTH - shown.length) / 2);
        stamp(x + 1 + left, y + 2, shown, cellStyles?.[key] ?? style);
      }
      stamp(x + 1, y + 3, `${GRID_GLYPHS.edgeSW}    ${GRID_GLYPHS.edgeSE}`, style);
      const mark = marks?.[key];
      const level = elevations?.[key] ?? 0;
      if (mark !== undefined && mark.length > 0) {
        stamp(x + 2, y + 3, fitCell(`${mark}${level}`, 4), style);
      } else {
        stamp(x + 4, y + 3, String(level), style);
      }
      stampEdge(x, y + ROW_STRIDE, row < rows ? GRID_GLYPHS.edgeShared : GRID_GLYPHS.edgeBottom);
      const f = facings?.[key];
      const glyph = f === undefined ? undefined : FACING_GLYPH[f];
      if (glyph !== undefined) {
        const arrowStyle = cellStyles?.[key] ?? style;
        if (glyph === FACING_GLYPH.n) setChar(x + 3, y, glyph, arrowStyle);
        else if (glyph === FACING_GLYPH.s) setChar(x + 4, y + ROW_STRIDE, glyph, arrowStyle);
        else if (glyph === FACING_GLYPH.nw) setChar(x + 1, y + 1, glyph, arrowStyle);
        else if (glyph === FACING_GLYPH.ne) setChar(x + 6, y + 1, glyph, arrowStyle);
        else if (glyph === FACING_GLYPH.sw) setChar(x + 1, y + 3, glyph, arrowStyle);
        else setChar(x + 6, y + 3, glyph, arrowStyle);
      }
    }
  }

  return canvas;
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

// ---- model builders ----

/**
 * Structured static map sheet: terrain hexes draw their
 * {@link TERRAIN_GLYPHS} marker at the bottom center of the hex (`\ w /`),
 * tinted via {@link TERRAIN_STYLES}. Pass `styles` to override tinting.
 * Pass `elevations` to render non-zero ground levels on the map.
 */
export function mapModel(
  terrain: readonly TerrainHexDef[],
  width: number,
  height: number,
  styles?: Readonly<Record<string, CharStyle>>,
  elevations?: Readonly<Record<string, number>>,
): BoardModel {
  const marks: Record<string, string> = {};
  const auto: Record<string, CharStyle> = {};
  for (const { col, row, type } of terrain) {
    const glyph = TERRAIN_GLYPHS[type];
    if (glyph !== undefined) {
      marks[`${col},${row}`] = glyph;
      const st = TERRAIN_STYLES[type];
      if (st !== undefined) auto[`${col},${row}`] = st;
    }
  }
  const filteredElevations =
    elevations !== undefined
      ? Object.fromEntries(Object.entries(elevations).filter(([, v]) => v !== 0))
      : undefined;
  return {
    cols: Math.max(1, width),
    rows: Math.max(1, height),
    cells: {},
    ...(Object.keys(marks).length > 0 ? { marks } : {}),
    ...(filteredElevations !== undefined && Object.keys(filteredElevations).length > 0
      ? { elevations: filteredElevations }
      : {}),
    ...(styles !== undefined ? { styles } : Object.keys(auto).length > 0 ? { styles: auto } : {}),
  };
}

/**
 * Render a static map sheet from non-clear terrain hex definitions
 * (engine coordinates) at the given size. Terrain hexes draw their
 * {@link TERRAIN_GLYPHS} marker at the bottom center of the hex
 * (`\ w /`); everything else is clear ground.
 */
export function renderMap(
  terrain: readonly TerrainHexDef[],
  width: number,
  height: number,
): string {
  return boardToText(mapModel(terrain, width, height));
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
  let maxCol = 0;
  let maxRow = 0;
  for (const unit of Object.values(state.units)) {
    if (unit.removed) continue;
    maxCol = Math.max(maxCol, unit.position.col);
    maxRow = Math.max(maxRow, unit.position.row);
  }
  for (const key of Object.keys(state.terrain)) {
    const parts = key.split(",");
    const c = Number(parts[0]);
    const r = Number(parts[1]);
    if (!Number.isNaN(c)) maxCol = Math.max(maxCol, c);
    if (!Number.isNaN(r)) maxRow = Math.max(maxRow, r);
  }

  const cells: Record<string, string> = {};
  const facings: Record<string, Facing> = {};
  if (overlay !== undefined) Object.assign(cells, overlay);
  const auto: Record<string, CharStyle> = {};
  for (const [tKey, tType] of Object.entries(state.terrain)) {
    const st = TERRAIN_STYLES[tType];
    if (st !== undefined) auto[tKey] = st;
  }
  const autoCells: Record<string, CharStyle> = {};
  for (const unit of Object.values(state.units)) {
    if (unit.removed) continue;
    const key = `${unit.position.col},${unit.position.row}`;
    cells[key] = unit.id;
    facings[key] = unit.facing;
    const team = TEAM_STYLES[unit.team];
    if (team !== undefined) autoCells[key] = team;
  }

  const resolvedMarks =
    marks ??
    (() => {
      const m: Record<string, string> = {};
      for (const [key, type] of Object.entries(state.terrain)) {
        const g = TERRAIN_GLYPHS[type];
        if (g !== undefined) m[key] = g;
      }
      return Object.keys(m).length > 0 ? m : undefined;
    })();

  const filteredElevations =
    state.elevation && Object.keys(state.elevation).length > 0
      ? Object.fromEntries(Object.entries(state.elevation).filter(([, v]) => v !== 0))
      : undefined;

  return {
    cols: Math.max(1, state.width ?? maxCol + 1),
    rows: Math.max(1, state.height ?? maxRow + 1),
    cells,
    ...(filteredElevations !== undefined && Object.keys(filteredElevations).length > 0
      ? { elevations: filteredElevations }
      : {}),
    ...(Object.keys(facings).length > 0 ? { facings } : {}),
    ...(resolvedMarks === undefined ? {} : { marks: resolvedMarks }),
    ...(styles !== undefined ? { styles } : Object.keys(auto).length > 0 ? { styles: auto } : {}),
    ...(styles === undefined && Object.keys(autoCells).length > 0 ? { cellStyles: autoCells } : {}),
  };
}

// ---- board renderers (DOM) ----

function renderLegend(el: Element, locale: LocaleId): void {
  const legendDiv = document.createElement("div");
  legendDiv.className = "board-legend";
  legendDiv.textContent = boardLegendText(locale);
  el.appendChild(legendDiv);
}

/** CSS Grid renderer: one `<span>` per character, bold isolated to single cells. */
export const cssGridRenderer: BoardRenderer = (model, el) => {
  renderLegend(el, "en");
  const grid = document.createElement("div");
  grid.className = "board-grid";
  const lines = boardToChars(model);
  const maxCols = Math.max(...lines.map((l) => l.length), 1);
  (grid as HTMLElement).style.gridTemplateColumns = `repeat(${maxCols}, 1ch)`;
  for (const line of lines) {
    for (const sp of line) {
      const span = document.createElement("span");
      span.className = styleClasses(sp.style);
      span.textContent = sp.text;
      grid.appendChild(span);
    }
    for (let p = line.length; p < maxCols; p++) {
      const span = document.createElement("span");
      span.textContent = "\u00a0";
      grid.appendChild(span);
    }
  }
  el.appendChild(grid);
};

/** Text renderer: flat text inside a `<div>`. */
export const textRenderer: BoardRenderer = (model, el) => {
  renderLegend(el, "en");
  const board = document.createElement("div");
  board.className = "board";
  const lines = boardToText(model).split("\n");
  lines.forEach((line, i) => {
    if (i > 0) board.append("\n");
    const span = document.createElement("span");
    span.textContent = line;
    board.appendChild(span);
  });
  el.appendChild(board);
};
