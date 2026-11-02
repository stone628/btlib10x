/**
 * The fixed 100×32 cell screen at the player's font size: whole px in
 * [MIN_FS, MAX_FS], set by the header's A− / A+ / Fit and kept in
 * localStorage. Fit is a mode, stored as "fit": the size is fitted again on
 * every load and window resize. A− / A+ store a fixed size, which a resize
 * never changes; CSS centres the screen and clips or scrolls what doesn't
 * fit. A first visit starts in Fit mode.
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

/** "fit", or the size the player chose with A− / A+. */
type Stored = number | "fit";

let mode: Stored = "fit";

function load(): Stored | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "fit") return "fit";
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function save(v: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    // private mode or blocked storage: the size lasts for this visit
  }
}

/** True while the size follows the window (the Fit mode). */
export function fitMode(): boolean {
  return mode === "fit";
}

function apply(px: number): number {
  const size = Math.min(MAX_FS, Math.max(MIN_FS, Math.round(px)));
  const old = fontSize();
  if (size !== old) {
    window.TUI.setFontSize(size);
    onChange(size, old);
  }
  return size;
}

/** Set, save and announce a fixed font size (clamped to the range); leaves Fit mode. */
export function setFontSize(px: number): number {
  const size = apply(px);
  mode = size;
  save(size);
  return size;
}

/** Enter Fit mode: fit now, and again on every resize. */
export function fitFont(): number {
  mode = "fit";
  save("fit");
  return apply(fitFontSize());
}

/**
 * Boot: the stored size, else Fit mode. Fit mode fits again once the web
 * font has loaded (the fallback font's cell shape may differ) and on every
 * window resize.
 */
export function initFontSize(): void {
  window.TUI.autoFit(false);
  const stored = load();
  if (typeof stored === "number") setFontSize(stored);
  else fitFont();
  void document.fonts?.ready.then(() => {
    if (mode !== "fit") return;
    window.TUI.refresh();
    apply(fitFontSize());
  });
  let pending = false;
  window.addEventListener("resize", () => {
    if (mode !== "fit" || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (mode === "fit") apply(fitFontSize());
    });
  });
}
