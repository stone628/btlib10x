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
const RECENT_MAX = 16;
const RECENT = "Recent";
/** Below this much room above the map, the panel takes the top of the screen instead. */
const MIN_ROOM = 220;
const GAP = 8;

const BLOCK_GROUPS: Group[] = GLYPH_BLOCKS.map((b) => ({
  name: b.name,
  glyphs: b.ranges.flatMap(([lo, hi]) =>
    Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCodePoint(lo + i)),
  ),
}));

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && isAllowedGlyph(v));
  } catch {
    return [];
  }
}

function pushRecent(ch: string): void {
  if (ch === BLANK) return;
  const next = [ch, ...loadRecent().filter((c) => c !== ch)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage may be blocked: Recent just stays empty.
  }
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

  const groups: Group[] = [];
  const recent = loadRecent();
  if (recent.length > 0) groups.push({ name: RECENT, glyphs: recent });
  groups.push(...BLOCK_GROUPS);

  let groupIdx = Math.max(
    0,
    groups.findIndex((g) => g.name !== RECENT && g.glyphs.includes(opts.current)),
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
  title.textContent = opts.slot.title.toUpperCase();

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

  const footer = document.createElement("div");
  footer.className = "gp-footer";
  const status = document.createElement("span");
  status.className = "gp-status";
  status.setAttribute("aria-live", "polite");
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
  footer.append(status, buttons);

  dialog.append(title, controls, grid, footer);

  function cells(): HTMLButtonElement[] {
    return Array.from(grid.querySelectorAll<HTMLButtonElement>("button.gp-cell"));
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
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gp-cell";
      b.textContent = ch;
      b.title = codePointLabel(ch);
      b.setAttribute("aria-label", codePointLabel(ch));
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

  function columns(): number {
    return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    openPanel = null;
    window.removeEventListener("resize", place);
    if (dialog.open) dialog.close();
    opts.onClose();
  }

  /** Preview a choice in the avatar; apply commits it. */
  function choose(ch: string | null): void {
    pending = ch;
    apply.disabled = false;
    opts.onPreview(ch ?? opts.variant);
    for (const b of cells()) b.classList.toggle("chosen", b.textContent === ch);
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
    const gi = groups.findIndex((g) => g.name !== RECENT && g.glyphs.includes(ch));
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
  window.addEventListener("resize", place);
  const startIdx = Math.max(0, groups[startGroup]?.glyphs.indexOf(opts.current) ?? 0);
  showGroup(startGroup, startIdx, true);
}
