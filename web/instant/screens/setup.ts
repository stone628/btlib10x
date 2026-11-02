/**
 * Screen 1: New Battle. Both sides, the map preview and the match options on
 * one 100×31 window; ID, seed and turn limit edit in an input dialog, the
 * 'Mech in the Choose 'Mech dialog, the control in Choose Control
 * (`setup.persona.ts`), policies in their own dialog.
 */
import {
  catalogMaps,
  DEFAULT_UNIT_POLICY,
  designTotalsByWeaponName,
  ensureMapRegistered,
  heatDissipationMax,
  type Location,
} from "btlib10x";
import { launch, mapSource } from "../flow";
import { locName, t } from "../i18n";
import { bracket } from "../input";
import { createRng } from "../rng";
import {
  addedSlot,
  defaultFilter,
  emptyLoadout,
  filterMechs,
  idProblem,
  loadoutProblem,
  MAX_SLOTS,
  mechDef,
  newSeed,
  PILOT_HIT_MAX,
  PILOT_HIT_MIN,
  SEED_MAX,
  type Slot,
  sideBv,
  TURN_LIMIT_DEFAULT,
  TURN_LIMIT_MAX,
  TURN_LIMIT_MIN,
  type WeightClass,
} from "../setup/loadout";
import { AI_PACES, app, kitModal, type Modal, rerender, setAiPace } from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import {
  blank,
  controls,
  cycleModalFocus,
  fit,
  h,
  kit,
  listArrow,
  listRow,
  mapSlot,
  modal,
  modalFocusables,
  nearest,
  row,
  statusbar,
} from "./common";
import { closesMessage, menuKey, menuWindow, openMenu, prefItems } from "./menu";
import {
  controlName,
  personaArrow,
  personaBrowser,
  personaKey,
  personaModal,
} from "./setup.persona";

const { GRID: G, MARK: M, ARROW: A } = UI_THEME;

const AMMO = ["exposed", "core", "spread", "leastFirst"] as const;
const AMS = ["expected", "firstHit", "priority", "off"] as const;
const ERAS = [3025, 3050, 3075, 3150];
const SKILLS = [0, 1, 2, 3, 4, 5, 6, 7];
const HIT_MAXES = Array.from(
  { length: PILOT_HIT_MAX - PILOT_HIT_MIN + 1 },
  (_, i) => PILOT_HIT_MIN + i,
);
const MODES = [null, "destroyAll", "damageRace"] as const;

/** `data-return` of the button whose dialog is open: it takes the focus back on close. */
let returnFocus: string | null = null;

/** Width of the map box, and of the config column beside it. */
const MAP_COLS = 50;
const CFG = 46;

/** Wrap kit controls and text into one text row. */
function line(key: string, ...kids: (TuiNode | string)[]): TuiNode {
  return h().el("div", { key, class: "ia-row" }, ...kids);
}

/** `[x]` button; `fit` pads the label to a fixed width first. */
function tight(
  key: string,
  text: string,
  onClick: () => void,
  cls?: string,
  attrs?: Record<string, string>,
): TuiNode {
  return h().btn(
    { key, variant: "tight", onClick, ...(cls ? { class: cls } : {}), ...(attrs ? { attrs } : {}) },
    text,
  );
}

/** `[ x ]` button. */
function button(key: string, text: string, onClick: () => void, primary = false): TuiNode {
  return h().btn({ key, primary, onClick }, text);
}

/** A value in a field band; pressing it opens its editor. */
function field(key: string, text: string, cols: number, onClick: () => void): TuiNode {
  return h().btn({ key, variant: "field", onClick }, fit(text, cols));
}

/** Kit Select over `values`; `set` gets the picked value. */
function select<T>(
  key: string,
  cols: number,
  values: readonly T[],
  value: T,
  label: (v: T) => string,
  set: (v: T) => void,
): TuiNode {
  return h().select({
    key,
    cols,
    value: String(values.indexOf(value)),
    options: values.map((v, i) => ({ value: String(i), label: label(v) })),
    onChange: (e: Event) => {
      const i = Number((e.target as HTMLSelectElement).value);
      if (values[i] !== undefined) set(values[i]!);
      rerender();
    },
  });
}

// ------------------------------------------------------------ screen

