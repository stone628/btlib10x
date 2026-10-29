/**
 * Every glyph the Instant Action screens draw, by role (like the terminal's
 * GRID_THEME in web/terminal/session.common.ts). Screens take glyphs from
 * here instead of writing them inline, so a glyph set can change in one
 * place. The title logo is art and keeps its own characters; i18n strings
 * keep theirs.
 */
export const UI_THEME = {
  /** Double-line screen frame, with the joints where tabs break it. */
  FRAME: {
    h: "═", // horizontal line
    v: "║", // vertical line
    nw: "╔", // top left corner
    ne: "╗", // top right corner
    sw: "╚", // bottom left corner
    se: "╝", // bottom right corner
    w: "╠", // left edge joint (logs drawer top)
    e: "╣", // right edge joint (logs drawer top)
    hEndL: "╛", // horizontal line ending into a light line from below, left of a tab
    hEndR: "╘", // the same, right of a tab
    vEndUp: "╙", // vertical line ending, light line out to the right
    vEndDown: "╓", // vertical line starting, light line out to the right
    vEndUpL: "╜", // vertical line ending, light line out to the left
    vEndDownL: "╖", // vertical line starting, light line out to the left
  },
  /** Light-line grid of the record sheet. */
  GRID: {
    tnw: "┌", // top left corner of grid
    tn: "┬", // separator for top line of grid
    tne: "┐", // top right corner of grid
    tw: "├", // left end of an inner line of grid
    tc: "┼", // separator for an inner line of grid
    te: "┤", // right end of an inner line of grid
    tsw: "└", // bottom left corner of grid
    ts: "┴", // separator for bottom line of grid
    tse: "┘", // bottom right corner of grid
    th: "─", // horizontal line of grid
    tv: "│", // vertical line of grid
  },
  /** Rounded corners: tabs, the sheet box and the HT cap. */
  ROUND: {
    nw: "╭",
    ne: "╮",
    sw: "╰",
    se: "╯",
  },
  /** Marks. Clickables use plain `[ ]`; `⦗ ⦘` wrap read-only chips. */
  MARK: {
    chipL: "⦗",
    chipR: "⦘",
    on: "•", // chosen item in a list or mode bar
    out: "×", // unit out of play
    times: "×", // multiplication: cluster shots, map size, zoom
    sep: "·", // separator between facts on one line
    more: "…", // cut text
  },
  ARROW: {
    to: "→", // queue order, attacker to target
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    /** Facing arrows n, ne, se, s, sw, nw. */
    facing: ["↑", "↗", "↘", "↓", "↙", "↖"],
    cursor: "▸", // menu cursor
    prev: "◂", // previous target
    next: "▸", // next target
    drop: "▾", // dropdown
    pick: "▼", // sheet unit picker
    tabR: "▶", // tab pointing right
    tabL: "◀", // tab pointing left
    tabUp: "▲",
    tabDown: "▼",
    current: ["▶", "◀"], // around the acting unit in the queue
    reroll: "↻",
    rotate: "⟲",
    tilt: "⦟",
  },
  /** Meters: heat bar, component pips, movement pips. */
  BAR: {
    full: "█",
    empty: "░",
    capL: "▕",
    capR: "▏",
    pipTaken: "□",
    pipLeft: "■",
    mpOn: "▮",
    mpOff: "▯",
  },
} as const;
