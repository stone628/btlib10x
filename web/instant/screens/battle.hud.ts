/**
 * Battle screen frame: the border with the battle
 * title, the Turn / Phase / Action Order strip, the SHEET drawers on both
 * edges, the LOGS drawer and the DONE button. Everything is placed on the
 * 100×32 cell grid over the full-body map.
 */
import { actorQueue, isUnitOnBoard, type UnitState, unitPolicyOf } from "btlib10x";
import { t } from "../i18n";
import { app, type BattleFocus, kitModal, type Modal, rerender } from "../state";
import { UI_THEME } from "../theme";
import type { TuiChild, TuiNode } from "../tui";
import { recordSheet, SHEET_W } from "./battle.sheet";
import { at, cells, fit, h, hintAttrs, kit, logView, row, span } from "./common";

const { FRAME: F, GRID: G, ROUND: R, MARK: M, ARROW: A } = UI_THEME;

/** Map area: inside the border, between the header strip and the bottom border. */
export const BODY = { col: 1, row: 4, cols: 98, rows: 26 } as const;
const QUEUE_W = 78;
const TAB_ROW = 13;
/** Top row of an open drawer, and the right drawer's first column. */
const DRAWER_ROW = 6;
const DRAWER_RIGHT = 99 - SHEET_W;

// ------------------------------------------------------------ action order

interface QueueEntry {
  unit: UnitState;
  state: "acted" | "current" | "pending" | "idle" | "out";
}

/** Whole phase queue: acted (grayed), current, still to act, then removed units. */
export function queueEntries(): QueueEntry[] {
  const b = app.battle!;
  const q = actorQueue(b.state);
  const out: QueueEntry[] = [];
  const seen = new Set<string>();
  const push = (id: string, state: QueueEntry["state"]) => {
    const unit = b.state.units[id];
    if (!unit || seen.has(id)) return;
    seen.add(id);
    out.push({ unit, state });
  };
  for (const a of q.acted) push(a.id, "acted");
  for (const p of q.pending) push(p.id, p.id === b.actorId ? "current" : "pending");
  // Units that sit this phase out (unconscious, shut down in the attack phase)
  for (const u of Object.values(b.state.units))
    if (!q.removed.some((r) => r.id === u.id)) push(u.id, "idle");
  for (const r of q.removed) push(r.id, "out");
  return out;
}

function entryText(e: QueueEntry): string {
  const body = `${e.unit.id}(S${e.unit.team}${M.on}${e.unit.model})`;
  if (e.state === "current") return `${A.current[0]}${body}${A.current[1]}`;
  if (e.state === "out") return `${M.out}${body}`;
  return body;
}

const SEP = ` ${A.to} `;

/** The whole queue on one line; the kit scrollbox scrolls it sideways. */
function queueLine(): TuiNode {
  const kids: TuiChild[] = [];
  queueEntries().forEach((e, i) => {
    if (i > 0) kids.push(span(SEP, { cls: "ia-dim", key: `s${i}` }));
    kids.push(
      span(entryText(e), {
        cls: `ia-q-${e.state} ia-team${e.unit.team}`,
        key: `q${e.unit.id}`,
        onClick: () => {
          openSheetFor(e.unit.id);
          if (isUnitOnBoard(e.unit)) app.mapView?.centerOn(e.unit.position);
        },
      }),
    );
  });
  return h().line({ key: "qline" }, ...kids);
}

/**
 * After a render: centre the current actor in the Action Order whenever the
 * order changes (as far as the scroll range allows), and let the plain wheel
 * scroll it sideways.
 */
export function queueAfterRender(): void {
  const box = document.querySelector<HTMLElement>("#app .ia-queue");
  const body = box?.querySelector<HTMLElement>(".tui-body");
  if (!box || !body) return;
  box.onwheel = (e) => {
    if (body.scrollWidth <= body.clientWidth) return;
    e.preventDefault();
    body.scrollLeft += e.deltaX + e.deltaY;
  };
  const ui = app.battleUi;
  const order = queueEntries()
    .map((e) => `${e.unit.id}:${e.state}`)
    .join(" ");
  if (ui.queueFor === order) return;
  ui.queueFor = order;
  const cur = body.querySelector<HTMLElement>(".ia-q-current");
  if (!cur) return;
  const left = cur.offsetLeft - body.offsetLeft;
  const max = body.scrollWidth - body.clientWidth;
  body.scrollLeft = Math.max(0, Math.min(max, left + (cur.offsetWidth - body.clientWidth) / 2));
}