export function setupScreen(): TuiNode {
  const H = h();
  const l = app.loadout;
  const problem = loadoutProblem(l);
  return H.el(
    "div",
    { class: "ia-root" },
    H.box(
      {
        key: "setup",
        cols: 100,
        rows: 31,
        border: "double",
        title: t("setup.title"),
        titleAlign: "center",
        pad: 0,
      },
      sideBox(0),
      sideBox(1),
      H.el(
        "div",
        {
          key: "lower",
          style: {
            display: "grid",
            "grid-template-columns": `calc(${MAP_COLS} * var(--cw)) calc(2 * var(--cw)) calc(${CFG} * var(--cw))`,
          },
        },
        H.box(
          { key: "mapbox", cols: MAP_COLS, rows: 15, pad: 0 },
          ...(l.map === null
            ? [
                ...blank(6),
                row(fit(t("setup.noMapPreview"), MAP_COLS - 2, "center"), {
                  key: "nomap",
                  cls: "ia-dim",
                }),
              ]
            : [H.el("div", { style: { height: "calc(13 * var(--ch))" } }, mapSlot())]),
        ),
        H.el("div", {}),
        H.el("div", { key: "cfg", class: "ia-setup-cfg" }, ...configRows()),
      ),
    ),
    statusbar(
      [
        ["[ ]", "key.group"],
        ["Enter", "key.open"],
        ["Esc", "key.menu", openSetupMenu],
        ["F10", "key.launch", () => doLaunch()],
      ],
      app.error && !problem ? `! ${app.error}` : "",
    ),
    app.modal ? modalNode(app.modal) : null,
  );
}

function doLaunch(): void {
  try {
    app.error = null;
    launch();
  } catch (e) {
    app.error = e instanceof Error ? e.message : String(e);
  }
}

// ------------------------------------------------------------ sides

function sideHeader(): string {
  return (
    "     " +
    fit(t("setup.id"), 5) +
    fit("'Mech", 29) +
    fit("BV", 5, "right") +
    "  " +
    fit(t("setup.gunnery"), 7) +
    fit(t("setup.piloting"), 7) +
    fit(t("setup.hitMax"), 8) +
    fit(t("setup.control"), 20) +
    t("setup.policy")
  );
}

function sideBox(side: 0 | 1): TuiNode {
  const slots = app.loadout.sides[side];
  const rows: TuiNode[] = [row(sideHeader(), { key: "head", cls: "ia-dim" })];
  slots.forEach((s, i) => {
    rows.push(slotRow(side, i, s));
  });
  if (slots.length < MAX_SLOTS)
    rows.push(
      line(
        "add",
        tight("add", "+", () => addSlot(side)),
      ),
    );
  while (rows.length < 5) rows.push(row(" ", { key: `pad${rows.length}` }));
  return h().box(
    {
      key: `side${side}`,
      cols: 98,
      rows: 7,
      pad: 0,
      title: t(side === 0 ? "setup.side1" : "setup.side2").toUpperCase(),
      class: side === 0 ? "ia-side1" : "ia-side2",
    },
    ...rows,
  );
}

function slotRow(side: 0 | 1, i: number, s: Slot): TuiNode {
  const def = s.model === null ? null : mechDef(s.model);
  const mech = def ? `${def.model} ${def.name}` : "N/A";
  const id = s.id.length > 4 ? `${s.id.slice(0, 3)}${M.more}` : s.id;
  return line(
    `slot${i}`,
    tight("del", "-", () => removeSlot(side, i)),
    " ",
    field("id", id, 4, () => editId(s)),
    " ",
    tight(
      "mech",
      fit(mech, 26, def ? "left" : "center"),
      () => {
        returnFocus = `mech-${side}-${i}`;
        app.modal = mechModal(side, i);
      },
      "ia-slot-mech",
      { "data-return": `mech-${side}-${i}` },
    ),
    " ",
    fit(def ? def.bv : "-", 5, "right"),
    "  ",
    select("gun", 5, SKILLS, s.gunnery, String, (v) => (s.gunnery = v)),
    "  ",
    select("pil", 5, SKILLS, s.piloting, String, (v) => (s.piloting = v)),
    "  ",
    select("hit", 6, HIT_MAXES, s.pilotHitMax, String, (v) => (s.pilotHitMax = v)),
    "  ",
    h().btn(
      {
        key: "ctl",
        variant: "tight",
        attrs: { "data-return": `ctl-${side}-${i}` },
        onClick: () => {
          returnFocus = `ctl-${side}-${i}`;
          app.modal = personaModal(side, i);
        },
      },
      fit(controlName(s.persona), 16),
    ),
    "  ",
    tight("pol", M.more, () => {
      app.modal = {
        kind: "policy",
        id: s.id,
        draft: { ...s.policy },
        apply: (p) => {
          s.policy = p;
        },
      };
    }),
  );
}

function addSlot(side: 0 | 1): void {
  const slots = app.loadout.sides[side];
  if (slots.length >= MAX_SLOTS) return;
  const slot = addedSlot(createRng(newSeed()), app.loadout, side);
  if (slot) slots.push(slot);
}

function removeSlot(side: 0 | 1, i: number): void {
  app.loadout.sides[side].splice(i, 1);
}

// ------------------------------------------------------------ map, seed, engagement

