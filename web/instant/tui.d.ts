/**
 * Types for the subset of the TUI kit (`web/tui.js`, `docs/TUI.md`) that
 * Instant Action uses. The kit is plain JS loaded by a script tag and exposed
 * as `window.TUI`; these declarations are the only coupling.
 */

/** A scene node built by `TUI.h`. Opaque to callers. */
export interface TuiNode {
  readonly __tuiNode?: true;
}

export type TuiChild = TuiNode | string | number | null | false | undefined | readonly TuiChild[];

/** Props every node accepts, plus the component's own ones. */
export interface TuiProps {
  key?: string | number;
  ref?: string;
  id?: string;
  class?: string;
  style?: Record<string, string>;
  attrs?: Record<string, string>;
  tip?: string;
  hidden?: boolean;
  size?: number | string;
  grow?: number;
  span?: number | string;
  onClick?: (e: MouseEvent, scene: TuiScene) => void;
  on?: Record<string, (e: Event, scene: TuiScene) => void>;
  [prop: string]: unknown;
}

export type TuiBuilder = (props?: TuiProps | TuiChild, ...children: TuiChild[]) => TuiNode;

export interface TuiH {
  (type: string, props?: TuiProps | null, ...children: TuiChild[]): TuiNode;
  box: TuiBuilder;
  window: TuiBuilder;
  scroll: TuiBuilder;
  split: TuiBuilder;
  pane: (title?: string | TuiProps, ...children: TuiChild[]) => TuiNode;
  vstack: TuiBuilder;
  hstack: TuiBuilder;
  spacer: TuiBuilder;
  progress: TuiBuilder;
  line: TuiBuilder;
  col: (cells: number, ...children: TuiChild[]) => TuiNode;
  statusbar: TuiBuilder;
  kbd: TuiBuilder;
  btn: TuiBuilder;
  input: TuiBuilder;
  select: TuiBuilder;
  check: TuiBuilder;
  menu: TuiBuilder;
  item: TuiBuilder;
  button: TuiBuilder;
  seg: TuiBuilder;
  text: TuiBuilder;
  el: (tag: string, props?: TuiProps | TuiChild, ...children: TuiChild[]) => TuiNode;
  use: (name: string, props?: TuiProps, ...children: TuiChild[]) => TuiNode;
}

export interface TuiScene {
  readonly el: HTMLElement | undefined;
  readonly refs: Record<string, { readonly el: HTMLElement | undefined }>;
  update(props: Record<string, unknown>): Promise<void>;
  flush(): void;
  render(): void;
  destroy(): void;
}

export interface TuiDialogOptions {
  title?: string;
  text?: string;
  buttons?: string[];
  cols?: number;
  tone?: "accent" | "info" | "warn" | "danger";
  defaultIndex?: number;
}

export interface TuiKit {
  readonly h: TuiH;
  readonly metrics: { readonly cw: number; readonly ch: number };
  prefab(
    name: string,
    defaults: Record<string, unknown>,
    render: (props: Record<string, unknown>) => TuiNode,
  ): void;
  mount(target: HTMLElement, node: TuiNode): TuiScene;
  refresh(): void;
  dialog(opts: TuiDialogOptions): Promise<string | null>;
  popupMenu(
    anchor: HTMLElement,
    items: Array<{
      label?: string;
      html?: string;
      key?: string;
      disabled?: boolean;
      sep?: boolean;
    }>,
    opts?: { cols?: number; active?: number; dx?: number },
  ): Promise<{ index: number } | { nav: number } | null>;
  compensatedLength(s: string): number;
  fit(s: string, cols: number, align?: "left" | "right" | "center"): string;
}

declare global {
  interface Window {
    TUI: TuiKit;
  }
}
