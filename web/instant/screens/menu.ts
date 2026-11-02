/**
 * Esc menus of the New Battle and deployment screens (the battle and
 * debrief keep their own): a modal list run with ↑ ↓ and Enter / Space,
 * closed with Esc or Backspace. Each ends with Options (language, pace,
 * reasoning log), so a gamepad reaches them.
 */
import { t } from "../i18n";
import { app, type MenuItem, type Modal } from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import { modal, row } from "./common";
import { openOptions, optionsKey, optionsWindow } from "./options";

const { ARROW: A, GRID: G } = UI_THEME;
/** Menu window width in cells; a separator spans the inside. */
const COLS = 40;

type MenuModal = Extract<Modal, { kind: "menu" }>;

/** Open an Esc menu. */
export function openMenu(title: string, items: readonly MenuItem[]): void {
  app.modal = { kind: "menu", title, items, cursor: 0 };
}

/** Options, last, under a separator; closing it comes back to this menu on its row. */
export function prefItems(): MenuItem[] {
  return [
    {
      label: () => t("menu.options"),
      run: () => openOptions(app.modal),
      keep: true,
      sepAbove: true,
    },
  ];
}

/** An open Esc menu, or the Options window it opened; null for other modals. */
export function menuWindow(m: Modal): TuiNode | null {
  if (m.kind === "options") return optionsWindow(m);
  if (m.kind !== "menu") return null;
  return modal(
    { cols: COLS, title: m.title, footer: t("dialog.footer") },
    ...m.items.flatMap((it, i) => [
      ...(it.sepAbove && i > 0
        ? [row(G.th.repeat(COLS - 4), { key: `ms${i}`, cls: "ia-dim" })]
        : []),
      row(`${i === m.cursor ? A.cursor : " "} ${it.label()}`, {
        sel: i === m.cursor,
        key: `mi${i}`,
        onClick: () => runItem(m, i),
      }),
    ]),
  );
}

function runItem(m: MenuModal, i: number): void {
  const it = m.items[i];
  if (!it) return;
  if (!it.keep) app.modal = null;
  else m.cursor = i;
  it.run();
}

/** Keys of an open Esc menu, or of the Options window it opened; true when taken. */
export function menuKey(
  e: KeyboardEvent,
  m: MenuModal | Extract<Modal, { kind: "options" }>,
): boolean {
  if (m.kind === "options") return optionsKey(e, m);
  const n = Math.max(1, m.items.length);
  if (e.key === "ArrowDown") m.cursor = (m.cursor + 1) % n;
  else if (e.key === "ArrowUp") m.cursor = (m.cursor + n - 1) % n;
  else if (e.key === "Enter" || e.key === " ") runItem(m, m.cursor);
  else if (e.key === "Escape" || e.key === "Backspace") app.modal = null;
  else return false;
  return true;
}

/** A / B close a message popup (Enter, Space, Esc, Backspace); other keys are ignored. */
export function closesMessage(e: KeyboardEvent): boolean {
  return ["Enter", " ", "Escape", "Backspace"].includes(e.key);
}
