/**
 * The fixed 100×32 cell screen (plan §8.0) at the player's font size: whole px
 * in [MIN_FS, MAX_FS], changed only by the header's A− / A+ / Fit and kept in
 * localStorage. A window resize never changes it; CSS centres the screen and
 * clips or scrolls what doesn't fit. A first visit starts at the Fit size.
 */
export const COLS = 100;
export const ROWS = 32;
export const MIN_FS = 10;
export const MAX_FS = 40;
const STORAGE_KEY = "bt10x.ia.fontSize";

let onChange: (size: number, old: number) => void = () => {};

/** Called after every font-size change (after the kit re-measured). */
export function onFontSize(fn: (size: number, old: number) => void): void {
  onChange = fn;
}

export function fontSize(): number {
  return window.TUI.fontSize();
}

/** The largest size at which the whole screen fits the stage. */
export function fitFontSize(): number {
  return window.TUI.fitFontSize({
    container: document.getElementById("stage") ?? undefined,
    cols: COLS,
    rows: ROWS,
    min: MIN_FS,
    max: MAX_FS,
  });
}

function load(): number | null {
  try {
    const n = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function save(px: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(px));
  } catch {
    // private mode or blocked storage: the size lasts for this visit
  }
}

/** Set, save and announce a font size (clamped to the range). */
export function setFontSize(px: number): number {
  const size = Math.min(MAX_FS, Math.max(MIN_FS, Math.round(px)));
  const old = fontSize();
  save(size);
  if (size !== old) {
    window.TUI.setFontSize(size);
    onChange(size, old);
  }
  return size;
}

/**
 * Boot: the stored size, else the Fit size. A first visit fits again once the
 * web font has loaded (the fallback font's cell shape may differ), then keeps it.
 */
export function initFontSize(): void {
  window.TUI.autoFit(false);
  const stored = load();
  if (stored !== null) {
    setFontSize(stored);
    return;
  }
  setFontSize(fitFontSize());
  void document.fonts?.ready.then(() => {
    window.TUI.refresh();
    setFontSize(fitFontSize());
  });
}
