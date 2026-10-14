import { ARMS, HEADS, LEGS, type PartVariant, SHOULDERS, TORSOS } from "./avatar.data";
import { msg } from "./avatar.i18n";
import {
  applyOverrides,
  codePointLabel,
  formatOverrides,
  type Overrides,
  type Preview,
  parseOverrides,
  partOverrides,
  SLOTS,
  type SlotDef,
  type SlotId,
} from "./avatar.override";
import { isPickerOpen, openPicker } from "./avatar.picker";
import {
  BOX_H,
  BOX_W,
  boxLines,
  cellPos,
  SLOT_MAP_COLS,
  SLOT_MAP_ROWS,
  SLOT_PLACES,
  slotMapLines,
  withoutBoxes,
} from "./avatar.slotmap";
import { buildAvatarQuery, parseAvatarQuery, type UrlPart } from "./avatar.url";

interface PartDef {
  key: string;
  /** Export-line name (`HEAD=bv ...`); the UI shows `msg().part[key]`. */
  title: string;
  variants: PartVariant[];
}

const PARTS: PartDef[] = [
  { key: "head", title: "HEAD", variants: HEADS },
  { key: "shoulder", title: "SHOULDER", variants: SHOULDERS },
  { key: "torso", title: "TORSO", variants: TORSOS },
  { key: "arms", title: "ARMS", variants: ARMS },
  { key: "legs", title: "LEGS", variants: LEGS },
];

/** Default number of preview avatars shown on each side of the selected one. */
const SIDE_COUNT = 5;

/** Full-mech box with single borders (side previews). */
function composeAvatar(
  head: string,
  shoulder: string,
  torso: string,
  arm: string,
  leg: string,
): string[] {
  const sL = shoulder[0] ?? " ";
  const sR = shoulder[1] ?? " ";
  const h = `${head[0] ?? " "}${head[1] ?? " "}`;
  const aL = arm[0] ?? " ";
  const aR = arm[1] ?? " ";
  const t = `${torso[0] ?? " "}${torso[1] ?? " "}`;
  const lL = leg[0] ?? " ";
  const lR = leg[1] ?? " ";
  return ["┌────┐", `│${sL}${h}${sR}│`, `│${aL}${t}${aR}│`, `│ ${lL}${lR} │`, "└────┘"];
}

/** Full-mech box with double borders (selected center). */
export function composeSelectedAvatar(
  head: string,
  shoulder: string,
  torso: string,
  arm: string,
  leg: string,
): string[] {
  const sL = shoulder[0] ?? " ";
  const sR = shoulder[1] ?? " ";
  const h = `${head[0] ?? " "}${head[1] ?? " "}`;
  const aL = arm[0] ?? " ";
  const aR = arm[1] ?? " ";
  const t = `${torso[0] ?? " "}${torso[1] ?? " "}`;
  const lL = leg[0] ?? " ";
  const lR = leg[1] ?? " ";
  return ["╔════╗", `║${sL}${h}${sR}║`, `║${aL}${t}${aR}║`, `║ ${lL}${lR} ║`, "╚════╝"];
}

/**
 * How many side slots fit on each side of the selected box, given the
 * measured carousel row width, center (selected + step buttons) width, a
 * single side-slot width and the flex gap. Falls back to SIDE_COUNT when
 * the measurements are unusable (first paint, non-DOM contexts).
 */
function sideCountForWidth(
  rowWidth: number,
  midWidth: number,
  slotWidth: number,
  gap: number,
): number {
  const per = slotWidth + gap;
  if (!(slotWidth > 0) || !(rowWidth > 0)) return SIDE_COUNT;
  return Math.max(1, Math.floor((rowWidth - midWidth) / 2 / per));
}

/** Preview avatars shown on each side of the selected one; re-measured per viewport. */
let sideCount = SIDE_COUNT;

const STORAGE_KEY = "bt10x.avatar";

function wrapIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/**
 * Duplicate variant names inside one part's list. A clash makes captions,
 * the export line (`HEAD=sq ...`) and saved indices ambiguous. Names are
 * scoped per part, so reuse across parts (e.g. `sq` in HEAD and SHOULDER)
 * is fine and not reported.
 */