// ------------------------------------------------------------ sheet drawers

/** Queue order starting at the current actor: the default units for drawers. */
function defaultOrder(): string[] {
  const e = queueEntries();
  const cur = Math.max(
    0,
    e.findIndex((x) => x.state === "current"),
  );
  return [...e.slice(cur), ...e.slice(0, cur)].map((x) => x.unit.id);
}

/**
 * The player's team: the acting unit's when a player controls it, else the
 * first team a player controls any unit of, else team 1 (AI against AI).
 */
export function myTeam(): number {
  const b = app.battle!;
  const actor = b.actorId === null ? null : b.state.units[b.actorId];
  if (actor && b.actorPersona === null) return actor.team;
  const mine = Object.values(b.state.units).find((u) => (b.control[u.id] ?? null) === null);
  return mine?.team ?? 1;
}

/** Base rule for which drawer shows a unit: the left for the player's team,
 *  the right for the opponent's. */
export function sheetSideOf(unitId: string): 0 | 1 {
  const u = app.battle!.state.units[unitId];
  return u && u.team === myTeam() ? 0 : 1;
}

export function toggleSheet(side: 0 | 1): void {
  const ui = app.battleUi;
  setLogs(false);
  const d = ui.sheets[side];
  if (d.open) {
    d.open = false;
    if (ui.focus === side) ui.focus = "orders";
    kit().hideTip();
  } else {
    const other = ui.sheets[side === 0 ? 1 : 0];
    if (d.unitId === null) {
      const shown = other.open ? other.unitId : null;
      const order = defaultOrder().filter((id) => id !== shown);
      d.unitId = order.find((id) => sheetSideOf(id) === side) ?? order[0] ?? null;
    }
    d.open = d.unitId !== null;
    d.openedAt = ++ui.seq;
  }
  rerender();
}

/** Show a unit's sheet in its side's drawer (sheetSideOf), unless a drawer
 *  already shows it. */
export function openSheetFor(unitId: string): void {
  const ui = app.battleUi;
  setLogs(false);
  const [l, r] = ui.sheets;
  if ((l.open && l.unitId === unitId) || (r.open && r.unitId === unitId)) return;
  const d = ui.sheets[sheetSideOf(unitId)];
  d.open = true;
  d.unitId = unitId;
  d.openedAt = ++ui.seq;
  rerender();
}

/** The sheet header's unit picker, under the header (a click, or Enter on it). */
function pickUnit(side: 0 | 1, el: HTMLElement | null): void {
  const b = app.battle!;
  const ids = queueEntries().map((x) => x.unit.id);
  if (!el) return;
  const d = app.battleUi.sheets[side];
  kitModal.open = true;
  void kit()
    .popupMenu(
      el,
      ids.map((id) => {
        const u = b.state.units[id]!;
        return { label: `${id === d.unitId ? M.on : " "} ${fit(id, 3)} S${u.team} ${u.model}` };
      }),
      { cols: SHEET_W, active: Math.max(0, ids.indexOf(d.unitId ?? "")) },
    )
    .then((res) => {
      kitModal.open = false;
      if (res && "index" in res) d.unitId = ids[res.index] ?? d.unitId;
      rerender();
    });
}

/**
 * The acting player unit's policy dialog; OK applies the changes to the
 * battle. Opened from the battle menu, OK and Cancel go `back` to it.
 */
export function openPolicy(id: string, back?: Modal): void {
  const b = app.battle!;
  const u = b.state.units[id];
  if (!u) return;
  app.modal = {
    kind: "policy",
    id,
    draft: unitPolicyOf(u),
    apply: (p) => {
      try {
        b.setPolicy(p);
        app.error = null;
      } catch (e) {
        app.error = e instanceof Error ? e.message : String(e);
      }
    },
    ...(back ? { back } : {}),
  };
  rerender();
}

/** Vertical tab text: arrow, the label letter by letter, arrow. */
function tabLetters(arrow: string): string[] {
  return [arrow, ...[...t("battle.sheetTab")].slice(0, 5), arrow];
}

