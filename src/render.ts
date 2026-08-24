import type { Facing, TerrainHexDef } from "./core/types.js";
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
 * `( wvr  )` is the occupying unit's id (max 4 chars, clipped when longer)
 * centered in the 6-char belly, and `\ w0 /` is the terrain glyph plus
 * elevation centered at the bottom (quick-start rules have no elevation:
 * always 0).
 * A unit's facing replaces the grid character at its hexside vertex:
 * n `↑` on the top edge's 2nd char, s `↓` on the bottom edge's 3rd char,
 * nw/ne `↖`/`↗` on the upper walls, sw/se `↙`/`↘` on the lower walls.
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
  /** Per-hex mech facing (`"col,row"` → {@link Facing}); drawn on the grid. */
  readonly facings?: Readonly<Record<string, Facing>> | undefined;
  /** Style applied to a hex's characters: grid rows, belly parens and mark. */
  readonly styles?: Readonly<Record<string, CharStyle>> | undefined;
  /**
   * Style for just the occupant id inside `( )` (e.g. {@link TEAM_STYLES});
   * falls back to the hex-wide {@link styles} entry when absent.
   */
  readonly cellStyles?: Readonly<Record<string, CharStyle>> | undefined;
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
/** Unit ids clip to this many characters inside the belly. */
const ID_MAX_LEN = 4;
const HEX_WIDTH = 8;
/** Horizontal distance between column origins; columns sit flush. */
const COL_STRIDE = 6;
const ROW_STRIDE = 4;
const STAGGER = 2;
/** Quick-start rules have no elevation; every hex renders at level 0. */
const ELEVATION_DIGIT = "0";

/**
 * Structural characters of the hex grid itself: the three horizontal edge
 * glyphs, the four diagonal wall segments (named by the direction they face
 * from the hex center) and the west/east belly walls. Content glyphs live in
 * {@link TERRAIN_GLYPHS} / {@link FACING_GLYPH}.
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
  const { cols, rows, cells, marks, styles, cellStyles, facings } = model;

  // Overwrite one canvas cell; an explicit style re-tints it (facing arrows
  // carry the team color even though they sit on unstyled edges).
  const setChar = (x: number, y: number, ch: string, st: CharStyle | null): void => {
    const line = canvas.rows[y];
    if (!line || x < 0 || x >= line.length) return;
    line[x] = ch;
    canvas.styles[y]![x] = st;
  };

  // Overlay stamping: spaces never erase glyphs already on the canvas, so
  // neighboring hexes' edges nest tightly.
  const stamp = (x: number, y: number, text: string, style: CharStyle | null = null): void =>
    stampInto(canvas, x, y, text, style);

  // Edges fill only blank cells: a hex's bottom edge runs first and writes
  // `====` when another hex sits below, so the next top-edge stamp (`____`)
  // leaves it untouched.
  const stampEdge = (x: number, y: number, ch: EdgeGlyph): void => {
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
      stampEdge(x, y, GRID_GLYPHS.edgeTop);
      stamp(
        x + 1,
        y + 1,
        `${GRID_GLYPHS.edgeNW}${coordLabel(col, row)}${GRID_GLYPHS.edgeNE}`,
        style,
      );
      // The occupant id carries its own style (cellStyles); parens and grid
      // rows keep the hex-wide style so e.g. team colors touch only the id.
      // Ids clip to ID_MAX_LEN and sit round half up, so 3-char ids start at
      // the belly's 4th character: "(  hbk )". (fitCell's floor-left padding
      // would bias ids toward the west wall.)
      const shown = cell === undefined ? "" : cell.slice(0, ID_MAX_LEN);
      stamp(x, y + 2, `${GRID_GLYPHS.vertW}${" ".repeat(BELLY_WIDTH)}${GRID_GLYPHS.vertE}`, style);
      if (shown.length > 0) {
        const left = Math.ceil((BELLY_WIDTH - shown.length) / 2);
        stamp(x + 1 + left, y + 2, shown, cellStyles?.[key] ?? style);
      }
      stamp(x + 1, y + 3, `${GRID_GLYPHS.edgeSW}    ${GRID_GLYPHS.edgeSE}`, style);
      const mark = marks?.[key];
      if (mark !== undefined && mark.length > 0) {
        // Only the centered glyph+elevation: the surrounding "\    /" edges
        // belong to this hex already, and restamping them would overwrite.
        stamp(x + 2, y + 3, fitCell(`${mark}${ELEVATION_DIGIT}`, 4), style);
      }
      stampEdge(
        x,
        y + ROW_STRIDE,
        row + 1 < rows ? GRID_GLYPHS.edgeShared : GRID_GLYPHS.edgeBottom,
      );
      const f = facings?.[key];
      const glyph = f === undefined ? undefined : FACING_GLYPH[f];
      if (glyph !== undefined) {
        // The arrow wears the occupant's style (team color), falling back to
        // the hex-wide style for models without cellStyles.
        const arrowStyle = cellStyles?.[key] ?? style;
        if (glyph === FACING_GLYPH.n) setChar(x + 3, y, glyph, arrowStyle);
        // Top edge's 2nd char / bottom edge's 3rd char keep both arrows of a
        // vertically shared edge visible.
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
 * at the hex bottom center (see renderMap). Unit facings are derived
 * automatically and replace their hexside vertex characters. Styles default
 * to terrain tints on the grid rows plus {@link TEAM_STYLES} on just the unit
 * ids (via `cellStyles`); an explicit `styles` record replaces all automatic
 * styling entirely.
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
  // Team colors tint only the id characters; hex-wide styles stay terrain.
  const autoCells: Record<string, CharStyle> = {};
  for (const unit of Object.values(state.units)) {
    if (unit.removed) continue;
    const key = `${unit.position.col},${unit.position.row}`;
    cells[key] = unit.id;
    facings[key] = unit.facing;
    const team = TEAM_STYLES[unit.team];
    if (team !== undefined) autoCells[key] = team;
  }

  return {
    cols: Math.max(1, state.width ?? maxCol + 1),
    rows: Math.max(1, state.height ?? maxRow + 1),
    cells,
    ...(Object.keys(facings).length > 0 ? { facings } : {}),
    ...(marks === undefined ? {} : { marks }),
    ...(styles !== undefined ? { styles } : Object.keys(auto).length > 0 ? { styles: auto } : {}),
    ...(styles === undefined && Object.keys(autoCells).length > 0
      ? { cellStyles: autoCells }
      : {}),
  };
}