function findVariantNameClashes(): { part: string; name: string }[] {
  const clashes: { part: string; name: string }[] = [];
  for (const part of PARTS) {
    const seen = new Set<string>();
    for (const variant of part.variants) {
      if (seen.has(variant.name)) clashes.push({ part: part.title, name: variant.name });
      else seen.add(variant.name);
    }
  }
  return clashes;
}

interface AvatarState {
  idx: number[];
  active: number;
  /** Per-cell glyph overrides, see avatar.override.ts. */
  ovr: Overrides;
}

function loadState(): AvatarState {
  const idx = PARTS.map(() => 0);
  let active = 0;
  let ovr: Overrides = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { idx?: unknown; active?: unknown; ovr?: unknown };
      if (Array.isArray(parsed.idx)) {
        for (let p = 0; p < PARTS.length; p++) {
          const v = parsed.idx[p];
          const n = PARTS[p]?.variants.length ?? 1;
          if (typeof v === "number" && Number.isInteger(v)) idx[p] = wrapIndex(v, n);
        }
      }
      if (typeof parsed.active === "number" && Number.isInteger(parsed.active)) {
        active = wrapIndex(parsed.active, PARTS.length);
      }
      ovr = parseOverrides(parsed.ovr);
    }
  } catch {
    // Corrupt storage: fall back to defaults.
  }
  // URL params win over saved state, so a shared link shows its own avatar.
  const fromUrl = parseAvatarQuery(location.search, URL_PARTS);
  if (fromUrl !== null) {
    if (fromUrl.ignored.length > 0) {
      console.warn(`avatar: ignored URL params: ${fromUrl.ignored.join(", ")}`);
    }
    return { idx: fromUrl.idx, active, ovr: fromUrl.ovr };
  }
  return { idx, active, ovr };
}

/** Part keys and variant names as used in the URL (see avatar.url.ts). */
const URL_PARTS: UrlPart[] = PARTS.map((def) => ({
  key: def.key,
  names: def.variants.map((v) => v.name),
}));