function configRows(): TuiNode[] {
  const l = app.loadout;
  const maps = catalogMaps();
  const names = [null, ...maps.map((m) => m.name)];
  const out: TuiNode[] = [
    row(" ", { key: "c0" }),
    line(
      "c1",
      fit(t("setup.map"), 14),
      select(
        "map",
        CFG - 16,
        names,
        l.map,
        (n) => {
          const m = maps.find((x) => x.name === n);
          return m ? `${m.name} (${m.width}${M.times}${m.height})` : t("setup.noMap");
        },
        (n) => (l.map = n),
      ),
    ),
    line(
      "c2",
      fit(t("setup.seed"), 14),
      field("seed", ` ${l.seed}`, CFG - 21, () => editSeed()),
      " ",
      tight("seednew", A.reroll, () => {
        l.seed = newSeed();
      }),
    ),
    line(
      "c3",
      fit(t("menu.pace"), 14),
      select("pace", CFG - 16, AI_PACES, app.aiPace, (p) => t(`pace.${p}`), setAiPace),
    ),
    row(" ", { key: "c4" }),
    line(
      "c5",
      fit(t("setup.victory"), 14),
      select(
        "mode",
        CFG - 16,
        MODES,
        l.mode?.kind ?? null,
        (k) =>
          k === null
            ? t("setup.noMode")
            : t(k === "damageRace" ? "victory.damage" : "victory.destroyAll"),
        (k) => {
          if (k === null) l.mode = null;
          else if (k === "destroyAll") l.mode = { kind: "destroyAll" };
          else if (l.mode?.kind !== "damageRace")
            l.mode = { kind: "damageRace", turns: TURN_LIMIT_DEFAULT };
        },
      ),
    ),
    l.mode?.kind === "damageRace"
      ? line("c6", fit(t("setup.turnLimit"), 14), field("turns", ` ${l.mode.turns}`, 6, editTurns))
      : row(" ", { key: "c6" }),
    ...blank(1),
    ...bvRows(),
    row(" ", { key: "c10" }),
  ];
  const problem = loadoutProblem(l);
  out.push(
    row(fit(problem ? t(problem.key, problem.vars) : "", CFG, "center"), {
      key: "c11",
      cls: "ia-err",
    }),
    row(" ", { key: "c12" }),
    line(
      "c13",
      " ".repeat((CFG - 17 - discardCols() - 2) >> 1),
      button("discard", t("deploy.discard"), confirmDiscard),
      "  ",
      // F10 or a click only: Enter / Space on the focused button does nothing
      h().btn(
        { key: "launch", primary: true, attrs: { "data-commit": "" }, onClick: () => doLaunch() },
        fit(t("setup.launch"), 13, "center"),
      ),
    ),
  );
  return out;
}

function bvRows(): TuiNode[] {
  const H = h();
  const a = sideBv(app.loadout.sides[0]);
  const b = sideBv(app.loadout.sides[1]);
  const close = Math.abs(a - b) < Math.min(a, b) * 0.05;
  const cls = (mine: number, other: number) =>
    close ? "ia-bv-even" : mine > other ? "ia-bv-high" : "ia-bv-low";
  const head =
    fit(t("setup.side1").toUpperCase(), 12, "center") +
    "    " +
    fit(t("setup.side2").toUpperCase(), 12, "center");
  const left = " ".repeat((CFG - 28) >> 1);
  return [
    row(left + head, { key: "c8" }),
    H.el(
      "div",
      { key: "c9", class: "ia-row" },
      left,
      H.el("span", { class: cls(a, b) }, fit(`BV ${a}`, 12, "center")),
      " vs ",
      H.el("span", { class: cls(b, a) }, fit(`BV ${b}`, 12, "center")),
    ),
  ];
}

// ------------------------------------------------------------ input dialogs

function inputDialog(
  title: string,
  label: string,
  value: string,
  apply: (v: string) => string | null,
): void {
  app.modal = { kind: "input", title, label, value, cols: 24, error: null, apply };
}

function editId(s: Slot): void {
  inputDialog(t("idDialog.title", { id: s.id }), t("idDialog.label"), s.id, (v) => {
    const id = v.trim();
    const problem = idProblem(app.loadout, s, id);
    if (problem) return t(problem);
    s.id = id;
    return null;
  });
}

function editSeed(): void {
  const l = app.loadout;
  inputDialog(
    t("seedDialog.title"),
    t("seedDialog.label", { max: SEED_MAX }),
    String(l.seed),
    (v) => {
      const n = Number(v.trim());
      if (!/^\d+$/.test(v.trim()) || n > SEED_MAX) return t("seedDialog.error", { max: SEED_MAX });
      l.seed = n;
      return null;
    },
  );
}

function editTurns(): void {
  const l = app.loadout;
  if (l.mode?.kind !== "damageRace") return;
  const range = { min: TURN_LIMIT_MIN, max: TURN_LIMIT_MAX };
  inputDialog(t("turnsDialog.title"), t("turnsDialog.label", range), String(l.mode.turns), (v) => {
    const n = Number(v.trim());
    if (!/^\d+$/.test(v.trim()) || n < TURN_LIMIT_MIN || n > TURN_LIMIT_MAX)
      return t("turnsDialog.error", range);
    l.mode = { kind: "damageRace", turns: n };
    return null;
  });
}

