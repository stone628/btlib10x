/**
 * Screen 1: New Battle. Both sides, the map preview and the match options on
 * one 100×31 window; ID, seed and turn limit edit in an input dialog, the
 * 'Mech in the Choose 'Mech dialog, policies in their own dialog.
 */
import {
  catalogMaps,
  DEFAULT_UNIT_POLICY,
  designTotalsByWeaponName,
  ensureMapRegistered,
  heatDissipationMax,
  type Location,
} from "btlib10x";
import { PERSONA_KEYS, PERSONAS, type PersonaKey } from "../ai/persona.data";
import { launch, mapSource } from "../flow";
import { locName, t } from "../i18n";
import { createRng } from "../rng";
import {
  addedSlot,
  defaultFilter,
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
import { AI_PACES, app, type Modal, rerender, setAiPace } from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import { blank, fit, h, mapSlot, modal, row, statusbar } from "./common";

const { GRID: G, MARK: M, ARROW: A } = UI_THEME;

const AMMO = ["exposed", "core", "spread", "leastFirst"] as const;
const AMS = ["expected", "firstHit", "priority", "off"] as const;
const ERAS = [3025, 3050, 3075, 3150];
const CLASSES: WeightClass[] = ["light", "medium", "heavy", "assault"];
const SKILLS = [0, 1, 2, 3, 4, 5, 6, 7];
const HIT_MAXES = Array.from(
  { length: PILOT_HIT_MAX - PILOT_HIT_MIN + 1 },
  (_, i) => PILOT_HIT_MIN + i,
);
const CONTROLS: (PersonaKey | null)[] = [null, ...PERSONA_KEYS];
const MODES = [null, "destroyAll", "damageRace"] as const;

/** Width of the map box, and of the config column beside it. */
const MAP_COLS = 50;
const CFG = 46;

function controlName(p: PersonaKey | null): string {
  return p === null ? t("ctl.player") : PERSONAS[p].name;
}

/** Wrap kit controls and text into one text row. */
function line(key: string, ...kids: (TuiNode | string)[]): TuiNode {
  return h().el("div", { key, class: "ia-row" }, ...kids);
}

/** `[x]` button; `fit` pads the label to a fixed width first. */
function tight(key: string, text: string, onClick: () => void, cls?: string): TuiNode {
  return h().btn({ key, variant: "tight", onClick, ...(cls ? { class: cls } : {}) }, text);
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
        H.el("div", { key: "cfg" }, ...configRows()),
      ),
    ),
    statusbar(
      [
        ["Tab", "key.next"],
        ["Enter", "key.open"],
        ["Esc", "key.title", () => (app.screen = "title")],
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
    tight("mech", fit(mech, 26, def ? "left" : "center"), () => {
      app.modal = mechModal(side, i);
    }),
    " ",
    fit(def ? def.bv : "-", 5, "right"),
    "  ",
    select("gun", 5, SKILLS, s.gunnery, String, (v) => (s.gunnery = v)),
    "  ",
    select("pil", 5, SKILLS, s.piloting, String, (v) => (s.piloting = v)),
    "  ",
    select("hit", 6, HIT_MAXES, s.pilotHitMax, String, (v) => (s.pilotHitMax = v)),
    "  ",
    select("ctl", 18, CONTROLS, s.persona, controlName, (v) => (s.persona = v)),
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
      " ".repeat((CFG - 17) >> 1),
      button("launch", fit(t("setup.launch"), 13, "center"), () => doLaunch(), true),
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
function okCancel(width: number, ok: () => void, lead?: TuiNode, leadCols = 0): TuiNode {
  const okText = t("btn.ok");
  const cancelText = t("btn.cancel");
  const used = leadCols + kitLen(okText) + 4 + kitLen(cancelText) + 4 + 1;
  return line(
    "btns",
    ...(lead ? [lead] : []),
    " ".repeat(Math.max(1, width - used)),
    button("ok", okText, ok),
    " ",
    button("cancel", cancelText, () => {
      app.modal = null;
    }),
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
        app.modal = null;
        m.apply({ ...d });
      },
      button("defaults", defaults, () => {
        m.draft = { ...DEFAULT_UNIT_POLICY };
      }),
      kitLen(defaults) + 4,
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

function mechBrowser(m: Extract<Modal, { kind: "mech" }>): TuiNode {
  const H = h();
  const f = m.filter;
  const list = filterMechs(f);
  const total = filterMechs(defaultFilter()).length;
  m.cursor = Math.min(m.cursor, Math.max(0, list.length - 1));
  const chip = (c: WeightClass, i: number): (TuiNode | string)[] => {
    const label = `${t(`wclass.${c}`)}(${i + 1})`;
    return [
      H.check(
        {
          key: `cls-${c}`,
          checked: f.classes.includes(c),
          onChange: () => {
            toggleClass(m, c);
            rerender();
          },
        },
        label,
      ),
      " ".repeat(Math.max(1, 9 - kitLen(label))),
    ];
  };
  const search = H.input({
    key: "search",
    cols: 17,
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
      if (ke.key === "Escape") (ke.target as HTMLElement).blur();
      else if (ke.key === "ArrowDown" || ke.key === "ArrowUp" || ke.key === "Enter") mechKey(ke, m);
      else return;
      ke.preventDefault();
      rerender();
    },
  });
  const flat = (key: string, text: string, run: () => void) =>
    H.btn({ key, variant: "bare", onClick: run }, text);
  const sortText = `${t("mech.sort")}(S):${t(`sort.${f.sort}`)}`;
  const options = H.box(
    { key: "opts", cols: 50, rows: 6, pad: 0, title: t("mech.options") },
    line("o1", "/ ", search, "  ", ...chip("light", 0), ...chip("medium", 1)),
    line("o2", " ".repeat(21), ...chip("heavy", 2), ...chip("assault", 3)),
    line(
      "o3",
      flat("tech", `${t("mech.tech")}(T):${t(`tech.${f.tech}`)}`, () => cycleTech(m)),
      flat("pack", `${t("mech.pack")}(K):${f.pack}`, () => cyclePack(m)),
      flat("era", `${t("mech.era")}(E):≤${f.introMax}`, () => cycleEra(m)),
    ),
    line(
      "o4",
      flat("sort", sortText, () => cycleSort(m)),
      fit(t("mech.matched", { n: list.length, total }), 48 - kitLen(sortText) - 2, "right"),
    ),
  );
  const rows = list.map((e, i) =>
    H.el(
      "div",
      {
        key: e.model,
        class: `ia-row${i === m.cursor ? " sel" : ""}`,
        attrs: { "data-click": "" },
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
    { key: "list", cols: 50, rows: 20, pad: 0, title: listHeader(), class: "ia-mechlist" },
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
    { cols: 96, rows: 28, pad: 0, title: t("mech.title", { id: slot?.id ?? "" }) },
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

function toggleClass(m: Extract<Modal, { kind: "mech" }>, c: WeightClass): void {
  const f = m.filter;
  f.classes = f.classes.includes(c) ? f.classes.filter((x) => x !== c) : [...f.classes, c];
  refilter(m);
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
    return H.box({ key: "sel", cols: 43, rows: 23, pad: 0, title: t("mech.selected") }, ...lines);
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
  return H.box({ key: "sel", cols: 43, rows: 23, pad: 0, title: t("mech.selected") }, ...lines);
}

/** Paper-doll armor: I internal, A armor, F / R torso front / rear. */
function armorDiagram(model: string): TuiNode[] {
  const def = mechDef(model);
  const W = 26;
  const grid = Array.from({ length: 10 }, () => Array.from({ length: W }, () => " "));
  const put = (r: number, x: number, s: string) => {
    for (let i = 0; i < s.length; i++) if (x + i < W) grid[r]![x + i] = s[i]!;
  };
  const cell = (r: number, x: number, s: string) => put(r, x, s.padStart(4));
  const I = (l: Location) => `${def.internalStructure[l]}I`;
  const A = (l: Location) => `${def.armor[l]}A`;
  const F = (l: Location) => `${def.armor[l]}F`;
  const R = (l: "centerTorso" | "leftTorso" | "rightTorso") => `${def.armorRear[l]}R`;
  const tag = (l: Location) => `[${SHORT[l]}]`;
  put(0, 11, tag("head"));
  put(0, 22, "[HS]");
  cell(1, 11, I("head"));
  cell(1, 22, `-${heatDissipationMax(def)}`);
  cell(2, 11, A("head"));
  put(3, 6, tag("rightTorso"));
  put(3, 11, tag("centerTorso"));
  put(3, 16, tag("leftTorso"));
  put(4, 1, tag("rightArm"));
  put(4, 22, tag("leftArm"));
  for (const [x, l] of [
    [6, "rightTorso"],
    [11, "centerTorso"],
    [16, "leftTorso"],
  ] as const) {
    cell(4, x, I(l));
    cell(5, x, F(l));
    cell(6, x, R(l));
  }
  for (const [x, l] of [
    [1, "rightArm"],
    [22, "leftArm"],
  ] as const) {
    cell(5, x, I(l));
    cell(6, x, A(l));
  }
  put(7, 6, tag("rightLeg"));
  put(7, 16, tag("leftLeg"));
  for (const [x, l] of [
    [6, "rightLeg"],
    [16, "leftLeg"],
  ] as const) {
    cell(8, x, I(l));
    cell(9, x, A(l));
  }
  const off = " ".repeat((41 - W) >> 1);
  return grid.map((r, i) => row(fit(off + r.join(""), 41), { key: `a${i}` }));
}

function cycleTech(m: Extract<Modal, { kind: "mech" }>): void {
  const f = m.filter;
  f.tech = f.tech === "any" ? "is" : f.tech === "is" ? "clan" : "any";
  refilter(m);
}

function cyclePack(m: Extract<Modal, { kind: "mech" }>): void {
  const f = m.filter;
  f.pack = f.pack === "any" ? "base" : f.pack === "base" ? "sw" : "any";
  refilter(m);
}

function cycleEra(m: Extract<Modal, { kind: "mech" }>): void {
  const f = m.filter;
  f.introMax = ERAS[(ERAS.indexOf(f.introMax) + 1) % ERAS.length]!;
  refilter(m);
}

function cycleSort(m: Extract<Modal, { kind: "mech" }>): void {
  const sorts = ["ton", "name", "bv", "intro"] as const;
  const f = m.filter;
  f.sort = sorts[(sorts.indexOf(f.sort) + 1) % sorts.length]!;
  refilter(m);
}

function mechKey(e: KeyboardEvent, m: Extract<Modal, { kind: "mech" }>): boolean {
  const list = filterMechs(m.filter);
  const move = (to: number) => {
    m.cursor = Math.max(0, Math.min(list.length - 1, to));
    m.reveal = true;
  };
  if (e.key === "Escape") app.modal = null;
  else if (e.key === "/") {
    document.querySelector<HTMLInputElement>("#app .ia-modal input")?.focus();
  } else if (e.key === "ArrowDown") move(m.cursor + 1);
  else if (e.key === "ArrowUp") move(m.cursor - 1);
  else if (e.key === "PageDown") move(m.cursor + 18);
  else if (e.key === "PageUp") move(m.cursor - 18);
  else if (e.key === "Home") move(0);
  else if (e.key === "End") move(list.length - 1);
  else if (e.key === "Enter") {
    const sel = list[m.cursor];
    if (sel) chooseMech(m, sel.model);
  } else if (/^Digit[1-4]$/.test(e.code)) {
    const c = CLASSES[Number(e.code.slice(5)) - 1]!;
    const f = m.filter;
    f.classes = f.classes.includes(c) ? f.classes.filter((x) => x !== c) : [...f.classes, c];
    refilter(m);
  } else if (e.code === "KeyT") cycleTech(m);
  else if (e.code === "KeyK") cyclePack(m);
  else if (e.code === "KeyE") cycleEra(m);
  else if (e.code === "KeyS") cycleSort(m);
  else return false;
  return true;
}

// ------------------------------------------------------------ modals, keys

function modalNode(m: Modal): TuiNode | null {
  switch (m.kind) {
    case "mech":
      return mechBrowser(m);
    case "input":
      return inputWindow(m);
    case "policy":
      return policyWindow(m);
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

/** Focusable controls of the open modal, in screen order. */
function modalFocusables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "#app .ia-modal button:not(:disabled), #app .ia-modal input:not([type=hidden])",
    ),
  ).filter((el) => el.offsetParent !== null);
}

export function setupKey(e: KeyboardEvent): boolean {
  const m = app.modal;
  if (m) {
    if (m.kind === "message") {
      app.modal = null;
      return true;
    }
    if (e.key === "Tab") {
      // Keep Tab inside the dialog.
      const els = modalFocusables();
      if (els.length === 0) return true;
      const i = els.indexOf(document.activeElement as HTMLElement);
      const next = i < 0 ? 0 : (i + (e.shiftKey ? els.length - 1 : 1)) % els.length;
      els[next]!.focus();
      return true;
    }
    if (m.kind === "mech") return mechKey(e, m);
    if (e.key === "Escape") {
      app.modal = null;
      return true;
    }
    if (m.kind === "input" && e.key === "Enter") {
      submitInput(m);
      return true;
    }
    return false;
  }
  if (e.key === "F10") {
    doLaunch();
    return true;
  }
  if (e.key === "Escape") {
    app.screen = "title";
    return true;
  }
  return false;
}

/** After each setup render: focus a newly opened dialog, keep the list cursor in view. */
export function setupAfterRender(): void {
  const m = app.modal;
  const win = document.querySelector<HTMLElement>("#app .ia-modal");
  if (win && !win.dataset.focused) {
    win.dataset.focused = "1";
    const inp = win.querySelector<HTMLInputElement>("input.tui-input");
    if (m?.kind === "input" && inp) {
      inp.focus();
      inp.select();
    } else if (m?.kind !== "mech") modalFocusables()[0]?.focus();
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