/** Keep the address bar on the current avatar; replaceState adds no history entries. */
function syncUrl(state: AvatarState): void {
  const query = buildAvatarQuery(URL_PARTS, state.idx, state.ovr);
  // Keep ?lang= so a reload stays in that language when storage is blocked.
  const lang = new URLSearchParams(location.search).get("lang");
  const langParam = lang === null ? "" : `&lang=${encodeURIComponent(lang)}`;
  try {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}?${query}${langParam}${location.hash}`,
    );
  } catch {
    // Some embedded or file: contexts refuse replaceState; the URL just stays put.
  }
}

function saveState(state: AvatarState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ idx: state.idx, active: state.active, ovr: state.ovr }),
    );
  } catch {
    // Storage may be blocked: the customizer still works in memory.
  }
  syncUrl(state);
}

const state: AvatarState = loadState();
saveState(state);

/** Glyph shown in a slot while the picker is open; never saved. */
let preview: Preview | null = null;
/** Slot whose picker is open. */
let editing: SlotId | null = null;
/** Set while focus returns to a slot box after the picker closes. */
let restoringFocus = false;

const stage = document.getElementById("stage") as HTMLDivElement;
const slotMapEl = document.getElementById("slotmap") as HTMLDivElement;
const pickerEl = document.getElementById("glyph-picker") as HTMLDialogElement;
const partsEl = document.getElementById("parts") as HTMLDivElement;
const live = document.getElementById("sr-live") as HTMLDivElement;

/** Variant data of each part, in PARTS order (head, shoulder, torso, arms, legs). */
function currentData(): string[] {
  return PARTS.map((def, p) => def.variants[state.idx[p] ?? 0]?.data ?? "  ");
}

/** Part data as drawn: overrides applied, plus the picker's preview when `withPreview`. */
function shownData(withPreview = true): string[] {
  return applyOverrides(currentData(), state.ovr, withPreview ? preview : null);
}

function composeFrom(data: readonly string[], selected: boolean): string[] {
  const [head, shoulder, torso, arm, leg] = data.map((d) => d ?? "  ");
  return (selected ? composeSelectedAvatar : composeAvatar)(
    head ?? "  ",
    shoulder ?? "  ",
    torso ?? "  ",
    arm ?? "  ",
    leg ?? "  ",
  );
}

/**
 * Side preview: `part` swapped to `variant`, every other part as drawn. The
 * browsed part shows its plain preset, without its overrides, so the row
 * compares presets; picking one still keeps the overrides on top.
 */
function avatarWithOverride(part: number, variant: number): string[] {
  const order = applyOverrides(currentData(), state.ovr, preview, part);
  const def = PARTS[part];
  if (def !== undefined)
    order[part] =
      def.variants[wrapIndex(variant, def.variants.length)]?.data ?? order[part] ?? "  ";
  return composeFrom(order, false);
}

/** Pick variant `vi` for part `p`; overrides on that part are kept. */
function setVariant(p: number, vi: number): void {
  const def = PARTS[p];
  if (def === undefined) return;
  state.idx[p] = wrapIndex(vi, def.variants.length);
}

function announce(): void {
  const def = PARTS[state.active];
  if (def === undefined) return;
  const v = def.variants[state.idx[state.active] ?? 0];
  if (v === undefined) return;
  const ovr = partOverrides(state.ovr, state.active)
    .map(([s, ch]) => msg().slotSet(msg().slot[s.id], codePointLabel(ch)))
    .join("");
  live.textContent = `${msg().part[def.key]}: ${v.name}, ${v.desc}${ovr}`;
}

/** Flex gap in `.carousel` (see avatar.css); kept in sync by hand. */
const CAROUSEL_GAP = 8;

/** Re-derive the side count from the rendered first row, or keep the current one. */
function measureSideCount(): number {
  const row = stage.querySelector(".carousel");
  const slot = stage.querySelector(".avatar.side");
  const mid = stage.querySelector(".mid");
  if (
    !(row instanceof HTMLElement) ||
    !(slot instanceof HTMLElement) ||
    !(mid instanceof HTMLElement)
  ) {
    return sideCount;
  }
  return sideCountForWidth(row.clientWidth, mid.offsetWidth, slot.offsetWidth, CAROUSEL_GAP);
}

/** Re-render only when the viewport fits a different number of side slots. */
function syncWidth(): void {
  const next = measureSideCount();
  if (next !== sideCount) {
    sideCount = next;
    render();
  }
}

function render(): void {
  const m = msg();
  stage.replaceChildren();
  const selected = composeFrom(shownData(), true);

  PARTS.forEach((def, p) => {
    const n = def.variants.length;
    const sel = wrapIndex(state.idx[p] ?? 0, n);
    const variant = def.variants[sel];
    if (variant === undefined) return;
    const partName = m.part[def.key] ?? def.title;

    const section = document.createElement("section");
    section.className = "part";
    if (p === state.active) section.classList.add("active");

    const label = document.createElement("div");
    label.className = "part-label";
    const ovr = partOverrides(state.ovr, p)
      .map(([s, ch]) => ` · ${s.id}=${ch}`)
      .join("");
    label.textContent = `[${partName}: ${variant.name} — ${variant.desc}${ovr}]`;
    section.append(label);

    const row = document.createElement("div");
    row.className = "carousel";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", m.variants(partName));

    for (let off = -sideCount; off <= sideCount; off++) {
      if (off === 0) {
        const mid = document.createElement("div");
        mid.className = "mid";

        const prev = document.createElement("button");
        prev.type = "button";
        prev.className = "step";
        prev.textContent = "<";
        prev.setAttribute("aria-label", m.previous(partName));
        prev.addEventListener("click", () => {
          setVariant(p, sel - 1);
          state.active = p;
          saveState(state);
          render();
          announce();
        });

        const box = document.createElement("button");
        box.type = "button";
        box.className = "avatar selected";
        const art = document.createElement("span");
        art.className = "art";
        // This row's part as its plain preset; other parts as drawn.
        art.textContent = composeFrom(
          applyOverrides(currentData(), state.ovr, preview, p),
          true,
        ).join("\n");
        const cap = document.createElement("span");
        cap.className = "cap";
        cap.setAttribute("aria-hidden", "true");
        cap.textContent =
          partOverrides(state.ovr, p).length > 0 ? `${variant.name}*` : variant.name;
        box.append(art, cap);
        box.setAttribute("aria-label", m.selected(partName, variant.name));
        box.addEventListener("click", () => {
          state.active = p;
          saveState(state);
          render();
          announce();
        });

        const next = document.createElement("button");
        next.type = "button";
        next.className = "step";
        next.textContent = ">";
        next.setAttribute("aria-label", m.next(partName));
        next.addEventListener("click", () => {
          setVariant(p, sel + 1);
          state.active = p;
          saveState(state);
          render();
          announce();
        });

        mid.append(prev, box, next);
        row.append(mid);
      } else {
        const vi = wrapIndex(sel + off, n);
        const lines = avatarWithOverride(p, vi);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "avatar side";
        const third = sideCount / 3;
        if (Math.abs(off) > third * 2) b.classList.add("far");
        else if (Math.abs(off) > third) b.classList.add("near");
        const target = def.variants[vi];
        const art = document.createElement("span");
        art.className = "art";
        art.textContent = lines.join("\n");
        const cap = document.createElement("span");
        cap.className = "cap";
        cap.setAttribute("aria-hidden", "true");
        cap.textContent = target?.name ?? "";
        b.append(art, cap);
        b.setAttribute("aria-label", `${partName} ${target?.name ?? ""}`);
        b.title = target !== undefined ? `${target.name} — ${target.desc}` : "";
        b.addEventListener("click", () => {
          setVariant(p, vi);
          state.active = p;
          saveState(state);
          render();
          announce();
        });
        row.append(b);
      }
    }

    section.append(row);
    stage.append(section);
  });

  const names = PARTS.map(
    (def, p) => `${def.title}=${def.variants[state.idx[p] ?? 0]?.name ?? "??"}`,
  ).join(" ");
  const ovrText = formatOverrides(state.ovr);
  partsEl.textContent = ovrText === "" ? names : `${names} ${ovrText}`;
  renderSlotMap(selected);
}

/** The copied avatar: saved state only, never the picker's preview. */
function exportText(): string {
  return composeFrom(shownData(false), true).join("\n");
}

/** Glyph each slot shows right now. */
function slotGlyphs(data: readonly string[]): Record<SlotId, string> {
  const out = {} as Record<SlotId, string>;
  for (const s of SLOTS) out[s.id] = data[s.part]?.[s.side] ?? " ";
  return out;
}

function gridArea(el: HTMLElement, col: number, line: number, w: number, h: number): void {
  el.style.gridColumn = `${col + 1} / span ${w}`;
  el.style.gridRow = `${line + 1} / span ${h}`;
}

/** Focus survives re-renders by slot id. */
function focusedSlot(): SlotId | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && slotMapEl.contains(el)
    ? ((el.dataset.slot as SlotId | undefined) ?? null)
    : null;
}

function renderSlotMap(avatar: string[]): void {
  const m = msg();
  const keepFocus = focusedSlot();
  const data = shownData();
  const lines = slotMapLines(avatar, slotGlyphs(data));
  slotMapEl.replaceChildren();
  slotMapEl.style.setProperty("--map-cols", String(SLOT_MAP_COLS));
  slotMapEl.style.setProperty("--map-rows", String(SLOT_MAP_ROWS));

  for (const [i, text] of withoutBoxes(lines).entries()) {
    const row = document.createElement("span");
    row.className = "map-line";
    row.setAttribute("aria-hidden", "true");
    row.textContent = text;
    gridArea(row, 0, i, SLOT_MAP_COLS, 1);
    slotMapEl.append(row);
  }

  for (const slot of SLOTS) {
    const place = SLOT_PLACES[slot.id];
    const ch = data[slot.part]?.[slot.side] ?? " ";
    const overridden = state.ovr[slot.id] !== undefined;

    const cell = document.createElement("span");
    cell.className = "map-cell";
    cell.dataset.cell = slot.id;
    cell.setAttribute("aria-hidden", "true");
    cell.textContent = ch;
    const pos = cellPos(slot.id);
    gridArea(cell, pos.col, pos.line, 1, 1);

    const box = document.createElement("button");
    box.type = "button";
    box.className = "map-box";
    box.dataset.slot = slot.id;
    if (overridden) box.classList.add("overridden");
    if (editing === slot.id) box.classList.add("editing");
    box.textContent = boxLines(lines, slot.id).join("\n");
    box.setAttribute(
      "aria-label",
      `${m.slot[slot.id]}: ${ch === " " ? m.blank : ch}, ${overridden ? m.override : m.fromVariant}`,
    );
    gridArea(box, place.box.col, place.box.line, BOX_W, BOX_H);
    const lit = (on: boolean) => cell.classList.toggle("lit", on || editing === slot.id);
    // Keyboard focus lights the cell. Focus handed back when the picker
    // closes does not, or the cell would stay lit after the pick.
    const keyFocused = () => box.matches(":focus-visible") && !restoringFocus;
    box.addEventListener("pointerenter", () => lit(true));
    box.addEventListener("pointerleave", () => lit(keyFocused()));
    box.addEventListener("focus", () => lit(keyFocused()));
    box.addEventListener("blur", () => lit(false));
    box.addEventListener("click", () => openSlot(slot));
    if (editing === slot.id) cell.classList.add("lit");

    // Dim frame around the box's glyph, like the picker's cells.
    const frame = document.createElement("span");
    frame.className = "map-glyph";
    if (editing === slot.id) frame.classList.add("editing");
    frame.setAttribute("aria-hidden", "true");
    gridArea(frame, place.box.col + 2, place.box.line + 1, 1, 1);

    slotMapEl.append(cell, box, frame);
  }

  if (keepFocus !== null) {
    slotMapEl.querySelector<HTMLElement>(`[data-slot="${keepFocus}"]`)?.focus();
  }
}

function openSlot(slot: SlotDef): void {
  editing = slot.id;
  const current = shownData(false)[slot.part]?.[slot.side] ?? " ";
  render();
  openPicker(pickerEl, {
    slot,
    current,
    variant: currentData()[slot.part]?.[slot.side] ?? " ",
    anchor: slotMapEl,
    onPreview: (ch) => {
      preview = ch === null ? null : { slot: slot.id, ch };
      render();
    },
    onPick: (ch) => {
      preview = null;
      if (ch === null) delete state.ovr[slot.id];
      else state.ovr[slot.id] = ch;
      state.active = slot.part;
      saveState(state);
      render();
      announce();
    },
    onClose: () => {
      editing = null;
      preview = null;
      render();
      // render() rebuilt the boxes: focus the new one for this slot.
      restoringFocus = true;
      slotMapEl.querySelector<HTMLElement>(`[data-slot="${slot.id}"]`)?.focus();
      restoringFocus = false;
    },
  });
}

function stepActive(delta: number): void {
  const def = PARTS[state.active];
  if (def === undefined) return;
  setVariant(state.active, (state.idx[state.active] ?? 0) + delta);
  saveState(state);
  render();
  announce();
}

function moveActive(delta: number): void {
  state.active = wrapIndex(state.active + delta, PARTS.length);
  saveState(state);
  render();
  announce();
}

document.addEventListener("keydown", (e) => {
  // The picker handles its own keys; arrows there must not step variants.
  if (isPickerOpen()) return;
  // Arrows in the snippet panel move the caret, not the carousels.
  if (document.querySelector("#snippet-panel[open]") !== null) return;
  // Arrow keys on a slot box still drive the carousels.
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepActive(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    stepActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveActive(1);
  }
});

document.getElementById("copy")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`${exportText()}\n${partsEl.textContent ?? ""}`);
    live.textContent = msg().copied;
  } catch {
    live.textContent = msg().copyFailed;
  }
});

/** Link to this avatar; a shared link opens in the recipient's own language. */
function shareUrl(): string {
  const url = new URL(location.href);
  url.searchParams.delete("lang");
  return url.href;
}

document.getElementById("copy-link")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrl());
    live.textContent = msg().linkCopied;
  } catch {
    live.textContent = msg().copyFailed;
  }
});

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Absolute URL of the page's regular-weight font, from the preload link in avatar.html. */
function fontUrl(): string | null {
  return document.querySelector<HTMLLinkElement>('link[rel="preload"][as="font"]')?.href ?? null;
}

/**
 * Embeddable HTML: the copied avatar in a monospace block linking back here.
 * The font loads from this site (`/fonts/*` sends CORS headers, see
 * scripts/dist-web.mjs) so box drawing lines up on any page.
 */
function snippetHtml(): string {
  const href = escapeHtml(shareUrl()).replaceAll('"', "&quot;");
  const label = escapeHtml(msg().snippetLabel).replaceAll('"', "&quot;");
  const font = fontUrl();
  const fontCss =
    font === null
      ? []
      : [
          `<style>@font-face{font-family:"Bt10x Mono";src:url("${escapeHtml(font)}") format("woff2");font-weight:400;font-style:normal;font-display:block}</style>`,
        ];
  return [
    ...fontCss,
    `<a href="${href}" style="color:inherit;text-decoration:none">` +
      `<pre style="display:inline-block;margin:0;font-family:'Bt10x Mono','SF Mono',Menlo,Consolas,monospace;font-size:inherit;line-height:1.175;font-variant-ligatures:none" aria-label="${label}">${escapeHtml(exportText())}</pre>` +
      "</a>",
  ].join("\n");
}

const snippetPanel = document.getElementById("snippet-panel") as HTMLDialogElement;
const snippetCode = document.getElementById("snippet-code") as HTMLTextAreaElement;

document.getElementById("show-snippet")?.addEventListener("click", () => {
  snippetCode.value = snippetHtml();
  snippetPanel.showModal();
  snippetCode.focus();
  snippetCode.select();
});

document.getElementById("snippet-copy")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(snippetCode.value);
    live.textContent = msg().snippetCopied;
  } catch {
    live.textContent = msg().copyFailed;
  }
});

