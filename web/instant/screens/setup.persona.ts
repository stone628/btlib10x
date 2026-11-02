/**
 * Choose Control (New Battle): Player or one of the personas for a slot,
 * with a detail pane for the highlighted row: role, behaviour settings and
 * move-score weights read from PERSONAS, and how it plays (docs/PERSONA.md
 * §3, §7). Keys as in Choose 'Mech, without its filters.
 */
import {
  AHEAD_YIELD_BONUS,
  AMMO_LEVELS,
  type AmmoLevel,
  HEAT_STEPS,
  type HeatStep,
  PERSONA_KEYS,
  PERSONAS,
  type Persona,
  type PersonaKey,
  type PersonaWeights,
} from "../ai/persona.data";
import { t } from "../i18n";
import { app, type Modal, rerender } from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import { fit, h, kit, listArrow, modal, row, span } from "./common";

/** True while a hint target (weight label, setting key) has the focus. */
function onHint(): boolean {
  return typeof document !== "undefined" && !!document.activeElement?.hasAttribute("data-hint");
}

const { MARK: M, ARROW: A } = UI_THEME;

type PersonaModal = Extract<Modal, { kind: "persona" }>;

/** The list: Player (null), then every persona. */
export const CONTROLS: readonly (PersonaKey | null)[] = [null, ...PERSONA_KEYS];

/** Move-score weights the dialog draws; range and heat are the same for all. */
const SHOWN: readonly (keyof PersonaWeights)[] = [
  "cover",
  "flank",
  "melee",
  "exposed",
  "tmm",
  "crowd",
  "ammo",
];
/** Dialog width; the control list, the description fills the rest of the first row. */
const COLS = 80;
const LIST_COLS = 20;
const DESC_COLS = COLS - 2 - LIST_COLS;
/** Move Weights and Settings split the second row 50:50. */
const HALF = (COLS - 2) >> 1;
const TOP_ROWS = 12;
const MID_ROWS = 9;
/** Weight row: one-cell lead, label, bar, one cell, `value/max`. */
const W_LABEL = 9;
const W_VALUE = 7;
const BAR_COLS = HALF - 2 - 1 - W_LABEL - 1 - W_VALUE;
/** Settings row: one-cell lead, key, value (wrapped). */
const S_LABEL = 11;

export function controlName(p: PersonaKey | null): string {
  return p === null ? t("ctl.player") : PERSONAS[p].name;
}

export function personaModal(side: 0 | 1, index: number): Modal {
  const current = app.loadout.sides[side][index]?.persona ?? null;
  return {
    kind: "persona",
    side,
    index,
    cursor: Math.max(0, CONTROLS.indexOf(current)),
    focusList: true,
  };
}

function choose(m: PersonaModal): void {
  const slot = app.loadout.sides[m.side][m.index];
  const p = CONTROLS[m.cursor];
  if (slot && p !== undefined) slot.persona = p;
  app.modal = null;
}

// ------------------------------------------------------------ detail text

function heatName(n: number): string {
  const step = (Object.keys(HEAT_STEPS) as HeatStep[]).find((k) => HEAT_STEPS[k] === n);
  return step ? `${n} ${t(`persona.heatName.${step}`)}` : String(n);
}

function heatText(p: Persona): string {
  if (p.heatCeilingEngaged !== p.heatCeiling)
    return t("persona.heatEngaged", {
      base: heatName(p.heatCeiling),
      engaged: heatName(p.heatCeilingEngaged),
    });
  const step = (Object.keys(HEAT_STEPS) as HeatStep[]).find((k) => HEAT_STEPS[k] === p.heatCeiling);
  return step
    ? `${heatName(p.heatCeiling)} (${t(`persona.heatEffect.${step}`)})`
    : heatName(p.heatCeiling);
}

function ammoText(p: Persona): string {
  const a = p.ammo;
  const level = (Object.keys(AMMO_LEVELS) as AmmoLevel[]).find((k) => AMMO_LEVELS[k] === a);
  const parts = [t("persona.ammoTn", { tn: a.maxTn })];
  if (a.reserve > 0) parts.push(t("persona.ammoKeep", { pct: Math.round(a.reserve * 100) }));
  if (a.energyFirst) parts.push(t("persona.ammoEnergy"));
  const detail = parts.join(", ");
  return level ? `${t(`persona.ammoName.${level}`)}: ${detail}` : detail;
}