function submitInput(m: Extract<Modal, { kind: "input" }>): void {
  const err = m.apply(m.value);
  if (err === null) app.modal = null;
  else m.error = err;
}

function inputWindow(m: Extract<Modal, { kind: "input" }>): TuiNode {
  const H = h();
  const cols = 48;
  return modal(
    { cols, title: m.title, pad: 1 },
    row(m.label, { key: "label" }),
    row(" ", { key: "b0" }),
    line(
      "field",
      H.input({
        key: "inp",
        cols: m.cols,
        value: m.value,
        attrs: { spellcheck: "false", autocomplete: "off" },
        onInput: (e: Event) => {
          m.value = (e.target as HTMLInputElement).value;
        },
        onKeydown: (e: Event) => {
          const k = (e as KeyboardEvent).key;
          if (k === "Enter") submitInput(m);
          else if (k === "Escape") app.modal = null;
          else return;
          e.preventDefault();
          rerender();
        },
      }),
    ),
    row(m.error ?? " ", { key: "err", cls: "ia-err" }),
    okCancel(cols - 4, () => submitInput(m)),
  );
}

/** [ OK ] [ Cancel ] at the right of a `width`-cell row, after `lead`. */
function okCancel(
  width: number,
  ok: () => void,
  lead?: TuiNode,
  leadCols = 0,
  cancel: () => void = () => {
    app.modal = null;
  },
): TuiNode {
  const okText = t("btn.ok");
  const cancelText = t("btn.cancel");
  const used = leadCols + kitLen(okText) + 4 + kitLen(cancelText) + 4 + 1;
  return line(
    "btns",
    ...(lead ? [lead] : []),
    " ".repeat(Math.max(1, width - used)),
    button("ok", okText, ok),
    " ",
    button("cancel", cancelText, cancel),
  );
}

// ------------------------------------------------------------ policy dialog

/** Policy dialog of a setup slot or, in battle, of the acting unit. */
export function policyWindow(m: Extract<Modal, { kind: "policy" }>): TuiNode {
  const d = m.draft;
  const onOff = [true, false] as const;
  const toOnOff = (v: boolean) => t(v ? "on" : "off");
  const items: [string, TuiNode][] = [
    [
      "policy.ammo",
      select(
        "ammo",
        16,
        AMMO,
        d.ammoPolicy,
        (x) => t(`ammo.${x}`),
        (x) => (d.ammoPolicy = x),
      ),
    ],
    [
      "policy.autoEject",
      select("eject", 16, onOff, d.autoEject, toOnOff, (x) => (d.autoEject = x)),
    ],
    [
      "policy.heatFlamer",
      select("flamer", 16, onOff, d.heatFlamer, toOnOff, (x) => (d.heatFlamer = x)),
    ],
    [
      "policy.ams",
      select(
        "ams",
        16,
        AMS,
        d.amsPolicy,
        (x) => t(`ams.${x}`),
        (x) => (d.amsPolicy = x),
      ),
    ],
  ];
  const cols = 46;
  const defaults = t("btn.defaults");
  return modal(
    { cols, title: t("policy.title", { id: m.id }), pad: 1 },
    ...items.map(([k, c]) => line(k, fit(t(k), 24), c)),
    row(" ", { key: "b0" }),
    okCancel(
      cols - 4,
      () => {
        app.modal = m.back ?? null;
        m.apply({ ...d });
      },
      button("defaults", defaults, () => {
        m.draft = { ...DEFAULT_UNIT_POLICY };
      }),
      kitLen(defaults) + 4,
      () => {
        app.modal = m.back ?? null;
      },
    ),
  );
}

// ------------------------------------------------------------ Choose 'Mech

function mechModal(side: 0 | 1, index: number): Modal {
  const f = defaultFilter();
  const list = filterMechs(f);
  const model = app.loadout.sides[side][index]?.model;
  return {
    kind: "mech",
    side,
    index,
    filter: f,
    cursor: Math.max(
      0,
      list.findIndex((m) => m.model === model),
    ),
    reveal: true,
    focusList: true,
  };
}

function chooseMech(m: Extract<Modal, { kind: "mech" }>, model: string): void {
  const slot = app.loadout.sides[m.side][m.index];
  if (slot) slot.model = model;
  app.modal = null;
}

function refilter(m: Extract<Modal, { kind: "mech" }>): void {
  m.cursor = 0;
  m.reveal = true;
}

const CLASSES: readonly (WeightClass | null)[] = [null, "light", "medium", "heavy", "assault"];
const TECHS = ["any", "is", "clan"] as const;
const PACKS = ["any", "base", "sw"] as const;
const SORTS = ["ton", "name", "bv", "intro"] as const;
/**
 * Search Options: Name / Class label and control widths; the dropdown widths
 * of the other rows (a dropdown's width holds its value, a lead cell, ▼ and
 * one cell of slack: sub-pixel widths otherwise cut the last letter).
 */