document.getElementById("snippet-close")?.addEventListener("click", () => snippetPanel.close());

// A backdrop click lands on the dialog itself, as does one on its padding,
// so close only when both press and release fall outside the panel box.
const outsideSnippet = (e: MouseEvent): boolean => {
  if (e.target !== snippetPanel) return false;
  const r = snippetPanel.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
let snippetPressedOutside = false;
snippetPanel.addEventListener("pointerdown", (e) => {
  snippetPressedOutside = outsideSnippet(e);
});
snippetPanel.addEventListener("click", (e) => {
  if (snippetPressedOutside && outsideSnippet(e)) snippetPanel.close();
  snippetPressedOutside = false;
});

document.getElementById("blank")?.addEventListener("click", () => {
  PARTS.forEach((def, p) => {
    state.idx[p] = Math.max(
      0,
      def.variants.findIndex((v) => v.name === "no"),
    );
  });
  state.ovr = {};
  saveState(state);
  render();
  announce();
});

document.getElementById("random")?.addEventListener("click", () => {
  PARTS.forEach((def, p) => {
    // Skip the "no" variant so every part shows up.
    const picks = def.variants.flatMap((v, i) => (v.name === "no" ? [] : [i]));
    state.idx[p] = picks[Math.floor(Math.random() * picks.length)] ?? 0;
  });
  state.ovr = {};
  saveState(state);
  render();
  announce();
});

const clashes = findVariantNameClashes();
if (clashes.length > 0) {
  const detail = clashes.map((c) => `${c.part}="${c.name}"`).join(", ");
  stage.textContent = `avatar data error: duplicate variant names: ${detail}`;
  throw new Error(`avatar: duplicate variant names: ${detail}`);
}

document.title = msg().title;
render();
syncWidth();

// The language buttons in avatar.html only set `<html lang>`; redraw the
// script-built text when it changes.
new MutationObserver(() => {
  document.title = msg().title;
  render();
  announce();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

// Mono metrics settle after fonts load, which shifts the slot measurement.
void document.fonts.ready.then(() => {
  syncWidth();
});

let resizeQueued = false;
window.addEventListener("resize", () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    syncWidth();
  });
});