/** Closed tab on the frame edge (left: cols 0-2, right: cols 97-99). */
function edgeTab(side: 0 | 1): TuiNode {
  const H = h();
  const left = side === 0;
  const letters = tabLetters(left ? A.tabR : A.tabL);
  const rows = [
    left ? `${F.vEndUp}${G.th}${R.ne}` : `${R.nw}${G.th}${F.vEndUpL}`,
    ...letters.map((c) => (left ? ` ${c}${G.tv}` : `${G.tv}${c} `)),
    left ? `${F.vEndDown}${G.th}${R.se}` : `${R.sw}${G.th}${F.vEndDownL}`,
  ];
  return at(
    left ? 0 : 97,
    TAB_ROW,
    {
      class: "ia-tab-edge ia-inset",
      key: `tab${side}`,
      attrs: { "data-click": "", "data-side": String(side), ...hintAttrs("tab") },
      onClick: () => toggleSheet(side),
    },
    ...rows.map((r, i) => H.el("div", { class: "ia-row", key: i }, r)),
  );
}

/**
 * Open drawer (rows 6-28): the record sheet against the frame edge (its box
 * takes the edge over) and a double line with the tab hung on it; the line
 * opens where the tab is.
 */
function drawer(side: 0 | 1): TuiNode | null {
  const H = h();
  const b = app.battle!;
  const d = app.battleUi.sheets[side];
  const u = d.unitId ? b.state.units[d.unitId] : undefined;
  if (!d.open || !u) return null;
  const left = side === 0;
  const x0 = left ? 0 : DRAWER_RIGHT;
  const edge = G.th.repeat(SHEET_W - 1);
  const rows: TuiNode[] = [];
  rows.push(
    row(left ? `${F.vEndUp}${edge}${F.vEndDownL}` : `${F.vEndDown}${edge}${F.vEndUpL}`, {
      key: "t",
    }),
  );
  recordSheet(
    u,
    side,
    (e) => pickUnit(side, e.currentTarget instanceof HTMLElement ? e.currentTarget : null),
    u.id === b.actorId && b.actorPersona === null ? () => openPolicy(u.id) : null,
  ).forEach((body, i) => {
    const r = DRAWER_ROW + 1 + i;
    const bar = span(r >= TAB_ROW && r <= TAB_ROW + 8 ? " " : F.v, { key: "bar" });
    rows.push(
      H.el("div", { class: "ia-drawer-line", key: `r${i}` }, left ? body : bar, left ? bar : body),
    );
  });
  rows.push(
    row(left ? `${F.vEndDown}${edge}${F.vEndUpL}` : `${F.vEndUp}${edge}${F.vEndDownL}`, {
      key: "b",
    }),
  );
  const letters = tabLetters(left ? A.tabL : A.tabR);
  const tab = [
    left ? `${F.vEndUp}${G.th}${R.ne}` : `${R.nw}${G.th}${F.vEndUpL}`,
    ...letters.map((c) => (left ? ` ${c}${G.tv}` : `${G.tv}${c} `)),
    left ? `${F.vEndDown}${G.th}${R.se}` : `${R.sw}${G.th}${F.vEndDownL}`,
  ];
  return H.el(
    "div",
    { key: `drawer${side}` },
    at(
      x0,
      DRAWER_ROW,
      { class: "ia-drawer ia-inset", key: "panel", attrs: { "data-side": String(side) } },
      ...rows,
    ),
    at(
      left ? SHEET_W : DRAWER_RIGHT - 2,
      TAB_ROW,
      {
        class: "ia-tab-edge ia-inset",
        key: "tab",
        attrs: { "data-click": "" },
        onClick: () => toggleSheet(side),
      },
      ...tab.map((r, i) => H.el("div", { class: "ia-row", key: i }, r)),
    ),
  );
}

// ------------------------------------------------------------ key focus

/** Tab / X stops: the left sheet (or its tab), the orders, the right sheet (or its tab). */
function focusStops(): BattleFocus[] {
  return app.battleUi.logs ? ["orders"] : [0, "orders", 1];
}