const OPT_LABEL = 7;
const OPT_CTL = 14;
const TECH_CTL = 7;
const ERA_CTL = 8;
const SORT_CTL = 10;

function mechBrowser(m: Extract<Modal, { kind: "mech" }>): TuiNode {
  const H = h();
  const f = m.filter;
  const list = filterMechs(f);
  const total = filterMechs(defaultFilter()).length;
  m.cursor = Math.min(m.cursor, Math.max(0, list.length - 1));
  const search = H.input({
    key: "search",
    cols: OPT_CTL + 2,
    placeholder: t("mech.search"),
    value: f.text,
    attrs: { spellcheck: "false", autocomplete: "off" },
    onInput: (e: Event) => {
      f.text = (e.target as HTMLInputElement).value;
      refilter(m);
      rerender();
    },
    onKeydown: (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Escape") app.modal = null;
      else if (ke.key === "Enter") m.focusList = true;
      else if (ke.key === "Tab") cycleModalFocus(ke.shiftKey ? -1 : 1);
      else if (ke.key === "ArrowDown" || ke.key === "ArrowUp") mechArrow(ke.key, m);
      else return;
      ke.preventDefault();
      rerender();
    },
  });
  // a filter dropdown: changing it starts the list over at the top
  const filterSelect = <T>(
    key: string,
    cols: number,
    values: readonly T[],
    value: T,
    label: (v: T) => string,
    set: (v: T) => void,
  ) =>
    select(key, cols, values, value, label, (v) => {
      set(v);
      refilter(m);
    });
  // a label padded to `cols` cells, else one cell after it
  const label = (key: string, cols = 0) => {
    const text = t(key);
    return fit(text, Math.max(cols, kitLen(text) + 1));
  };
  const any = t("tech.any");
  const sortLabel = label("mech.sort");
  const sortCols = kitLen(sortLabel) + SORT_CTL;
  const options = H.box(
    { key: "opts", cols: 50, rows: 5, pad: 0, title: t("mech.options") },
    line(
      "o1",
      label("mech.name", OPT_LABEL),
      search,
      "  ",
      label("mech.class", OPT_LABEL),
      filterSelect(
        "class",
        OPT_CTL,
        CLASSES,
        f.classes.length === 1 ? f.classes[0]! : null,
        (c) => (c === null ? any : t(`wclass.${c}`)),
        (c) => (f.classes = c === null ? [] : [c]),
      ),
    ),
    line(
      "o2",
      label("mech.tech"),
      filterSelect(
        "tech",
        TECH_CTL,
        TECHS,
        f.tech,
        (x) => t(`tech.${x}`),
        (x) => (f.tech = x),
      ),
      "  ",
      label("mech.pack"),
      filterSelect(
        "pack",
        TECH_CTL,
        PACKS,
        f.pack,
        (x) => (x === "any" ? any : x),
        (x) => (f.pack = x),
      ),
      "  ",
      label("mech.era"),
      filterSelect(
        "era",
        ERA_CTL,
        ERAS,
        f.introMax,
        (y) => `≤${y}`,
        (y) => (f.introMax = y),
      ),
    ),
    line(
      "o3",
      sortLabel,
      filterSelect(
        "sort",
        SORT_CTL,
        SORTS,
        f.sort,
        (x) => t(`sort.${x}`),
        (x) => (f.sort = x),
      ),
      // the count keeps its own cells: a focused dropdown never pushes it
      fit(t("mech.matched", { n: list.length, total }), 48 - sortCols, "right"),
    ),
  );
  const rows = list.map((e, i) =>
    H.el(
      "div",
      {
        key: e.model,
        class: `ia-row${i === m.cursor ? " sel" : ""}`,
        // Roving focus: only the cursor row is a Tab stop; ↑ ↓ move it.
        attrs: { "data-click": "", "data-listrow": "", tabindex: i === m.cursor ? "0" : "-1" },
        onClick: () => {
          m.cursor = i;
        },
        on: {
          dblclick: () => {
            chooseMech(m, e.model);
            rerender();
          },
        },
      },
      `  ${fit(e.model, 11)} ${fit(e.name, 13)}${fit(e.tonnage, 3, "right")} ${fit(e.bv, 5, "right")} ${fit(e.intro, 4, "right")}  ${fit(e.pack, 4)}`,
    ),
  );
  const listBox = H.scroll(
    { key: "list", cols: 50, rows: 18, pad: 0, title: listHeader(), class: "ia-mechlist" },
    ...(rows.length ? rows : [row(` ${t("mech.none")}`, { key: "none", cls: "ia-dim" })]),
  );
  const sel = list[m.cursor];
  const cancelText = t("btn.cancel");
  const useText = t("mech.use", { model: sel ? sel.model : "-" });
  const right: TuiNode[] = [
    selectedBox(sel?.model ?? null),
    row(" ", { key: "rb" }),
    line(
      "btns",
      " ".repeat(Math.max(0, (43 - kitLen(cancelText) - kitLen(useText) - 9) >> 1)),
      button("cancel", cancelText, () => {
        app.modal = null;
      }),
      " ",
      h().btn(
        {
          key: "use",
          disabled: !sel,
          attrs: { "data-use": "" },
          onClick: () => {
            if (sel) chooseMech(m, sel.model);
          },
        },
        useText,
      ),
    ),
  ];
  const slot = app.loadout.sides[m.side][m.index];
  return modal(
    { cols: 96, rows: 25, pad: 0, title: t("mech.title", { id: slot?.id ?? "" }) },
    H.el(
      "div",
      {
        key: "cols",
        style: {
          display: "grid",
          "grid-template-columns": "calc(50 * var(--cw)) calc(1 * var(--cw)) calc(43 * var(--cw))",
        },
      },
      H.el("div", { key: "left" }, options, listBox),
      H.el("div", {}),
      H.el("div", { key: "right" }, ...right),
    ),
  );
}

