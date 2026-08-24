import type { TerrainHexDef } from "./core/types.js";
import type { BattleState } from "./rules/game.js";

/**
 * ASCII board renderer for console output.
 *
 * Every hex is drawn as
 *
 *     ---
 *    /???\
 *   <XX,YY>
 *    \   /
 *     ---
 *
 * where `???` is the occupying unit's id clipped/padded to 3 characters and
 * `XX,YY` is the space-aligned 1-based column,row (col right-aligned, row
 * left-aligned). Horizontal borders default to `---`; where two hexes share
 * an edge (the border is stamped twice) they render as `===`, suggesting
 * tightly packed hexes. Odd columns sit half a hex lower, mirroring the
 * odd-q flat-top grid.
 *
 * Besides the classic flat-text form ({@link renderMap}, {@link renderBattle})
 * the renderer can emit a {@link BoardModel} plus styled spans
 * ({@link boardToSpans}) carrying per-character color/weight hints. Styling
 * travels beside the text — never inline — so geometry math always sees the
 * plain character counts.
 */

/** Glyphs drawn inside hexes by terrain type (see renderMap). */
export const TERRAIN_GLYPHS: Readonly<Record<string, string>> = {
  lightWoods: "w",
  heavyWoods: "W",
};

/** Named palette slots; the web layer maps these to CSS variables. */
export type ColorName =
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "dim";

/** Per-character presentation hints for styled board output. */
export interface CharStyle {
  readonly fg?: ColorName | undefined;
  readonly bg?: ColorName | undefined;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
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
  /** Cell text drawn inside `/...\ ` (unit ids, overlay glyphs). */
  readonly cells: Readonly<Record<string, string>>;
  /** Glyphs drawn at the hex bottom center (e.g. terrain markers). */
  readonly marks?: Readonly<Record<string, string>> | undefined;
  /** Style applied to a hex's content characters (cell text and mark). */
  readonly styles?: Readonly<Record<string, CharStyle>> | undefined;
}

/** Semantic terrain tinting used unless a caller overrides styles. */
export const TERRAIN_STYLES: Readonly<Record<string, CharStyle>> = {
  lightWoods: { fg: "green" },
  heavyWoods: { fg: "green", bg: "dim", bold: true },
};

/** Team-tinted unit ids: team 0 cyan, team 1 magenta, others unstyled. */
export const TEAM_STYLES: readonly CharStyle[] = [{ fg: "cyan" }, { fg: "magenta" }];

const HEX_WIDTH = 7;
/** Horizontal distance between column origins; lets diagonal edges interlock. */
const COL_STRIDE = 5;
const ROW_STRIDE = 4;
const STAGGER = 2;

function pad2(n: number): string {
  return String(n).padStart(2);
}

/** Fit text into the 3-char hex cell; ids clip right-aligned, glyphs center. */
function fitCell(text: string): string {
  if (text.length >= 3) return text.slice(0, 3);
  const left = Math.floor((3 - text.length) / 2);
  return text.padStart(text.length + left).padEnd(3);
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
    rows: Array.from({ length: canvasRows }, () =>
      Array.from({ length: canvasCols }, () => " "),
    ),
    styles: Array.from({ length: canvasRows }, () =>
      Array.from({ length: canvasCols }, () => null),
    ),
  };
}