/** Tab / Shift+Tab (X): the next or previous focus stop, wrapping round. */
export function cycleFocus(dir: number): void {
  const ui = app.battleUi;
  const stops = focusStops();
  const i = Math.max(0, stops.indexOf(ui.focus));
  ui.focus = stops[(i + dir + stops.length) % stops.length]!;
  ui.hint = null;
  app.mapView?.hideReticle();
}

/** The focused sheet's element: its open drawer, else its closed tab; null for the orders. */
function focusScope(): HTMLElement | null {
  const f = app.battleUi.focus;
  if (f === "orders") return null;
  return (
    document.querySelector<HTMLElement>(`#app .ia-drawer[data-side="${f}"]`) ??
    document.querySelector<HTMLElement>(`#app .ia-tab-edge[data-side="${f}"]`)
  );
}

function hintTargets(scope: HTMLElement): HTMLElement[] {
  if (scope.dataset.hint) return [scope];
  return Array.from(scope.querySelectorAll<HTMLElement>("[data-hint]"));
}

/**
 * After a render: give the DOM focus to the focused sheet's hint target (its
 * tooltip opens on focus), or take it off a sheet when the orders have it.
 */
export function focusAfterRender(): void {
  const ui = app.battleUi;
  if (app.modal || kitModal.open) return;
  const scope = focusScope();
  const active = document.activeElement;
  if (!scope) {
    if (active instanceof HTMLElement && active.closest("#app [data-hint]")) active.blur();
    return;
  }
  const all = hintTargets(scope);
  const el = all.find((x) => x.dataset.hint === ui.hint) ?? all[0];
  if (!el) return;
  ui.hint = el.dataset.hint ?? null;
  if (active !== el) el.focus({ preventScroll: true });
}

const DIRS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The hint target an arrow moves to from `from`: ↑ ↓ the row above or below,
 * nearest across; ← → the next one along the row, past its end the next
 * row's first (the previous row's last), so ← → read the whole sheet.
 */
function nextHint(all: HTMLElement[], from: HTMLElement, dir: readonly [number, number]) {
  const box = (el: HTMLElement) => el.getBoundingClientRect();
  const rows: HTMLElement[][] = [];
  for (const el of [...all].sort((a, b) => box(a).top - box(b).top || box(a).left - box(b).left)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(box(last[0]!).top - box(el).top) < 2) last.push(el);
    else rows.push([el]);
  }
  for (const r of rows) r.sort((a, b) => box(a).left - box(b).left);
  const ri = rows.findIndex((r) => r.includes(from));
  if (ri < 0) return null;
  const mid = (el: HTMLElement) => box(el).left + box(el).width / 2;
  if (dir[1] !== 0) {
    const r = rows[ri + dir[1]];
    if (!r) return null;
    const x = mid(from);
    return r.reduce((a, b) => (Math.abs(mid(b) - x) < Math.abs(mid(a) - x) ? b : a));
  }
  const r = rows[ri]!;
  const next = r[r.indexOf(from) + dir[0]];
  if (next) return next;
  const other = rows[ri + dir[0]];
  return other ? other[dir[0] > 0 ? 0 : other.length - 1]! : null;
}

/**
 * Keys while a sheet has the focus: arrows walk its hint targets, Enter /
 * Space run the header (unit picker), the policy button or a closed tab,
 * Backspace hands the focus back to the orders. Other keys fall through.
 */
export function sheetKey(e: KeyboardEvent): boolean {
  const ui = app.battleUi;
  const side = ui.focus;
  if (side === "orders") return false;
  if (e.key === "Backspace") {
    ui.focus = "orders";
    return true;
  }
  const scope = focusScope();
  if (!scope) return false;
  const all = hintTargets(scope);
  const cur = all.find((x) => x.dataset.hint === ui.hint) ?? all[0];
  const dir = DIRS[e.key];
  if (dir) {
    const next = cur ? nextHint(all, cur, dir) : null;
    if (next) ui.hint = next.dataset.hint ?? null;
    return true;
  }
  if (e.key !== "Enter" && e.key !== " ") return false;
  if (e.repeat) return true;
  const b = app.battle!;
  const hint = cur?.dataset.hint;
  if (hint === "tab") {
    toggleSheet(side);
    ui.focus = side;
    ui.hint = null;
  } else if (hint === "head") pickUnit(side, cur ?? null);
  else if (hint === "policy") {
    const id = ui.sheets[side].unitId;
    if (id && id === b.actorId && b.actorPersona === null) openPolicy(id);
  }
  return true;
}

