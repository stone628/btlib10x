/** Screen 0: title menu. */
import { randomBattle } from "../flow";
import { t } from "../i18n";
import { app, rerender } from "../state";
import { UI_THEME } from "../theme";
import type { TuiNode } from "../tui";
import { blank, h, kit, row, statusbar } from "./common";

const { ARROW: A } = UI_THEME;

/** The logo is art: its block glyphs stay inline, outside UI_THEME. */
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
  const menu = H.menu(
    {
      key: "menu",
      cols: labelCols + 6,
      onSelect: (e: Event) => {
        const i = (e as CustomEvent<{ index: number }>).detail.index;
        app.cursors.title = i;
        items[i]?.run();
        rerender();
      },
      on: { mousemove: syncCursor, keydown: syncCursor },
    },
    ...items.map((it) => H.item({ key: it.label, value: it.label }, t(it.label))),
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
      H.el("div", { style: { display: "flex", "justify-content": "center" } }, menu),
      ...blank(1),
      row(t(items[cur]!.info), { cls: "ia-center", key: "info" }),
    ),
    statusbar(
      [
        [`${A.up}${A.down}`, "key.select"],
        ["Enter", "key.ok"],
      ],
      `v${app.version}`,
    ),
  );
}

/** The kit menu's own cursor (hover, arrows); read once its handler has run. */
interface MenuCtl {
  readonly active: number;
  set(i: number): void;
}

function menuCtl(el: Element | null): MenuCtl | null {
  return (el as { _tui?: { menu?: MenuCtl } } | null)?._tui?.menu ?? null;
}

function syncCursor(e: Event): void {
  const el = e.currentTarget as Element;
  setTimeout(() => {
    const active = menuCtl(el)?.active ?? -1;
    if (active < 0 || active === app.cursors.title) return;
    app.cursors.title = active;
    rerender();
  }, 0);
}

/** After a title render: the menu shows the remembered item and takes the keys. */
export function titleAfterRender(): void {
  const el = document.querySelector<HTMLElement>('#app [data-tui="menu"]');
  const ctl = menuCtl(el);
  if (!el || !ctl) return;
  if (ctl.active !== app.cursors.title) ctl.set(app.cursors.title);
  if (!app.modal && (document.activeElement === document.body || !document.activeElement))
    el.focus();
}