function stampInto(canvas: Canvas, x: number, y: number, text: string, style: CharStyle | null): void {
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
  const { cols, rows, cells, marks, styles } = model;

  // Overlay stamping: spaces never erase glyphs already on the canvas, so
  // neighboring hexes' edges nest tightly.
  const stamp = (x: number, y: number, text: string, style: CharStyle | null = null): void =>
    stampInto(canvas, x, y, text, style);

  // Borders are `---` unless another border already occupies the cell, in
  // which case the shared edge becomes `===`.
  const stampBorder = (x: number, y: number): void => {
    const line = canvas.rows[y];
    if (!line) return;
    for (let i = x + 2; i <= x + 4 && i < line.length; i++) {
      line[i] = line[i] === " " ? "-" : "=";
    }
  };

  for (let col = 0; col < cols; col++) {
    const baseY = col % 2 === 1 ? STAGGER : 0;
    for (let row = 0; row < rows; row++) {
      const y = baseY + row * ROW_STRIDE;
      const key = `${col},${row}`;
      const cell = cells[key];
      const style = styles?.[key] ?? null;
      stampBorder(col * COL_STRIDE, y);
      stamp(col * COL_STRIDE, y + 1, ` /${cell === undefined ? "   " : fitCell(cell)}\\ `, style);
      stamp(col * COL_STRIDE, y + 2, `<${pad2(col + 1)},${String(row + 1).padEnd(2)}>`);
      stamp(col * COL_STRIDE, y + 3, " \\   / ");
      const mark = marks?.[key];
      if (mark !== undefined && mark.length > 0) {
        // Only the centered glyph: the surrounding "\   /" edges belong to
        // this hex already, and restamping them would overwrite neighbors.
        stamp(col * COL_STRIDE + 2, y + 3, fitCell(mark), style);
      }
      stampBorder(col * COL_STRIDE, y + ROW_STRIDE);
    }
  }

  return canvas;
}

function styleEquals(a: CharStyle | null, b: CharStyle | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic;
}

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

    // Mirror trimEnd(): drop trailing unstyled whitespace across spans.
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
 * Structured static map sheet: terrain hexes draw their
 * {@link TERRAIN_GLYPHS} marker at the bottom center of the hex (`\ w /`),
 * tinted via {@link TERRAIN_STYLES}. Pass `styles` to override tinting.
 */
export function mapModel(
  terrain: readonly TerrainHexDef[],
  width: number,
  height: number,
  styles?: Readonly<Record<string, CharStyle>>,
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
  return {
    cols: Math.max(1, width),
    rows: Math.max(1, height),
    cells: {},
    ...(Object.keys(marks).length > 0 ? { marks } : {}),
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
 * Removed units are omitted; bounds default to the units + terrain extent.
 * The optional `overlay` maps `"col,row"` keys to short glyphs (up to 3
 * chars) drawn inside empty hexes. The optional `marks` maps keys to glyphs
 * at the hex bottom center (see renderMap). Styles default to terrain
 * tints plus {@link TEAM_STYLES} for unit ids; an explicit `styles` record
 * replaces them entirely.
 */
export function battleModel(
  state: BattleState,
  width?: number,
  height?: number,
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
  if (overlay !== undefined) Object.assign(cells, overlay);
  const auto: Record<string, CharStyle> = {};
  for (const [tKey, tType] of Object.entries(state.terrain)) {
    const st = TERRAIN_STYLES[tType];
    if (st !== undefined) auto[tKey] = st;
  }
  for (const unit of Object.values(state.units)) {
    if (unit.removed) continue;
    const key = `${unit.position.col},${unit.position.row}`;
    cells[key] = unit.id;
    const team = TEAM_STYLES[unit.team];
    if (team !== undefined) auto[key] = team;
  }

  return {
    cols: Math.max(1, width ?? maxCol + 1),
    rows: Math.max(1, height ?? maxRow + 1),
    cells,
    ...(marks === undefined ? {} : { marks }),
    ...(styles !== undefined ? { styles } : Object.keys(auto).length > 0 ? { styles: auto } : {}),
  };
}

/**
 * Render a battle: unit ids take precedence over hex contents. Removed units
 * are omitted; board bounds default to the units + terrain extent. The
 * optional `overlay` maps `"col,row"` keys to short glyphs (up to 3 chars)
 * drawn inside empty hexes — e.g. terrain markers. The optional `marks` maps
 * `"col,row"` keys to glyphs drawn at the hex bottom center (see renderMap).
 */
export function renderBattle(
  state: BattleState,
  width?: number,
  height?: number,
  overlay?: Readonly<Record<string, string>>,
  marks?: Readonly<Record<string, string>>,
): string {
  return boardToText(battleModel(state, width, height, overlay, marks));
}
