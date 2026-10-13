import { compensatedLength } from "./i18n";
import { type BoardRenderer, type BoardRenderInfo, getBoardRenderer } from "./render";

/** One presentation chunk of command output. */
export type Chunk =
  | { readonly kind: "lines"; lines: readonly string[]; readonly cls?: string }
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

export function buildLinesChunk(...lines: readonly string[]): Chunk {
  return { kind: "lines", lines: lines };
}

export function buildLinesChunkWith(cls: string, ...lines: string[]): Chunk {
  return { kind: "lines", lines: lines, cls: cls };
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
    let w = currHeader == null ? 0 : compensatedLength(currHeader!);
    for (const row of rows) {
      const cell = row[i];
      if (cell !== undefined) {
        const cellLen = compensatedLength(cell);
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
    let w = currHeader === null ? 0 : compensatedLength(currHeader!);
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
          const cellLen = compensatedLength(cell);
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
