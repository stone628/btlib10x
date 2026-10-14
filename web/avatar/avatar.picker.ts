import { GLYPH_BLOCKS } from "./avatar.glyphs";
import { BLANK, codePointLabel, isAllowedGlyph, type SlotDef } from "./avatar.override";

/**
 * Glyph selector panel for one avatar slot. It has no preview of its own:
 * clicking a glyph (or blank / use variant) only previews it, the caller
 * re-renders the avatar on every `onPreview`, and the panel sits above that
 * avatar so both stay in view. Nothing is saved until apply.
 */
export interface PickerOptions {
  slot: SlotDef;
  /** The slot's glyph right now (variant or override). */
  current: string;
  /** The glyph the slot's variant draws, shown when "use variant" is previewed. */
  variant: string;
  /** The element the panel floats above (the slot map). */
  anchor: HTMLElement;
  /** Show `ch` in the slot without saving; `null` restores the saved glyph. */
  onPreview(ch: string | null): void;
  /** Commit: a glyph, or `null` to go back to the variant's own glyph. */
  onPick(ch: string | null): void;
  /** Panel closed, after apply or cancel. */
  onClose(): void;
}

interface Group {
  name: string;
  glyphs: string[];
}

const RECENT_KEY = "bt10x.avatar.recent";
const PINNED_KEY = "bt10x.avatar.pinned";
/** More than two rows hold on any width; the rows show what fits. */
const RECENT_MAX = 64;
const RECENT_ROWS = 2;
/** Hold a recent cell this long to pin or unpin it. */
const LONG_PRESS_MS = 500;
/** Below this much room above the map, the panel takes the top of the screen instead. */
const MIN_ROOM = 220;
const GAP = 8;

const BLOCK_GROUPS: Group[] = GLYPH_BLOCKS.map((b) => ({
  name: b.name,
  glyphs: b.ranges.flatMap(([lo, hi]) =>
    Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCodePoint(lo + i)),
  ),
}));

function loadGlyphs(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && isAllowedGlyph(v));
  } catch {
    return [];
  }
}

function saveGlyphs(key: string, glyphs: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(glyphs));
  } catch {
    // Storage may be blocked: the recent rows just stay empty.
  }
}

function pushRecent(ch: string): void {
  if (ch === BLANK) return;
  saveGlyphs(
    RECENT_KEY,
    [ch, ...loadGlyphs(RECENT_KEY).filter((c) => c !== ch)].slice(0, RECENT_MAX),
  );
}

/** Pin `ch` (first in the recent rows), or unpin it when already pinned. */
function togglePin(ch: string): void {
  const pinned = loadGlyphs(PINNED_KEY);
  saveGlyphs(PINNED_KEY, pinned.includes(ch) ? pinned.filter((c) => c !== ch) : [...pinned, ch]);
}

/** Recent rows content: pinned glyphs first, then the latest picks. */
function recentRow(): { glyphs: string[]; pinned: Set<string> } {
  const pinned = loadGlyphs(PINNED_KEY);
  const recent = loadGlyphs(RECENT_KEY).filter((c) => !pinned.includes(c));
  return { glyphs: [...pinned, ...recent], pinned: new Set(pinned) };
}

/** A grid cell; the glyph sits in a box the size of one avatar cell. */
function glyphCell(ch: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "gp-cell";
  b.dataset.ch = ch;
  const g = document.createElement("span");
  g.className = "gp-glyph";
  g.textContent = ch;
  b.append(g);
  b.title = codePointLabel(ch);
  b.setAttribute("aria-label", codePointLabel(ch));
  return b;
}