function yieldText(p: Persona): string {
  if (p.yieldAt <= 0) return t("persona.yieldNever");
  const pct = (f: number) => Math.round(f * 100);
  const parts = [t("persona.yieldAt", { pct: pct(p.yieldAt) })];
  if (p.yieldWhenAhead)
    parts.push(t("persona.yieldAhead", { pct: pct(p.yieldAt + AHEAD_YIELD_BONUS) }));
  // with no physical attacks it also yields once its guns are gone (persona.ts)
  if (p.melee === "never") parts.push(t("persona.yieldGuns"));
  return parts.join(", ");
}

/** Behaviour settings as [label, value, hint], values from PERSONAS. */
export function personaFacts(p: Persona): [string, string, string][] {
  const fact = (key: string, value: string): [string, string, string] => [
    t(`persona.${key}`),
    value,
    t(`persona.hint.${key}`),
  ];
  return [
    fact("range", t(`persona.band.${p.range}`)),
    fact("heat", heatText(p)),
    fact("ammo", ammoText(p)),
    fact("melee", t(`persona.meleePref.${p.melee}`)),
    fact("jump", t(p.jump === "none" ? "persona.jumpNever" : "persona.jumpUsed")),
    fact("yield", yieldText(p)),
  ];
}

/** The largest value any persona gives `term`: a full bar. */
export function weightMax(term: keyof PersonaWeights): number {
  return Math.max(...PERSONA_KEYS.map((k) => PERSONAS[k].weights[term]));
}

/** `text` broken at spaces into lines of at most `cols` cells (wide characters count two). */
function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(" ")) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && kitLen(next) > cols) {
        out.push(cur);
        cur = word;
      } else cur = next;
    }
    out.push(cur);
  }
  return out;
}

function kitLen(s: string): number {
  return kit().compensatedLength(s);
}