// ------------------------------------------------------------ logs

/** Open or close the LOGS drawer: open sheets close with it and come back after. */
export function setLogs(open: boolean): void {
  const ui = app.battleUi;
  if (open === ui.logs) return;
  ui.logs = open;
  ui.focus = "orders";
  // a sheet tip (its target is about to go) must not stay over the log
  kit().hideTip();
  if (open) {
    ui.logSheets = [ui.sheets[0].open, ui.sheets[1].open];
    for (const d of ui.sheets) d.open = false;
  } else if (ui.logSheets) {
    ui.sheets[0].open = ui.logSheets[0];
    ui.sheets[1].open = ui.logSheets[1];
    ui.logSheets = null;
  }
}

export function toggleLogs(): void {
  setLogs(!app.battleUi.logs);
  rerender();
}

/**
 * A new unit to move: its sheet goes in the left drawer (or into the state
 * the LOGS drawer restores) and, after the render, the map fits it and the
 * enemy units into the clear area.
 */
export function focusMover(): void {
  const ui = app.battleUi;
  const b = app.battle!;
  const key = `${b.state.turn}:${b.actorId}`;
  if (b.phase !== "movement" || b.actorId === null || ui.focusFor === key) return;
  ui.focusFor = key;
  ui.centerPending = true;
  const side = sheetSideOf(b.actorId);
  const d = ui.sheets[side];
  d.unitId = b.actorId;
  d.openedAt = ++ui.seq;
  if (ui.logSheets) ui.logSheets[side] = true;
  else d.open = true;
}

/** Fill behind part of the grid, inset half a cell like a kit box background. */
function fill(col: number, rowN: number, cols: number, rows: number, key: string): TuiNode {
  return h().el("div", {
    class: "ia-fill",
    key,
    style: {
      left: `calc(${col} * var(--cw))`,
      top: `calc(${rowN} * var(--ch))`,
      width: `calc(${cols} * var(--cw))`,
      height: `calc(${rows} * var(--ch))`,
    },
  });
}

function logsTab(open: boolean): TuiNode {
  const label = fit(
    ` ${open ? A.tabDown : A.tabUp} ${t("battle.logsTab")} ${open ? A.tabDown : A.tabUp} `,
    10,
    "center",
  );
  return span(label, { onClick: () => toggleLogs(), key: "logtab", cls: "ia-bright" });
}

function logDrawer(): TuiNode {
  const H = h();
  const b = app.battle!;
  const side = F.h.repeat(43);
  const blank = " ".repeat(43);
  return at(
    0,
    4,
    { class: "ia-logdrawer", key: "logdrawer" },
    fill(44.5, 0.5, 11, 1.5, "tabfill"),
    fill(0.5, 1.5, 99, 25, "fill"),
    row(`${F.v}${blank}${R.nw}${G.th.repeat(10)}${R.ne}${blank}${F.v}`, { key: "lt" }),
    H.el(
      "div",
      { class: "ia-row", key: "lb" },
      `${F.w}${side}${F.hEndL}`,
      logsTab(true),
      `${F.hEndR}${side}${F.e}`,
    ),
    H.el(
      "div",
      { class: "ia-logbody", key: "body" },
      H.el("div", { class: "ia-logside", key: "l" }, `${F.v}\n`.repeat(24)),
      H.el("div", { class: "ia-logpane", key: "p" }, logView(b.log, 24, 96)),
      H.el("div", { class: "ia-logside", key: "r" }, `${F.v}\n`.repeat(24)),
    ),
    row(`${F.sw}${F.h.repeat(98)}${F.se}`, { key: "lz" }),
  );
}

// ------------------------------------------------------------ frame

/** The Turn box value: `curr/max` under Attrition, else the turn alone. */
function turnText(): string {
  const b = app.battle!;
  const m = b.mode;
  return m.kind === "damageRace" ? `${b.state.turn}/${m.turns}` : String(b.state.turn);
}