function kitLen(s: string): number {
  return window.TUI.compensatedLength(s);
}

/**
 * A box title that puts each label over its content column. The kit draws a
 * title from cell 2 after one space, so content cell x sits under title cell
 * x - 2; rows start with two spaces to line up. Widths count cells, so wide
 * (Korean) labels keep the columns after them in place.
 */
function columnTitle(labels: readonly [number, string][]): string {
  let out = "";
  let at = 0;
  for (const [x, label] of labels) {
    out += G.th.repeat(Math.max(0, x - 2 - at)) + label;
    at = Math.max(at, x - 2) + kitLen(label);
  }
  return out;
}

/** 'Mech list columns: model 2, chassis 14, ton 27–29, BV 31–35 (label at 32), era 37–40, pack 43. */
function listHeader(): string {
  const bv = "BV";
  const ton = t("mech.colTon");
  return columnTitle([
    [2, t("mech.colModel")],
    [14, t("mech.colChassis")],
    [30 - kitLen(ton), ton],
    [34 - kitLen(bv), bv],
    [37, t("mech.colEra")],
    [43, t("mech.colPack")],
  ]);
}

const SHORT: Record<Location, string> = {
  head: "HD",
  centerTorso: "CT",
  leftTorso: "LT",
  rightTorso: "RT",
  leftArm: "LA",
  rightArm: "RA",
  leftLeg: "LL",
  rightLeg: "RL",
};

function selectedBox(model: string | null): TuiNode {
  const H = h();
  const lines: TuiNode[] = [];
  if (model === null) {
    lines.push(row(` ${t("mech.none")}`, { key: "none", cls: "ia-dim" }));
    return H.box({ key: "sel", cols: 43, rows: 20, pad: 0, title: t("mech.selected") }, ...lines);
  }
  const def = mechDef(model);
  const cls = def.weightClass.toLowerCase();
  lines.push(
    row(fit(`${def.model} ${def.name}`, 41), { key: "i0", cls: "ia-bright" }),
    row(fit(`${t(`wclass.${cls}`)} ${def.tonnage}t ${def.techBase}`, 41), { key: "i1" }),
    row(fit(`${t("mech.era")} ${def.intro}   BV ${def.bv}`, 41), { key: "i2" }),
    row(
      fit(
        `${t("mech.walk")} ${def.walking}  ${t("mech.run")} ${def.running}  ${t("mech.jump")} ${def.jumping}`,
        41,
      ),
      { key: "i3" },
    ),
  );
  // Ammo: every mount of a weapon shares one pool; the first mount shows the
  // shots, the others point at it (`#N`, as the terminal sheet does).
  const pools = designTotalsByWeaponName(def);
  const mounts = Object.values(def.weapons);
  const first = new Map<string, number>();
  mounts.forEach((w, i) => {
    if (!first.has(w.weapon)) first.set(w.weapon, i + 1);
  });
  const wrows = mounts.map((w, i) => {
    const lead = first.get(w.weapon)!;
    const pool = pools[w.weapon];
    const shot = pool === undefined ? "" : lead === i + 1 ? String(pool) : `#${lead}`;
    const name = w.weapon + (w.rearFacing ? " (R)" : "");
    return row(
      `  ${fit(i + 1, 2, "right")} ${fit(name, 23)} ${fit(locName(w.location), 4)} ${fit(shot, 4, "right")}`,
      { key: `w${i}` },
    );
  });
  // Weapon rows: index 2–3, name 5, location 29, shots 34–37 (right-aligned).
  const shot = t("mech.shot");
  const weaponTitle = columnTitle([
    [3, "#"],
    [5, `${t("mech.weapon")}(${mounts.length})`],
    [29, t("mech.loc")],
    [38 - kitLen(shot), shot],
  ]);
  lines.push(
    H.scroll(
      {
        key: `weapons-${model}`,
        cols: 41,
        rows: 7,
        pad: 0,
        title: weaponTitle,
      },
      ...wrows,
    ),
  );
  lines.push(...armorDiagram(model));
  return H.box({ key: "sel", cols: 43, rows: 20, pad: 0, title: t("mech.selected") }, ...lines);
}

