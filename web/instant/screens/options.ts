/**
 * Options: language, persona pace, the persona reasoning log and glyph avatars. Opened from
 * the title menu and from every Esc menu; ↑ ↓ pick a row, ← → (or Enter /
 * Space, or a click) change its value, which applies and is kept at once.
 * Esc / Backspace close it, back to the menu that opened it.
 */
import { type LocaleId, locale, t } from "../i18n";
import {
  AI_PACES,
  app,
  type Modal,
  rerender,
  setAiPace,
  setAiReasoning,
  setGlyphs,
} from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import { fit, h, modal, row } from "./common";

const { ARROW: A } = UI_THEME;
/** Window width in cells; the inside is four less. */
const COLS = 46;
const LABEL_COLS = 24;
const VALUE_COLS = 10;
/** Help lines under the rows. */
const INFO_ROWS = 3;

type OptionsModal = Extract<Modal, { kind: "options" }>;

interface OptionRow {
  key: string;
  label: () => string;
  value: () => string;
  /** One step along the values, either way, round again. */
  step: (d: number) => void;
  info: string;
}

const LOCALES: readonly LocaleId[] = ["en", "ko"];
const LOCALE_NAMES: Record<LocaleId, string> = { en: "English", ko: "한국어" };

function cycle<T>(values: readonly T[], value: T, d: number): T {
  const n = values.length;
  return values[(values.indexOf(value) + d + n) % n]!;
}

const ROWS: readonly OptionRow[] = [
  {
    key: "language",
    label: () => t("menu.language"),
    value: () => LOCALE_NAMES[locale()],
    // the header button keeps the page title and its own pressed state in step
    step: (d) =>
      document
        .querySelector<HTMLButtonElement>(
          `#lang button[data-lang="${cycle(LOCALES, locale(), d)}"]`,
        )
        ?.click(),
    info: "options.info.language",
  },
  {
    key: "pace",
    label: () => t("menu.pace"),
    value: () => t(`pace.${app.aiPace}`),
    step: (d) => setAiPace(cycle(AI_PACES, app.aiPace, d)),
    info: "options.info.pace",
  },
  {
    key: "reasoning",
    label: () => t("options.reasoning"),
    value: () => t(app.aiReasoning ? "options.on" : "options.off"),
    step: () => setAiReasoning(!app.aiReasoning),
    info: "options.info.reasoning",
  },
  {
    key: "glyphs",
    label: () => t("options.glyphs"),
    value: () => t(app.glyphs ? "options.on" : "options.off"),
    step: () => setGlyphs(!app.glyphs),
    info: "options.info.glyphs",
  },
];

/** Open Options over `back` (the Esc menu it came from), which it returns to on closing. */
export function openOptions(back: Modal | null): void {
  app.modal = { kind: "options", cursor: 0, back };
}

export function optionsWindow(m: OptionsModal): TuiNode {
  const H = h();
  const info = t(ROWS[m.cursor]?.info ?? "").split("\n");
  return modal(
    { cols: COLS, title: t("options.title"), footer: t("options.footer") },
    ...ROWS.map((r, i) =>
      H.el(
        "div",
        {
          key: r.key,
          class: i === m.cursor ? "ia-row sel" : "ia-row",
          attrs: { "data-click": "" },
          onClick: () => {
            m.cursor = i;
            r.step(1);
            rerender();
          },
        },
        `${i === m.cursor ? A.cursor : " "} ${fit(r.label(), LABEL_COLS)}`,
        arrow(m, i, A.tabL, -1),
        ` ${fit(r.value(), VALUE_COLS)} `,
        arrow(m, i, A.tabR, 1),
      ),
    ),
    row(" ", { key: "gap" }),
    ...Array.from({ length: INFO_ROWS }, (_, i) =>
      row(`  ${info[i] ?? ""}`, { key: `info${i}`, cls: "ia-dim" }),
    ),
  );
}

/** ◀ / ▶ around a value: a click steps that way. */
function arrow(m: OptionsModal, i: number, glyph: string, d: number): TuiNode {
  return h().el(
    "span",
    {
      attrs: { "data-click": "" },
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        m.cursor = i;
        ROWS[i]?.step(d);
        rerender();
      },
    },
    glyph,
  );
}

/** Keys of the open Options window; true when taken. */
export function optionsKey(e: KeyboardEvent, m: OptionsModal): boolean {
  const n = ROWS.length;
  if (e.key === "ArrowDown") m.cursor = (m.cursor + 1) % n;
  else if (e.key === "ArrowUp") m.cursor = (m.cursor + n - 1) % n;
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight")
    ROWS[m.cursor]?.step(e.key === "ArrowLeft" ? -1 : 1);
  else if (e.key === "Enter" || e.key === " ") ROWS[m.cursor]?.step(1);
  else if (e.key === "Escape" || e.key === "Backspace") app.modal = m.back;
  else return false;
  return true;
}
