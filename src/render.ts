import type { TerrainHexDef } from "./core/types.js";
import type { BattleState } from "./rules/game.js";

/**
 * ASCII board renderer for console output.
 *
 * Every hex is drawn as
 *
 *       ____
 *      /0101\
 *     ( wvr  )
 *      \ w0 /
 *       ====
 *      /0102\
 *     (      )
 *      \    /
 *       ‾‾‾‾
 *
 * where `/0101\` carries the 1-based column,row as fixed two-digit pairs,
 * `( wvr  )` is the occupying unit's id centered in the 6-char belly
 * (clipped when longer), and `\ w0 /` is the terrain glyph plus elevation
 * centered at the bottom (quick-start rules have no elevation: always 0).
 * Outer top edges render as `____`, edges shared with the hex below as
 * `====`, and the map's bottom edge as `‾‾‾‾`. Odd columns sit half a hex
 * lower, mirroring the odd-q flat-top grid.
 *
 * Besides the classic flat-text form ({@link renderMap}, {@link boardToText})
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
  /** Cell text drawn inside `/...\ ` (unit ids, overlay glyphs). */
  readonly cells: Readonly<Record<string, string>>;
  /** Glyphs drawn at the hex bottom center (e.g. terrain markers). */
  readonly marks?: Readonly<Record<string, string>> | undefined;
  /** Style applied to a hex's characters: grid rows plus cell text and mark. */
  readonly styles?: Readonly<Record<string, CharStyle>> | undefined;
}

/** Per-terrain scheme hooks: the web layer maps each class to CSS vars
 * (`--t-<type>` palette entries in web/index.html) unless a caller overrides
 * styles. */
export const TERRAIN_STYLES: Readonly<Record<string, CharStyle>> = {
  lightWoods: { cls: "t-lightWoods" },
  heavyWoods: { cls: "t-heavyWoods" },
};

/** Team-tinted unit ids: team 0 cyan, team 1 magenta, others unstyled. */
export const TEAM_STYLES: readonly CharStyle[] = [{ fg: "cyan" }, { fg: "magenta" }];

/** Belly width holding unit ids / overlay glyphs. */
const BELLY_WIDTH = 6;
const HEX_WIDTH = 8;
/** Horizontal distance between column origins; columns sit flush. */
const COL_STRIDE = 6;
const ROW_STRIDE = 4;
const STAGGER = 2;
/** Quick-start rules have no elevation; every hex renders at level 0. */
const ELEVATION_DIGIT = "0";

/** Fit text into a fixed-width cell; overflow clips, shorter text centers. */
function fitCell(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  return text.padStart(text.length + left).padEnd(width);
}

/** 1-based `XXYY` coordinate label (two fixed digit pairs). */
function coordLabel(col: number, row: number): string {
  return `${String(col + 1).padStart(2, "0")}${String(row + 1).padStart(2, "0")}`;
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

  // Edges fill only blank cells: a hex's bottom edge runs first and writes
  // `====` when another hex sits below, so the next top-edge stamp (`____`)
  // leaves it untouched.
  const stampEdge = (x: number, y: number, ch: "_" | "=" | "‾"): void => {
    const line = canvas.rows[y];
    if (!line) return;
    for (let i = x + 2; i <= x + 5 && i < line.length; i++) {
      if (line[i] === " ") line[i] = ch;
    }
  };

  for (let col = 0; col < cols; col++) {
    const baseY = col % 2 === 1 ? STAGGER : 0;
    for (let row = 0; row < rows; row++) {
      const y = baseY + row * ROW_STRIDE;
      const key = `${col},${row}`;
      const cell = cells[key];
      const style = styles?.[key] ?? null;
      const x = col * COL_STRIDE;
      stampEdge(x, y, "_");
      stamp(x + 1, y + 1, `/${coordLabel(col, row)}\\`, style);
      stamp(x, y + 2, `(${cell === undefined ? "      " : fitCell(cell, BELLY_WIDTH)})`, style);
      stamp(x + 1, y + 3, "\\    /", style);
      const mark = marks?.[key];
      if (mark !== undefined && mark.length > 0) {
        // Only the centered glyph+elevation: the surrounding "\    /" edges
        // belong to this hex already, and restamping them would overwrite.
        stamp(x + 2, y + 3, fitCell(`${mark}${ELEVATION_DIGIT}`, 4), style);
      }
      stampEdge(x, y + ROW_STRIDE, row + 1 < rows ? "=" : "‾");
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
 * Removed units are omitted; bounds come from `state.width`/`state.height`
 * when set, else the units + terrain extent.
 * The optional `overlay` maps `"col,row"` keys to short glyphs (up to 3
 * chars) drawn inside empty hexes. The optional `marks` maps keys to glyphs
 * at the hex bottom center (see renderMap). Styles default to terrain
 * tints plus {@link TEAM_STYLES} for unit ids; an explicit `styles` record
 * replaces them entirely.
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
    cols: Math.max(1, state.width ?? maxCol + 1),
    rows: Math.max(1, state.height ?? maxRow + 1),
    cells,
    ...(marks === undefined ? {} : { marks }),
    ...(styles !== undefined ? { styles } : Object.keys(auto).length > 0 ? { styles: auto } : {}),
  };
}

