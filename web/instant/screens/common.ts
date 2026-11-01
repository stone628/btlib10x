/** Small node builders shared by the screen prefabs. */
import { t } from "../i18n";
import type { TipPoint, TuiChild, TuiNode, TuiProps } from "../tui";

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
  onHover?: () => void;
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
  if (o.onHover) {
    const fn = o.onHover;
    props.on = { mouseenter: () => fn() };
  }
  return h().el("div", props, text);
}

export function blank(n = 1): TuiNode[] {
  return Array.from({ length: n }, (_, i) => row(" ", { key: `blank${i}` }));
}

/**
 * Status bar from [key, label] pairs; labels are message keys. A pair with an
 * action is also clickable.
 */
export function statusbar(
  pairs: ReadonlyArray<readonly [string, string, (() => void)?]>,
  right: string | TuiChild[] = "",
): TuiNode {
  const H = h();
  const kids: TuiChild[] = [];
  for (const [k, label, run] of pairs) {
    if (!run) kids.push(H.kbd(k), H.text(t(label)));
    else
      kids.push(
        H.el(
          "span",
          {
            key: `hint-${k}`,
            class: "ia-hint",
            attrs: { "data-click": "" },
            onClick: () => run(),
          },
          H.kbd(k),
          H.text(t(label)),
        ),
      );
  }
  kids.push(H.el("span", { class: "tui-grow" }));
  if (typeof right === "string") {
    if (right) kids.push(H.text(right));
  } else kids.push(...right);
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

/**
 * A row of tab labels; the active one is bracketed, each label is clickable.
 * `center` centres the row.
 */
export function tabBar(
  labels: readonly string[],
  active: number,
  pick: (i: number) => void,
  center = false,
): TuiNode {
  const H = h();
  return H.el(
    "div",
    { class: `ia-row ia-bright${center ? " ia-center" : ""}`, key: "tabs" },
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

/** A node placed at a cell of the 100×32 screen (absolutely positioned). */
export function at(col: number, rowN: number, props: TuiProps, ...children: TuiChild[]): TuiNode {
  const style = {
    left: `calc(${col} * var(--cw))`,
    top: `calc(${rowN} * var(--ch))`,
    ...(props.style ?? {}),
  };
  return h().el(
    "div",
    { ...props, class: `ia-at ${props.class ?? ""}`.trim(), style },
    ...children,
  );
}

export interface SpanOpts {
  cls?: string;
  tip?: string;
  /** Where the tooltip attaches: this span's point, then the tip's point on it. */
  tipAt?: TipPoint;
  tipAnchor?: TipPoint;
  /** A designated tip point in cells from `tipFrom`'s element (see TuiProps). */
  tipXY?: string;
  tipFrom?: string;
  id?: string;
  key?: string | number;
  onClick?: (e: MouseEvent) => void;
}

/** An inline run of text with its own class, tooltip or click. */
export function span(text: string, o: SpanOpts = {}): TuiNode {
  const props: TuiProps = {};
  if (o.cls) props.class = o.cls;
  if (o.tip) props.tip = o.tip;
  if (o.tipAt) props.tipAt = o.tipAt;
  if (o.tipAnchor) props.tipAnchor = o.tipAnchor;
  if (o.tipXY) props.tipXY = o.tipXY;
  if (o.tipFrom) props.tipFrom = o.tipFrom;
  if (o.id) props.id = o.id;
  if (o.key !== undefined) props.key = o.key;
  if (o.onClick) {
    const fn = o.onClick;
    props.onClick = (e) => fn(e);
    props.attrs = { "data-click": "" };
  }
  return h().el("span", props, text);
}

/** Display width of `s` in cells (wide characters count two). */
export function cells(s: string): number {
  return kit().compensatedLength(s);
}

/** The persistent map canvas is moved into this slot after each render. */
export function mapSlot(): TuiNode {
  return h().el("div", { class: "ia-mapslot", key: "mapslot", attrs: { "data-tui-raw": "" } });
}

/** Enabled, visible controls in a container that take the focus (Tab stops). */
export function controls(within: ParentNode): HTMLElement[] {
  return Array.from(within.querySelectorAll<HTMLElement>("button:not(:disabled)")).filter(
    (el) => el.offsetParent !== null && el.tabIndex >= 0,
  );
}

/** The control nearest `from` in an arrow's direction (up / down keep to the next row). */
export function nearest(from: HTMLElement, all: HTMLElement[], arrow: string): HTMLElement | null {
  const c = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, h: r.height };
  };
  const o = c(from);
  const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
    arrow
  ] as [number, number];
  let best: HTMLElement | null = null;
  let score = Infinity;
  for (const el of all) {
    if (el === from) continue;
    const p = c(el);
    const along = (p.x - o.x) * dx + (p.y - o.y) * dy;
    const across = Math.abs(dx ? p.y - o.y : p.x - o.x);
    if (along <= 1 || (dx && across > o.h / 2)) continue;
    // up / down: the nearest row first, then the nearest control in it
    const sc = dx ? along + across : along * 10 + across;
    if (sc < score) {
      score = sc;
      best = el;
    }
  }
  return best;
}