/** Border, title and the Turn / Phase / Action Order strip (rows 0-3). */
function header(title: string): TuiNode[] {
  const H = h();
  const b = app.battle!;
  const t0 = ` ${title} `;
  const w = cells(t0);
  const lpad = Math.floor((98 - w) / 2);
  const top = `${F.nw}${F.h.repeat(lpad)}${t0}${F.h.repeat(Math.max(0, 98 - w - lpad))}${F.ne}`;
  const edges: TuiNode[] = [];
  for (let r = 1; r <= 3; r++)
    edges.push(
      at(0, r, { class: "ia-row ia-frame", key: `hl${r}` }, F.v),
      at(99, r, { class: "ia-row ia-frame", key: `hr${r}` }, F.v),
    );
  const cell = (text: string | number, cols: number) =>
    H.line({}, span(fit(text, cols, "center"), { cls: "ia-bright" }));
  return [
    at(0, 0, { class: "ia-row ia-frame", key: "f0" }, top),
    ...edges,
    at(
      1,
      1,
      { class: "ia-strip", key: "strip" },
      H.hstack(
        { gap: "0 0" },
        H.box(
          { cols: 8, rows: 3, pad: 0, title: t("battle.turnBox"), key: "turn" },
          cell(turnText(), 6),
        ),
        H.box(
          { cols: 10, rows: 3, pad: 0, title: t("battle.phaseBox"), key: "phase" },
          cell(t(`phase.${b.phase}`), 8),
        ),
        H.scroll(
          {
            cols: QUEUE_W + 2,
            rows: 3,
            pad: 0,
            title: t("battle.orderBox"),
            key: "order",
            class: "ia-queue",
          },
          queueLine(),
        ),
      ),
    ),
  ];
}

/** Side borders of the body (rows 4-29), broken where a closed tab or open drawer sits. */
function sideBorders(): TuiNode[] {
  const ui = app.battleUi;
  const out: TuiNode[] = [];
  for (let r = BODY.row; r < BODY.row + BODY.rows; r++) {
    const tab = r >= TAB_ROW && r <= TAB_ROW + 8;
    // An open drawer draws its own edge.
    const drawn = r >= DRAWER_ROW && r <= DRAWER_ROW + 22;
    ([0, 1] as const).forEach((side) => {
      if (ui.sheets[side].open ? drawn : tab) return;
      out.push(at(side ? 99 : 0, r, { class: "ia-row ia-frame", key: `b${side}${r}` }, F.v));
    });
  }
  return out;
}

function bottomBorder(): TuiNode[] {
  const H = h();
  const side = F.h.repeat(43);
  return [
    fill(44.5, 29.5, 11, 1.5, "ltfill"),
    at(44, 29, { class: "ia-row ia-frame", key: "lt" }, `${R.nw}${G.th.repeat(10)}${R.ne}`),
    at(
      0,
      30,
      { class: "ia-row ia-frame", key: "f30" },
      H.el("span", {}, `${F.w}${side}${F.hEndL}`),
      logsTab(false),
      H.el("span", {}, `${F.hEndR}${side}${F.e}`),
    ),
  ];
}

/**
 * DONE F10 (or, while a persona waits in step pace, NEXT PERSONA): a kit boxed
 * button at the bottom centre, above the LOGS tab.
 */
export function doneButton(onDone: () => void, label = "orders.doneButton"): TuiNode {
  return at(
    42,
    26,
    { class: "ia-done", key: label },
    h().button({ border: "rounded", cols: 16, key: "donebtn", onClick: () => onDone() }, t(label)),
  );
}

/**
 * The whole screen, bottom to top: `under` (the map, the DONE button), the
 * frame and header strip, `over` (the orders menu), then the sheet drawers
 * and tabs. With the LOGS drawer open it replaces all but the map,
 * the DONE button and the header.
 */
export function battleFrame(title: string, under: TuiChild[], over: TuiChild[]): TuiChild[] {
  const ui = app.battleUi;
  // The LOGS drawer draws its own edges; the tabs and the orders hide under it.
  if (ui.logs) return [...under, ...header(title), logDrawer()];
  return [
    ...under,
    ...header(title),
    ...sideBorders(),
    ...bottomBorder(),
    ...over,
    ui.sheets[0].open ? drawer(0) : edgeTab(0),
    ui.sheets[1].open ? drawer(1) : edgeTab(1),
  ];
}
