/** Screen 0: title menu. */
import { randomBattle } from "../flow";
import { t } from "../i18n";
import { sideBv } from "../setup/loadout";
import { app, rerender } from "../state";
import type { TuiNode } from "../tui";
import { blank, fit, h, row, statusbar } from "./common";

const ART = [
  "██████╗ ████████╗ ██╗ ██████╗ ██╗  ██╗",
  "██╔══██╗╚══██╔══╝███║██╔═████╗╚██╗██╔╝",
  "██████╔╝   ██║   ╚██║██║██╔██║ ╚███╔╝ ",
  "██╔══██╗   ██║    ██║████╔╝██║ ██╔██╗ ",
  "██████╔╝   ██║    ██║╚██████╔╝██╔╝ ██╗",
  "╚═════╝    ╚═╝    ╚═╝ ╚═════╝ ╚═╝  ╚═╝",
];

export interface TitleItem {
  label: string;
  key: string;
  run: () => void;
}

export function titleItems(): TitleItem[] {
  return [
    {
      label: "title.new",
      key: "Enter",
      run: () => {
        app.screen = "setup";
        app.tab = 0;
      },
    },
    { label: "title.random", key: "R", run: randomBattle },
    {
      label: "title.lang",
      key: "L",
      run: () => {
        app.cursors.rules = 4;
        app.screen = "setup";
        app.tab = 3;
      },
    },
    { label: "title.help", key: "F1", run: () => (app.modal = { kind: "help" }) },
  ];
}

export function titleScreen(): TuiNode {
  const H = h();
  const items = titleItems();
  const l = app.loadout;
  const last = t("title.last", {
    a: l.sides[0].map((s) => s.model).join(", "),
    b: l.sides[1].map((s) => s.model).join(", "),
    map: l.map,
    bv: `${sideBv(l.sides[0])} / ${sideBv(l.sides[1])}`,
  });
  const menu = items.map((it, i) =>
    row(
      fit(`${i === app.cursors.title ? "▸ " : "  "}${t(it.label)}`, 26) + fit(it.key, 6, "right"),
      {
        sel: i === app.cursors.title,
        key: it.label,
        onClick: () => {
          app.cursors.title = i;
          it.run();
          rerender();
        },
      },
    ),
  );
  return H.el(
    "div",
    { class: "ia-root" },
    H.box(
      { cols: 100, rows: 31, border: "double" },
      ...blank(4),
      ...ART.map((a, i) => row(a, { cls: "ia-title-art", key: `art${i}` })),
      ...blank(1),
      row(t("title.subtitle"), { cls: "ia-center ia-bright", key: "sub" }),
      ...blank(3),
      H.el(
        "div",
        { style: { display: "flex", "justify-content": "center" } },
        H.box({ cols: 36, border: "single" }, ...menu),
      ),
      ...blank(5),
      row(fit(last, 96), { cls: "ia-dim", key: "last" }),
      row(fit(t("legal"), 96), { cls: "ia-dim", key: "legal" }),
    ),
    statusbar(
      [
        ["↑↓", "key.select"],
        ["Enter", "key.ok"],
        ["F1", "key.help"],
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
  else if (e.code === "KeyR") randomBattle();
  else if (e.code === "KeyL") items[2]!.run();
  else return false;
  return true;
}