/**
 * Paper-doll armor, seven rows: I internal, A armor, F / R torso front /
 * rear, HS heat dissipation. Each location takes a 7-cell column (arms
 * outside, torsos and legs between); head and legs share the centre / side
 * torso columns.
 */
function armorDiagram(model: string): TuiNode[] {
  const def = mechDef(model);
  const W = 39;
  const grid = Array.from({ length: 7 }, () => Array.from({ length: W }, () => " "));
  const put = (r: number, x: number, s: string) => {
    for (let i = 0; i < s.length; i++) if (x + i < W) grid[r]![x + i] = s[i]!;
  };
  /** `s` centred in the 7-cell column at `x`. */
  const cell = (r: number, x: number, s: string) => put(r, x + Math.max(0, (7 - s.length) >> 1), s);
  const pair = (a: number, x: string, b: number, y: string) =>
    `${String(a).padStart(2)}${x}/${String(b).padStart(2)}${y}`;
  const tag = (l: Location) => `[ ${SHORT[l][0]} ${SHORT[l][1]} ]`;
  const IA = (l: Location) => pair(def.internalStructure[l], "I", def.armor[l], "A");
  const RA = 0;
  const RT = 8;
  const CT = 16;
  const LT = 24;
  const LA = 32;
  cell(0, CT, tag("head"));
  put(0, W - 4, "[HS]");
  cell(1, CT, IA("head"));
  const hs = `-${heatDissipationMax(def)}`;
  put(1, W - hs.length, hs);
  for (const [x, l] of [
    [RT, "rightTorso"],
    [CT, "centerTorso"],
    [LT, "leftTorso"],
  ] as const) {
    cell(2, x, tag(l));
    cell(3, x, `${def.internalStructure[l]}I`);
    cell(4, x, pair(def.armor[l], "F", def.armorRear[l], "R"));
  }
  for (const [x, l] of [
    [RA, "rightArm"],
    [LA, "leftArm"],
  ] as const) {
    cell(3, x, tag(l));
    cell(4, x, IA(l));
  }
  for (const [x, l] of [
    [RT, "rightLeg"],
    [LT, "leftLeg"],
  ] as const) {
    cell(5, x, tag(l));
    cell(6, x, IA(l));
  }
  const off = " ".repeat((41 - W) >> 1);
  return grid.map((r, i) => row(fit(off + r.join(""), 41), { key: `a${i}` }));
}

function mechKey(e: KeyboardEvent, m: Extract<Modal, { kind: "mech" }>): boolean {
  const list = filterMechs(m.filter);
  const move = (to: number) => {
    m.cursor = Math.max(0, Math.min(list.length - 1, to));
    m.reveal = true;
    m.focusList = true;
  };
  if (e.key === "Escape" || e.key === "Backspace") app.modal = null;
  else if (e.key.startsWith("Arrow")) mechArrow(e.key, m);
  else if (e.key === "PageDown") move(m.cursor + 16);
  else if (e.key === "PageUp") move(m.cursor - 16);
  else if (e.key === "Enter" || e.key === " ") {
    const sel = list[m.cursor];
    if (sel) chooseMech(m, sel.model);
  } else return false;
  return true;
}

/** Choose 'Mech arrows: the shared dialog-list arrows (`listArrow`) over the filtered list. */
function mechArrow(key: string, m: Extract<Modal, { kind: "mech" }>): void {
  listArrow(key, m.cursor, filterMechs(m.filter).length, (to) => {
    m.cursor = to;
    m.reveal = true;
    m.focusList = true;
  });
}

// ------------------------------------------------------------ modals, keys

function modalNode(m: Modal): TuiNode | null {
  switch (m.kind) {
    case "mech":
      return mechBrowser(m);
    case "persona":
      return personaBrowser(m);
    case "input":
      return inputWindow(m);
    case "policy":
      return policyWindow(m);
    case "menu":
    case "options":
      return menuWindow(m);
    case "message":
      return modal(
        { cols: 60, title: m.title },
        row(m.text),
        ...blank(1),
        row(t("key.anyKey"), { cls: "ia-dim" }),
      );
    default:
      return null;
  }
}

export function setupKey(e: KeyboardEvent): boolean {
  const m = app.modal;
  if (m) {
    if (m.kind === "message") {
      if (!closesMessage(e)) return false;
      app.modal = null;
      return true;
    }
    if (m.kind === "menu" || m.kind === "options") return menuKey(e, m);
    if (e.key === "Tab") {
      cycleModalFocus(e.shiftKey ? -1 : 1);
      return true;
    }
    if (m.kind === "mech") return mechKey(e, m);
    if (m.kind === "persona") return personaKey(e, m);
    if (e.key === "Escape" || e.key === "Backspace") {
      app.modal = null;
      return true;
    }
    if (m.kind === "input" && e.key === "Enter") {
      submitInput(m);
      return true;
    }
    return false;
  }
  if (e.key === "F10") doLaunch();
  else if (e.key === "Escape") openSetupMenu();
  else if (bracket(e)) stepGroup(bracket(e));
  else return false;
  return true;
}