/** A pasted character or `U+XXXX` text, as one code point; null when it is neither. */
export function parseFind(text: string): string | null {
  const t = text.trim();
  const m = /^u\+([0-9a-f]{4,6})$/i.exec(t);
  if (m !== null) {
    const cp = Number.parseInt(m[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  const cps = Array.from(t);
  return cps.length === 1 ? cps[0]! : null;
}

let openPanel: { close(): void } | null = null;

export function isPickerOpen(): boolean {
  return openPanel !== null;
}

export function openPicker(dialog: HTMLDialogElement, opts: PickerOptions): void {
  openPanel?.close();

  const groups = BLOCK_GROUPS;

  let groupIdx = Math.max(
    0,
    groups.findIndex((g) => g.glyphs.includes(opts.current)),
  );
  let focusIdx = 0;
  let closed = false;
  /** Previewed but not applied: a glyph, `null` for the variant, `undefined` for none. */
  let pending: string | null | undefined;

  dialog.replaceChildren();
  dialog.className = "glyph-picker";
  dialog.setAttribute("aria-label", `choose a character for ${opts.slot.title}`);

  const title = document.createElement("div");
  title.className = "gp-title";
  const titleName = document.createElement("span");
  titleName.textContent = opts.slot.title.toUpperCase();
  /** Code point of the focused glyph, or a find message. */
  const status = document.createElement("span");
  status.className = "gp-status";
  status.setAttribute("aria-live", "polite");
  title.append(titleName, status);

  const controls = document.createElement("div");
  controls.className = "gp-controls";
  const groupLabel = document.createElement("label");
  groupLabel.textContent = "group ";
  const select = document.createElement("select");
  for (const [i, g] of groups.entries()) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = g.name;
    select.append(o);
  }
  groupLabel.append(select);
  const findLabel = document.createElement("label");
  findLabel.textContent = "find ";
  const find = document.createElement("input");
  find.type = "text";
  find.placeholder = "paste a char or U+2622";
  find.autocomplete = "off";
  find.spellcheck = false;
  findLabel.append(find);
  controls.append(groupLabel, findLabel);

  const grid = document.createElement("div");
  grid.className = "gp-grid";
  grid.setAttribute("role", "grid");

  const recentBox = document.createElement("div");
  recentBox.className = "gp-recent";
  const recentLabel = document.createElement("div");
  recentLabel.className = "gp-recent-label";
  recentLabel.textContent = "recent · hold to pin";
  const recentGrid = document.createElement("div");
  recentGrid.className = "gp-grid gp-recent-grid";
  recentGrid.setAttribute("role", "grid");
  recentGrid.setAttribute("aria-label", "recent and pinned; hold or press P to pin");
  recentBox.append(recentLabel, recentGrid);

  const footer = document.createElement("div");
  footer.className = "gp-footer";
  const mkButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };
  const buttons = document.createElement("span");
  buttons.className = "gp-buttons";
  buttons.append(
    mkButton("blank", () => choose(BLANK)),
    mkButton("use variant", () => choose(null)),
    mkButton("cancel", () => cancel()),
  );
  const apply = mkButton("apply", () => commit());
  apply.classList.add("gp-apply");
  apply.disabled = true;
  buttons.append(apply);
  footer.append(buttons);

  dialog.append(title, controls, grid, recentBox, footer);

  function cells(): HTMLButtonElement[] {
    return Array.from(grid.querySelectorAll<HTMLButtonElement>("button.gp-cell"));
  }

  function recentCells(): HTMLButtonElement[] {
    return Array.from(recentGrid.querySelectorAll<HTMLButtonElement>("button.gp-cell"));
  }

  let recentFocus = 0;
  /**
   * Set when a hold pinned a cell. The re-render swaps the cell under the
   * pointer, so the flag lives here and the release's click is skipped.
   */
  let heldPin = false;

  /** Fill the recent rows, then drop what does not fit in RECENT_ROWS rows. */
  function renderRecent(): void {
    const { glyphs, pinned } = recentRow();
    recentBox.hidden = glyphs.length === 0;
    recentGrid.replaceChildren();
    for (const ch of glyphs) {
      const b = glyphCell(ch);
      b.tabIndex = -1;
      if (pinned.has(ch)) {
        b.classList.add("pinned");
        b.title = `${codePointLabel(ch)} (pinned)`;
        b.setAttribute("aria-label", `${codePointLabel(ch)}, pinned`);
      }
      if (ch === opts.current) b.classList.add("current");
      if (pending === ch) b.classList.add("chosen");
      wireRecentCell(b, ch);
      recentGrid.append(b);
    }
    if (glyphs.length === 0) return;
    const fit = columns(recentGrid) * RECENT_ROWS;
    for (const b of recentCells().slice(fit)) b.remove();
    setRecentFocus(recentFocus, false);
  }

  function setRecentFocus(i: number, move: boolean): void {
    const list = recentCells();
    if (list.length === 0) return;
    recentFocus = Math.max(0, Math.min(list.length - 1, i));
    for (const [j, b] of list.entries()) b.tabIndex = j === recentFocus ? 0 : -1;
    if (move) list[recentFocus]?.focus();
  }

  /** Re-render after a pin change, keeping focus on the same glyph. */
  function pinAndRerender(ch: string, refocus: boolean): void {
    togglePin(ch);
    renderRecent();
    const i = recentCells().findIndex((b) => b.dataset.ch === ch);
    if (i >= 0) setRecentFocus(i, refocus);
    status.textContent = `${codePointLabel(ch)} ${ch} ${
      recentRow().pinned.has(ch) ? "pinned" : "unpinned"
    }`;
  }

  function wireRecentCell(b: HTMLButtonElement, ch: string): void {
    let timer: number | undefined;
    const stop = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      heldPin = false;
      stop();
      timer = window.setTimeout(() => {
        timer = undefined;
        heldPin = true;
        pinAndRerender(ch, false);
      }, LONG_PRESS_MS);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"] as const) {
      b.addEventListener(ev, stop);
    }
    // A touch hold would otherwise open the browser's context menu.
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      if (heldPin) {
        // The click that ends a hold is not a pick.
        heldPin = false;
        e.preventDefault();
        return;
      }
      const i = recentCells().indexOf(b);
      if (i >= 0) setRecentFocus(i, false);
      choose(ch, false);
    });
    b.addEventListener("focus", () => describe(ch));
  }

  function describe(ch: string): void {
    status.textContent = `${codePointLabel(ch)} ${ch}`;
  }

  function renderGroup(): void {
    const g = groups[groupIdx];
    select.value = String(groupIdx);
    grid.replaceChildren();
    if (g === undefined) return;
    for (const [i, ch] of g.glyphs.entries()) {
      const b = glyphCell(ch);
      b.tabIndex = i === focusIdx ? 0 : -1;
      if (ch === opts.current) b.classList.add("current");
      if (pending !== undefined && pending === ch) b.classList.add("chosen");
      b.addEventListener("click", () => {
        setFocus(i, false);
        choose(ch);
      });
      b.addEventListener("focus", () => {
        setFocus(i, false);
        describe(ch);
      });
      grid.append(b);
    }
  }

  function setFocus(i: number, move: boolean): void {
    const list = cells();
    if (list.length === 0) return;
    focusIdx = Math.max(0, Math.min(list.length - 1, i));
    for (const [j, b] of list.entries()) b.tabIndex = j === focusIdx ? 0 : -1;
    const target = list[focusIdx];
    if (target === undefined) return;
    if (move) target.focus();
    else target.scrollIntoView({ block: "nearest" });
  }

  function showGroup(i: number, cellIdx: number, move: boolean): void {
    groupIdx = (i + groups.length) % groups.length;
    focusIdx = cellIdx;
    renderGroup();
    setFocus(cellIdx, move);
  }

  function columns(el: HTMLElement = grid): number {
    return Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").length);
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    openPanel = null;
    window.removeEventListener("resize", onResize);
    if (dialog.open) dialog.close();
    opts.onClose();
  }

  /**
   * Preview a choice in the avatar; apply commits it. A clicked glyph joins
   * the recent rows right away; `refreshRecent` is false for a click in those
   * rows, so they don't reorder under the pointer.
   */
  function choose(ch: string | null, refreshRecent = true): void {
    if (ch !== null && ch !== BLANK) {
      pushRecent(ch);
      if (refreshRecent) renderRecent();
    }
    pending = ch;
    apply.disabled = false;
    opts.onPreview(ch ?? opts.variant);
    for (const b of [...cells(), ...recentCells()]) {
      b.classList.toggle("chosen", b.dataset.ch === ch);
    }
    apply.textContent = `apply ${ch === null ? `variant ${opts.variant}` : ch === BLANK ? "blank" : ch}`;
  }

  function commit(): void {
    if (pending === undefined) return;
    if (pending !== null) pushRecent(pending);
    opts.onPick(pending);
    finish();
  }

  function cancel(): void {
    opts.onPreview(null);
    finish();
  }

  /** Float the panel just above the anchor, or over the top of a short screen. */
  function place(): void {
    const scroller = opts.anchor.closest<HTMLElement>("#avatar-app");
    const vh = window.innerHeight;
    let rect = opts.anchor.getBoundingClientRect();
    if (scroller !== null) {
      // Bring the anchor into the lower part of the screen.
      const wantBottom = vh - GAP;
      if (rect.bottom > wantBottom || rect.top < vh * 0.45) {
        scroller.scrollTop += rect.bottom - wantBottom;
        rect = opts.anchor.getBoundingClientRect();
      }
    }
    const room = rect.top - 2 * GAP;
    dialog.style.top = "";
    dialog.style.bottom = "";
    if (room >= MIN_ROOM) {
      dialog.style.bottom = `${vh - rect.top + GAP}px`;
      dialog.style.maxHeight = `${room}px`;
    } else {
      dialog.style.top = `${GAP}px`;
      dialog.style.maxHeight = `${Math.round(vh * 0.55) - 2 * GAP}px`;
      if (scroller !== null) {
        scroller.scrollTop += rect.top - vh * 0.55;
      }
    }
  }

  select.addEventListener("change", () => showGroup(Number(select.value), 0, false));

  find.addEventListener("input", () => {
    const ch = parseFind(find.value);
    if (ch === null) {
      status.textContent = "";
      return;
    }
    const gi = groups.findIndex((g) => g.glyphs.includes(ch));
    if (gi < 0) {
      status.textContent = `${codePointLabel(ch)} not in font`;
      return;
    }
    showGroup(gi, groups[gi]!.glyphs.indexOf(ch), false);
    describe(ch);
  });
  find.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const ch = parseFind(find.value);
    if (ch !== null && isAllowedGlyph(ch) && ch !== BLANK) choose(ch);
  });

  grid.addEventListener("keydown", (e) => {
    const cols = columns();
    const n = cells().length;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = focusIdx - 1;
    else if (e.key === "ArrowRight") next = focusIdx + 1;
    else if (e.key === "ArrowUp") next = focusIdx - cols;
    else if (e.key === "ArrowDown") next = focusIdx + cols;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      showGroup(groupIdx + (e.key === "PageUp" ? -1 : 1), 0, true);
      return;
    } else return;
    e.preventDefault();
    if (next >= 0 && next < n) setFocus(next, true);
  });

  recentGrid.addEventListener("keydown", (e) => {
    // A key press is never the release of a hold.
    heldPin = false;
    const list = recentCells();
    const cur = list[recentFocus];
    if ((e.key === "p" || e.key === "P") && cur?.dataset.ch !== undefined) {
      e.preventDefault();
      pinAndRerender(cur.dataset.ch, true);
      return;
    }
    const cols = columns(recentGrid);
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = recentFocus - 1;
    else if (e.key === "ArrowRight") next = recentFocus + 1;
    else if (e.key === "ArrowUp") next = recentFocus - cols;
    else if (e.key === "ArrowDown") next = recentFocus + cols;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    if (next >= 0 && next < list.length) setRecentFocus(next, true);
  });

  /** Re-place the panel and refit the recent rows to the new width. */
  function onResize(): void {
    place();
    renderRecent();
  }

  dialog.oncancel = (e) => {
    e.preventDefault();
    cancel();
  };
  // A click on the transparent backdrop lands on the dialog element itself.
  dialog.onclick = (e) => {
    if (e.target === dialog) cancel();
  };

  openPanel = { close: cancel };
  const startGroup = groupIdx;
  dialog.showModal();
  place();
  window.addEventListener("resize", onResize);
  renderRecent();
  const startIdx = Math.max(0, groups[startGroup]?.glyphs.indexOf(opts.current) ?? 0);
  showGroup(startGroup, startIdx, true);
  describe(opts.current);
}