/** Role line, how it plays and (personas) the stall note. */
function descRows(p: PersonaKey | null): TuiNode[] {
  const out: TuiNode[] = [];
  const text = DESC_COLS - 4;
  const para = (s: string, cls?: string) => {
    for (const l of wrap(s, text))
      out.push(row(` ${l}`, { key: `d${out.length}`, ...(cls ? { cls } : {}) }));
  };
  const key = p ?? "player";
  para(t(`persona.tag.${key}`), "ia-bright");
  out.push(row(" ", { key: `d${out.length}` }));
  para(t(`persona.body.${key}`));
  if (p !== null) {
    out.push(row(" ", { key: `d${out.length}` }));
    para(t("persona.stall"), "ia-dim");
  }
  return out;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

function weightRows(p: Persona | null): TuiNode[] {
  const H = h();
  if (p === null) return [row(` ${t("persona.none")}`, { key: "none", cls: "ia-dim" })];
  return SHOWN.map((term) => {
    const v = p.weights[term];
    const max = weightMax(term);
    return H.el(
      "div",
      { key: term, class: "ia-row" },
      " ",
      span(fit(t(`persona.w.${term}`), W_LABEL), {
        tip: t(`persona.hint.w.${term}`),
        hint: `w-${term}`,
      }),
      H.progress({ cols: BAR_COLS, value: max > 0 ? v / max : 0, label: "none" }),
      ` ${fit(`${fmt(v)}/${fmt(max)}`, W_VALUE)}`,
    );
  });
}

function settingRows(p: Persona | null): TuiNode[] {
  if (p === null) return [row(` ${t("persona.none")}`, { key: "none", cls: "ia-dim" })];
  const H = h();
  const out: TuiNode[] = [];
  for (const [label, value, tip] of personaFacts(p)) {
    wrap(value, HALF - 3 - S_LABEL).forEach((l, i) => {
      out.push(
        H.el(
          "div",
          { key: `s${out.length}`, class: "ia-row" },
          " ",
          i === 0
            ? span(fit(label, S_LABEL), { tip, hint: `s-${out.length}` })
            : " ".repeat(S_LABEL),
          l,
        ),
      );
    });
  }
  return out;
}

// ------------------------------------------------------------ dialog

/**
 * Three rows: the control list beside the scrolling description; Move
 * Weights beside the scrolling Settings (50:50); Cancel and Use. Weight
 * labels and setting keys are hint targets: arrows reach them (not Tab) and
 * their tooltip says what each does.
 */
export function personaBrowser(m: PersonaModal): TuiNode {
  const H = h();
  const current = app.loadout.sides[m.side][m.index]?.persona ?? null;
  const rows = CONTROLS.map((p, i) =>
    H.el(
      "div",
      {
        key: p ?? "player",
        class: `ia-row${i === m.cursor ? " sel" : ""}`,
        // Roving focus: only the cursor row is a Tab stop; ↑ ↓ move it.
        attrs: { "data-click": "", "data-listrow": "", tabindex: i === m.cursor ? "0" : "-1" },
        onClick: () => {
          m.cursor = i;
        },
        on: {
          dblclick: () => {
            m.cursor = i;
            choose(m);
            rerender();
          },
        },
      },
      ` ${i === m.cursor ? A.cursor : p === current ? M.on : " "} ${controlName(p)}`,
    ),
  );
  const sel = CONTROLS[m.cursor] ?? null;
  const persona = sel === null ? null : PERSONAS[sel];
  const grid = (a: number, b: number) => ({
    display: "grid",
    "grid-template-columns": `calc(${a} * var(--cw)) calc(${b} * var(--cw))`,
  });
  const top = H.el(
    "div",
    { key: "top", style: grid(LIST_COLS, DESC_COLS) },
    H.box(
      { key: "list", cols: LIST_COLS, rows: TOP_ROWS, pad: 0, title: t("persona.list") },
      ...rows,
    ),
    H.scroll(
      {
        key: `desc-${sel ?? "player"}`,
        cols: DESC_COLS,
        rows: TOP_ROWS,
        pad: 0,
        title: controlName(sel),
      },
      ...descRows(sel),
    ),
  );
  const mid = H.el(
    "div",
    { key: "mid", style: grid(HALF, COLS - 2 - HALF) },
    H.box(
      { key: "weights", cols: HALF, rows: MID_ROWS, pad: 0, title: t("persona.weights") },
      ...weightRows(persona),
    ),
    H.scroll(
      {
        key: `set-${sel ?? "player"}`,
        cols: COLS - 2 - HALF,
        rows: MID_ROWS,
        pad: 0,
        title: t("persona.settings"),
      },
      ...settingRows(persona),
    ),
  );
  const cancelText = t("btn.cancel");
  const useText = t("persona.use", { name: controlName(sel) });
  const buttons = H.el(
    "div",
    { key: "btns", class: "ia-row" },
    " ".repeat(Math.max(0, COLS - 2 - kitLen(cancelText) - kitLen(useText) - 10)),
    H.btn(
      {
        key: "cancel",
        onClick: () => {
          app.modal = null;
        },
      },
      cancelText,
    ),
    " ",
    H.btn({ key: "use", attrs: { "data-use": "" }, onClick: () => choose(m) }, useText),
  );
  const slot = app.loadout.sides[m.side][m.index];
  return modal(
    {
      cols: COLS,
      rows: TOP_ROWS + MID_ROWS + 3,
      pad: 0,
      title: t("persona.title", { id: slot?.id ?? "" }),
    },
    top,
    mid,
    buttons,
  );
}

/** Choose Control keys: ↑ ↓ (see `personaArrow`), PgUp / Home first, PgDn / End last, Enter / Space use, Esc / Backspace cancel. */
export function personaKey(e: KeyboardEvent, m: PersonaModal): boolean {
  const move = (to: number) => {
    m.cursor = Math.max(0, Math.min(CONTROLS.length - 1, to));
    m.focusList = true;
  };
  if (e.key === "Escape" || e.key === "Backspace") app.modal = null;
  else if (e.key.startsWith("Arrow")) personaArrow(e.key, m);
  else if (e.key === "PageUp" || e.key === "Home") move(0);
  else if (e.key === "PageDown" || e.key === "End") move(CONTROLS.length - 1);
  // on a hint target Enter / Space do nothing: only the list or Use picks
  else if (e.key === "Enter" || e.key === " ") {
    if (!onHint()) choose(m);
  } else return false;
  return true;
}

export function personaArrow(key: string, m: PersonaModal): void {
  listArrow(key, m.cursor, CONTROLS.length, (to) => {
    m.cursor = to;
    m.focusList = true;
  });
}