function openSetupMenu(): void {
  openMenu(t("setupMenu.title"), [
    { label: () => t("key.launch"), run: doLaunch },
    { label: () => t("deploy.discard"), run: confirmDiscard },
    ...prefItems(),
  ]);
}

/** Width of the Discard button: its label and the kit's "[ " … " ]". */
function discardCols(): number {
  return kit().compensatedLength(t("deploy.discard")) + 4;
}

/** Discard the setup (confirm first) and return to the title. */
function confirmDiscard(): void {
  kitModal.open = true;
  void kit()
    .dialog({
      title: t("setup.discardTitle"),
      text: t("setup.discardText"),
      buttons: [t("yes"), t("no")],
      defaultIndex: 1,
      tone: "warn",
    })
    .then((r) => {
      kitModal.open = false;
      if (r === t("yes")) {
        app.loadout = emptyLoadout();
        app.error = null;
        app.screen = "title";
      }
      rerender();
    });
}

/** The three control groups [ ] jump between: Side 1, Side 2, battle settings. */
const GROUPS = [".ia-side1", ".ia-side2", ".ia-setup-cfg"];

function stepGroup(dir: number): void {
  const groups = GROUPS.map((g) => document.querySelector<HTMLElement>(`#app ${g}`));
  const at = groups.findIndex((g) => g?.contains(document.activeElement));
  const n = groups.length;
  // from outside every group, ] lands on the first and [ on the last
  const from = at >= 0 ? at : dir > 0 ? -1 : n;
  for (let k = 1; k <= n; k++) {
    const g = groups[(((from + dir * k) % n) + n) % n];
    const first = g ? controls(g)[0] : undefined;
    if (first) {
      first.focus();
      return;
    }
  }
}

/**
 * New Battle arrows, ahead of the kit's own keys (capture phase): every arrow
 * moves the focus to the nearest control that way, a dropdown included (Enter
 * opens it to change the value); in Choose 'Mech and Choose Control, their list arrows. True when taken.
 */
export function setupArrow(e: KeyboardEvent): boolean {
  if (e.shiftKey || !e.key.startsWith("Arrow")) return false;
  if (app.modal?.kind === "mech") {
    mechArrow(e.key, app.modal);
    return true;
  }
  if (app.modal?.kind === "persona") {
    personaArrow(e.key, app.modal);
    return true;
  }
  if (app.modal) return false;
  const root = document.querySelector<HTMLElement>("#app .ia-root");
  if (!root) return false;
  const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const all = controls(root);
  if (!from || !all.includes(from)) {
    all[0]?.focus();
    return true;
  }
  const next = nearest(from, all, e.key);
  next?.focus();
  return true;
}

/** After each setup render: focus a newly opened dialog, keep the list cursor in view. */
export function setupAfterRender(): void {
  const m = app.modal;
  // a dialog just closed: back to the button that opened it
  if (!m && returnFocus !== null) {
    const opener = document.querySelector<HTMLElement>(`#app [data-return="${returnFocus}"]`);
    returnFocus = null;
    opener?.focus();
  }
  // nothing focused (the screen just opened): start on the first 'Mech, else the first control
  if (!m && (document.activeElement === document.body || !document.activeElement)) {
    const root = document.querySelector<HTMLElement>("#app .ia-root");
    const start = root?.querySelector<HTMLElement>(".ia-slot-mech") ?? (root && controls(root)[0]);
    start?.focus();
  }
  const win = document.querySelector<HTMLElement>("#app .ia-modal");
  if (win && !win.dataset.focused) {
    win.dataset.focused = "1";
    const inp = win.querySelector<HTMLInputElement>("input.tui-input");
    if (m?.kind === "input" && inp) {
      inp.focus();
      inp.select();
    } else if (m?.kind !== "mech" && m?.kind !== "persona") modalFocusables()[0]?.focus();
  }
  if ((m?.kind === "mech" || m?.kind === "persona") && m.focusList && win) {
    m.focusList = false;
    // an empty list leaves the focus on the first control (the search)
    const target = listRow(win) ?? modalFocusables()[0];
    target?.focus({ preventScroll: true });
  }
  if (m?.kind === "mech" && m.reveal) {
    m.reveal = false;
    document
      .querySelector<HTMLElement>("#app .ia-mechlist .ia-row.sel")
      ?.scrollIntoView({ block: "nearest" });
  }
}

export function setupMapPreview(): void {
  if (!app.mapView) return;
  const map = app.loadout.map === null ? null : ensureMapRegistered(app.loadout.map);
  if (map) app.mapView.setMap(mapSource(map));
  app.mapView.overlays = {};
  app.mapView.banners = [];
}
