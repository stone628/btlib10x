/**
 * The fixed 100×32 cell screen (plan §8.0): one font size makes the grid as
 * large as the space between the header and the footer allows; the screen is
 * centred there by CSS. Below 12 px the
 * grid stays at 12 px and the page scrolls.
 */
export const COLS = 100;
export const ROWS = 32;
const CELL_W = 0.6;
const CELL_H = 1.175;
const MIN_FS = 12;

export function fitScreen(): number {
  const stage = document.getElementById("stage");
  const vw = stage?.clientWidth ?? document.documentElement.clientWidth;
  const vh = stage?.clientHeight ?? window.innerHeight;
  const ideal = Math.floor(Math.min(vw / (COLS * CELL_W), vh / (ROWS * CELL_H)));
  const fs = Math.max(MIN_FS, ideal);
  document.documentElement.style.setProperty("--tui-fs", `${fs}px`);
  const notice = document.getElementById("small-notice");
  if (notice) notice.hidden = ideal >= MIN_FS;
  window.TUI.refresh();
  return fs;
}
