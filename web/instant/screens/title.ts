/** Screen 0: title menu. */
import { randomBattle } from "../flow";
import { t } from "../i18n";
import { app, rerender } from "../state";
import type { TuiNode } from "../tui";
import { blank, fit, h, kit, row, statusbar } from "./common";

const ART = [
  "██████╗ ████████╗ ██╗ ██████╗ ██╗  ██╗",
  "██╔══██╗╚══██╔══╝███║██╔═████╗╚██╗██╔╝",
  "██████╔╝   ██║   ╚██║██║██╔██║ ╚███╔╝ ",
  "██╔══██╗   ██║    ██║████╔╝██║ ██╔██╗ ",
  "██████╔╝   ██║    ██║╚██████╔╝██╔╝ ██╗",
  "╚═════╝    ╚═╝    ╚═╝ ╚═════╝ ╚═╝  ╚═╝",
];

/** Rows above the status bar. */
const ROWS = 31;

export interface TitleItem {
  label: string;
  /** Message key of the line under the menu that explains this item. */
  info: string;
  run: () => void;
}

export function titleItems(): TitleItem[] {
  return [
    {
      label: "title.new",
      info: "title.info.new",
      run: () => {
        app.screen = "setup";
        app.tab = 0;
      },
    },
    { label: "title.random", info: "title.info.random", run: randomBattle },
  ];
}

export function titleScreen(): TuiNode {
  const H = h();
  const items = titleItems();
  const cur = Math.min(app.cursors.title, items.length - 1);
  const labelCols = Math.max(...items.map((it) => kit().compensatedLength(t(it.label))));
  const menu = items.map((it, i) =>
    row(` ${i === cur ? "▸" : " "} ${fit(t(it.label), labelCols)} `, {
      sel: i === cur,
      key: it.label,
      onHover: () => {
        if (app.cursors.title === i) return;
        app.cursors.title = i;
        rerender();
      },
      onClick: () => {
        app.cursors.title = i;
        it.run();
        rerender();
      },
    }),
  );
  // logo, gap, subtitle, gap ×3, boxed menu, gap, info line
  const used = ART.length + 1 + 1 + 3 + (items.length + 2) + 1 + 1;
  const top = Math.floor((ROWS - used) / 2);
  return H.el(
    "div",
    { class: "ia-root" },
    H.el(
      "div",
      { style: { height: `calc(${ROWS} * var(--ch))`, padding: "0 calc(2 * var(--cw))" } },
      ...blank(top),
      ...ART.map((a, i) => row(a, { cls: "ia-title-art", key: `art${i}` })),
      ...blank(1),
      row(t("title.subtitle"), { cls: "ia-center ia-bright", key: "sub" }),
      ...blank(3),
      H.el(
        "div",
        { style: { display: "flex", "justify-content": "center" } },
        H.box({ cols: labelCols + 6, pad: 0, border: "single" }, ...menu),
      ),
      ...blank(1),
      row(t(items[cur]!.info), { cls: "ia-center", key: "info" }),
    ),
    statusbar(
      [
        ["↑↓", "key.select"],
        ["Enter", "key.ok"],
        ["F1", "key.help", () => (app.modal = { kind: "help" })],
      ],
      `v${app.version}`,
    ),
  );
}

export function titleKey(e: KeyboardEvent): boolean {
  const items = titleItems();
  if (e.key === "ArrowDown") app.cursors.title = (app.cursors.title + 1) % items.length;
  else if (e.key === "ArrowUp")
    app.cursors.title = (app.cursors.title + items.length - 1) % items.length;
  else if (e.key === "Enter") items[app.cursors.title]!.run();
  else return false;
  return true;
}
