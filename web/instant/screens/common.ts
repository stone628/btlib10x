/** Small node builders shared by the screen prefabs. */
import { t } from "../i18n";
import type { TuiChild, TuiNode, TuiProps } from "../tui";

export const kit = () => window.TUI;
export const h = () => window.TUI.h;

/** Pad or cut to `cols` cells (wide characters count two). */
export function fit(s: string | number, cols: number, align?: "left" | "right" | "center"): string {
  return kit().fit(String(s), cols, align);
}

export interface RowOpts {
  sel?: boolean;
  cls?: string;
  onClick?: () => void;
  key?: string | number;
  tip?: string;
}

/** One text row; `sel` draws it in reverse video. */
export function row(text: string, o: RowOpts = {}): TuiNode {
  const cls = ["ia-row", o.sel ? "sel" : "", o.cls ?? ""].filter(Boolean).join(" ");
  const props: TuiProps = { class: cls };
  if (o.key !== undefined) props.key = o.key;
  if (o.tip) props.tip = o.tip;
  if (o.onClick) {
    const fn = o.onClick;
    props.onClick = () => fn();
    props.attrs = { "data-click": "" };
  }
  return h().el("div", props, text);
}

export function blank(n = 1): TuiNode[] {
  return Array.from({ length: n }, (_, i) => row(" ", { key: `blank${i}` }));
}

/** Status bar from [key, label] pairs; labels are message keys. */
export function statusbar(pairs: ReadonlyArray<readonly [string, string]>, right = ""): TuiNode {
  const H = h();
  const kids: TuiChild[] = [];
  for (const [k, label] of pairs) kids.push(H.kbd(k), H.text(t(label)));
  kids.push(H.el("span", { class: "tui-grow" }));
  if (right) kids.push(H.text(right));
  return H.statusbar(...kids);
}

/** A centred modal window over the current screen. */
export function modal(props: TuiProps, ...children: TuiChild[]): TuiNode {
  return h().el(
    "div",
    { class: "ia-modal", key: "modal" },
    h().window({ border: "double", shadow: true, ...props }, ...children),
  );
}

/** A row of tab labels; the active one is bracketed, each label is clickable. */
export function tabBar(
  labels: readonly string[],
  active: number,
  pick: (i: number) => void,
): TuiNode {
  const H = h();
  return H.el(
    "div",
    { class: "ia-row ia-bright", key: "tabs" },
    ...labels.map((label, i) =>
      H.el(
        "span",
        {
          key: `tab${i}`,
          class: "ia-tab",
          attrs: { "data-click": "" },
          onClick: () => pick(i),
        },
        i === active ? `[ ${label} ]` : `  ${label}  `,
      ),
    ),
  );
}

/** A scrolling log that keeps its newest line in view (see `afterRender`). */
export function logView(
  entries: readonly { text: string; cls?: string }[],
  rows: number,
  cols: number,
): TuiNode {
  return h().el(
    "div",
    {
      class: "ia-log ia-logscroll",
      key: "logscroll",
      style: { height: `calc(${rows} * var(--ch))` },
    },
    ...entries.map((e, i) => row(fit(e.text, cols), { cls: e.cls ?? "", key: `log${i}` })),
  );
}

/** The persistent map canvas is moved into this slot after each render. */
export function mapSlot(): TuiNode {
  return h().el("div", { class: "ia-mapslot", key: "mapslot", attrs: { "data-tui-raw": "" } });
}
