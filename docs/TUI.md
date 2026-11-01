# TUI Kit (draft 0.2)

Terminal-style UI components in plain HTML, CSS and JS. No build step, no framework.
The goal is TUI looks, not cell-exact emulation: a pressed button is a reverse-video
style, not a one-row shift.

Plain served files at the `web/` root, like the other pages (no esbuild step):

```
web/
  tui.css             tokens, border sets, component styles
  tui.js              cell metrics, box drawing, behaviour (exposes window.TUI)
  tui-demo.html       every component and border set, in English / Korean / pseudo
  tui-demo.i18n.js    demo strings (Korean dictionary)
  fonts/              Bt10x Mono, shared with bt10x.css
```

`npm run dev:web` serves the demo at `/tui-demo.html` (`#ko` or `#pseudo` starts in
another locale). `npm run dist:web` ships only `tui.css` and `tui.js`; the demo stays
out of the deployed site.

```html
<link rel="stylesheet" href="tui.css">
<body class="tui"> … </body>
<script src="tui.js"></script>   <!-- auto-inits on DOMContentLoaded -->
```

## Cells

`tui.js` measures one character cell of the current font (an 80×10 block of `M`) and
publishes it as `--cw` and `--ch` (px) on `:root`. Every component is sized in cells:

```css
width:  calc(var(--cols) * var(--cw));
height: calc(var(--rows) * var(--ch));
```

Line height is `--tui-lh: 1.175em`, JuliaMono's ascent + descent, so vertical box
glyphs touch. Call `TUI.refresh()` after changing `--tui-fs`, `--tui-font` or a border
set; it re-measures and redraws every box (it also runs on `document.fonts.ready` and
window resize). One font size per page is assumed.

### Font size and auto-fit

The page picks `--tui-fs`; the kit can help, but never changes it on its own:

```js
TUI.fontSize()                       // current --tui-fs in px
TUI.setFontSize(16)                  // set --tui-fs on :root and refresh()
TUI.fitFontSize({ container, cols, rows, min, max })
                                     // largest whole px where cols × rows cells fit
                                     // container (the viewport without one)
TUI.autoFit({ container, cols, rows, min, max, onFit })
                                     // switch auto-fit on: re-fit on every resize and font load;
                                     // onFit({ size, fits }), fits = false when even min is too big
TUI.autoFit(false)                   // switch it off (the default); the size stays as it is
```

Auto-fit keeps glyphs as large as the space allows and cancels browser zoom (a zoom
resizes the viewport, so the fit follows). A page with a fixed size (Instant Action:
header A− / A+ / Fit) leaves it off, and browser zoom then scales the page as usual.

## The background inset

A box is four stacked layers:

```
.tui-box             position: relative; cols × rows cells
  .tui-shadow        optional; copy of .tui-bg, offset by --tui-shadow-x/y cells
  .tui-bg            the fill
  .tui-frame         border text, one div per row, pointer-events: none
  .tui-body          content, inset 1 cell (+ --pad cells horizontally)
```

The fill is not on the box itself. `.tui-bg` is absolutely positioned and inset by a
fraction of a cell:

```css
.tui-bg {
  top:    calc(var(--ch) * var(--tui-inset-y));   /* 0.5 */
  bottom: calc(var(--ch) * var(--tui-inset-y));
  left:   calc(var(--cw) * var(--tui-inset-x));   /* 0.5 */
  right:  calc(var(--cw) * var(--tui-inset-x));
}
```

A box-drawing glyph puts its stroke on the centre line of its cell, so at 0.5 the fill
ends under the middle of the border line: the interior and the line are colored and
the half cell outside the line shows the page. Because the inset is computed from the
measured cell, it stays correct when the font or size changes. The demo's
"Background inset" panel overlays the cell grid and lets you try 0, 0.25, 0.5 and 1.

## Border sets

Glyphs come from CSS, not JS, so a set can be added or swapped with CSS alone:

```css
/* 11 glyphs: TL TR BL BR  H V  left-tee right-tee top-tee bottom-tee cross */
[data-border="double"] { --tui-glyphs: "╔╗╚╝═║╠╣╦╩╬"; --tui-sep: "╟─╢"; }
```

`--tui-sep` is the three glyphs of a separator row inside the box. Split dividers add two
more: `--tui-vsep` is where a vertical divider meets the top and bottom border (top tee,
line, bottom tee; `"╤│╧"` in a double box) and `--tui-div` is the divider line set
(`h v left-tee right-tee top-tee bottom-tee cross`, light lines in every built-in set).
Built in: `single`,
`double`, `heavy`, `rounded`, `ascii` (the last defined only in CSS as an example).
Change `data-border` on any box and call `TUI.refresh()` (or `TUI.redraw(el)`).

## Theming

All color goes through tokens, CSS custom properties that inherit down the tree:

| Token | Used for |
|---|---|
| `--tui-page` | screen background (`.tui`) |
| `--tui-fg` | body text |
| `--tui-bright` | emphasized text, box titles |
| `--tui-dim` | muted text, footers, tracks |
| `--tui-accent`, `--tui-accent-ink` | accent color, and text drawn on it |
| `--tui-line` | border glyphs |
| `--tui-surface` | box interior |
| `--tui-surface-2` | raised surfaces: buttons, headers, hover, status bar |
| `--tui-field` | input fields |
| `--tui-sel-bg`, `--tui-sel-fg` | selection (reverse video), active tab |
| `--tui-shadow` | window and popup shadow |
| `--tui-overlay` | dimmed backdrop behind a dialog |
| `--tui-red/yellow/blue/cyan` | status colors (tones, progress) |
| `--tui-red-bg/yellow-bg/blue-bg` | box interior for the `danger`, `warn`, `info` tones |

Built in: `green` (the default, on `:root`), `amber` and `paper` (a light theme).
Theme blocks hold only color tokens. Font, size and cell metrics (`--tui-font`,
`--tui-fs`, `--cw`, `--ch`, insets, scrollbar glyphs) stay on `:root`, so a theme can be
set on any element without changing the layout.

**Page theme.** Put `data-theme` on `<html>` (or any ancestor of the TUI):

```html
<html data-theme="amber">
```

**Per-box theme.** Put `data-theme` on a single box, or pass `theme` in JS and scenes.
The box, everything inside it and nested boxes take that theme, while the rest of the
page keeps its own. `data-theme="green"` returns to the default inside another theme.

```html
<div data-tui="box" data-cols="30" data-title="Log" data-theme="paper">…</div>
```

```js
TUI.box(el, { title: 'Log', theme: 'paper' });
TUI.dialog({ title: 'Eject?', text: '…', buttons: ['Yes', 'No'], theme: 'amber' });
TUI.h.box({ title: 'Log', theme: p.logTheme, border: 'rounded' }, '…');
```

In a scene, a changed `theme` prop only swaps the attribute, with no relayout. Popups
opened from inside a themed box (select, menu, menubar, tooltip) copy that theme, since
they are placed in `<body>` outside the box. A dialog takes its own `theme` option.
Changing `data-theme` by hand needs no `TUI.refresh()`: only colors change, and CSS
repaints them.

**Adding a theme.** A theme is one CSS block, like a border set; no JS change is needed.
Load it after `tui.css`:

```css
[data-theme="ice"] {
  color-scheme: dark;         /* light for a light theme: native scrollbars, inputs */
  --tui-page: #0a0e14;
  --tui-fg: #b4c6d8;
  --tui-bright: #e2ecf6;
  --tui-dim: #4e5f72;
  --tui-accent: #7fc4ff;
  --tui-accent-ink: #0a0e14;
  --tui-line: #5f7d9c;
  --tui-surface: #111822;
  --tui-surface-2: #18222f;
  --tui-field: #142a40;
  --tui-sel-bg: #7fc4ff;
  --tui-sel-fg: #0a0e14;
  --tui-shadow: rgba(0, 0, 0, 0.55);
  --tui-overlay: rgba(4, 6, 10, 0.6);
  --tui-red: #e07a6a;
  --tui-yellow: #d8c26a;
  --tui-blue: #7aa7d8;
  --tui-cyan: #6ac9c0;
  --tui-red-bg: #3a1712;
  --tui-yellow-bg: #383012;
  --tui-blue-bg: #152838;
}
```

Then use it as `data-theme="ice"` or `theme: 'ice'`. Rules for a new theme:

- Use a bare attribute selector, `[data-theme="ice"]`, not `:root[data-theme="ice"]` or
  `html[…]`, or it only works as a page theme.
- Put only color tokens (and `color-scheme`) in it. A theme that sets `--tui-fs`,
  `--tui-font` or `--cw`/`--ch` breaks cell alignment for the boxes inside it.
- Define every token if the theme will be used per box. A token left out is inherited
  from the theme around the box, so a dark theme that skips the status colors would
  pick up `paper`'s light `--tui-red-bg` inside a paper page. A theme only ever used on
  the page can leave tokens out and fall back to `green`.
- Check contrast for `--tui-fg` and `--tui-dim` on `--tui-surface`, `--tui-sel-fg` on
  `--tui-sel-bg`, `--tui-accent-ink` on `--tui-accent`, and each status color on its `-bg`.

**Smaller overrides.** For one box, `--box-bg`, `--box-line` and `--box-title` recolor it
without a whole theme (`style="--box-line: var(--tui-cyan)"`), and
`data-tone="accent|info|warn|danger|clear"` picks a preset from the current theme's
tokens. Tone and theme combine: a `warn` box in `paper` uses paper's yellow.

## Components

Markup with `data-tui="…"` is upgraded automatically. Everything can also be built
from script. All `data-*` options below also exist as JS options in camelCase.

| Component | Markup | Notes |
|---|---|---|
| Box / panel | `<div data-tui="box" data-cols="30" data-rows="6" data-title="Pilot">` | `cols`: number or `auto` (fill parent). `rows`: number or `auto` (fit content, default). `data-border`, `data-tone`, `data-theme`, `data-shadow`, `data-pad` (cells, default 1), `data-title-align`, `data-footer`, `data-footer-right`. |
| Separator | `<div class="tui-sep"></div>` inside a box | Draws `├───┤` joined to the frame. Inside a split pane it joins the dividers on either side. |
| Split | `<div data-tui="split" data-dir="h" data-sizes="24 1fr">` with `<div data-pane data-title="Pilot">` children | One box divided into panes; see [Layout](#layout). |
| Stacks, grid | `data-tui="hstack"`, `"vstack"`, `"grid"`, `"spacer"` | Place children in cell-sized slots; see [Layout](#layout). |
| Window | `<div data-tui="window" data-closable>` | Box with double border, centered title, shadow, `[×]` action. Fires cancelable `tui-close`, then sets `hidden`. |
| Dialog | `await TUI.dialog({ title, text, buttons, cols, border, tone, theme, defaultIndex })` | Modal over a dimmed overlay. Resolves to the button label, or `null` on Esc / `[×]`. Tab is trapped; ← → move between buttons. |
| Button | `<button class="tui-btn">OK</button>` | `[ OK ]`. `data-variant="angle"` gives `< OK >`, `bare` drops brackets, `tight` gives `[OK]`, `field` shows the label in a field-coloured band (a value that opens an editor). `.is-primary`. Pressed = reverse video; focus = `[▸ OK ◂]`. CSS only. |
| Boxed button | `<button data-tui="button" data-border="rounded">Save</button>` | 3-row box around the label. |
| Text input | `<input class="tui-input" style="--cols:24">` | Field-colored band; `data-variant="line"` for an underline. Inside a box it fills the width. `<span class="tui-prompt">&gt; </span>` for a prompt. |
| Checkbox | `<label class="tui-check"><input type="checkbox"><span class="tui-mark"></span><span>Label</span></label>` | `[ ]` `[x]` `[-]`. CSS only, native input kept for a11y. |
| Radio | same with `tui-radio` and `type="radio"` | `( )` `(•)`. |
| Select | `<select data-tui="select" data-cols="20">` | Native select stays as the source of truth (hidden); a cell-sized button (label, then `▼` in the last cell) opens a box-drawn popup; a second click closes it. `change` fires on the select. In a scene, a new `value` prop updates the label in place (focus survives). |
| Menu | `<div data-tui="menu" data-title="File">` with child items, `<hr>` for separators | `data-key` shows a shortcut, `data-value` is reported, `disabled` greys out, `<u>x</u>` is a hotkey letter, `data-no-hover` keeps the pointer from moving the cursor. ↑ ↓ Home End Enter. Fires `tui-select` `{index, value}`. |
| List | `<div data-tui="list" data-selected="0">` | Like menu but with a `▸` cursor and a persistent selection. |
| Menubar | `<nav data-tui="menubar"><div data-label="<u>F</u>ile">items…</div></nav>` | Opens menus as popups; ← → move across menus. `data-right` pushes a menu to the right. Fires `tui-select` `{menu, value}` on the nav. |
| Tabs | `<div data-tui="tabs"><section data-tab="Armor">…</section></div>` | Tab labels sit in the top border; active one in reverse video. ← → on a focused tab. Fires `tui-tab`. |
| Table | `<table data-tui="table">` with `thead th[data-width][data-align]` and `tbody` | Replaced by a box with `┬ ┼ ┴` joints. Or `TUI.table({ columns, rows })`. Body cells merge with `td[colspan]` / `td[rowspan]` (or `{ text, colspan, rowspan, align }` in `rows`); joints and rules close up around them. `tr[data-rule]` draws a rule above that row, `table[data-rules="rows"]` (or `rules: "rows"`) between every row. Row select by click or ↑ ↓; fires `tui-select` `{index, row}`, with `row` the texts of the cells in it, merged ones included. |
| Progress | `<span data-tui="progress" data-cols="30" data-value="0.42">` | `█` with eighth-cell partials (`▏…▉`) over a `░` track and a `%` label (`data-label="none"` hides). `data-style="ascii"`, `data-value="indeterminate"`, `data-tone`. `data-dir="v"` makes it vertical: `data-rows` tall (default 8) and `data-cols` wide (default 1), filled from the bottom with eighth-row partials (`▁…▇`), label centered below. Update with `TUI.progress(el, 0.6)`. |
| Spinner | `<span data-tui="spinner" data-frames="◐◓◑◒">` | Any frame string. Static under reduced motion. |
| Scrollbox | `<div data-tui="scroll" data-rows="10">` | Native scrolling with the browser scrollbars hidden. When content is taller than the box the right border becomes `▲ ░▄█▀░ ▼`, with a thumb that moves in half cells; when it is wider (e.g. `.tui-line` rows), the bottom border becomes a half-height bar `◂ ■■■ ▸` (thumb in accent, track dim). Glyphs come from the CSS vars `--tui-vbar` (default `"▲░█▼▀▄"`; the last two are the upper and lower half thumbs) and `--tui-hbar` (default `"◂▥■▸"`): start arrow, track, thumb, end arrow. Wheel, shift+wheel, thumb drag, arrow and track clicks. |
| Fixed column | `<span class="tui-col" style="--col:8">Walk</span>` | A label column that cuts with `…`. CSS only. |
| Tooltip | `data-tip="text"` on any element (`&#10;` for a line break) | Rounded box sized to the text, on hover and focus. `data-tip-border` picks the set. Placement: `data-tip-at` is the point of the element the tip attaches to, `data-tip-anchor` the point of the tip put there; both take a compass point, `nw` `n` `ne` `w` `e` `sw` `s` `se` (corners and edge midpoints). Defaults `sw` / `nw`: below, left edges aligned. E.g. `e` / `w` puts the tip to the right, centred; `se` / `sw` to the right, bottom edges aligned. An axis that would leave the viewport is mirrored on both points, then the tip is kept inside it. A designated point replaces `data-tip-at`: `data-tip-xy="x,y"` in cells (fractions and negatives allowed) from the top-left of the element `data-tip-from` names (a CSS selector), or of the viewport without it; `data-tip-anchor` still picks the tip point put there. Scene props `tipAt`, `tipAnchor`, `tipXY`, `tipFrom`. |
| Status bar | `<div class="tui-statusbar"><span class="tui-kbd">F1</span><span>Help</span>…</div>` | `.tui-seg` (reverse), `.tui-seg-alt`, `.tui-grow` spacer. CSS only. |

### JS API

```js
TUI.init()                 // runs automatically; measure + upgrade + tooltips
TUI.upgrade(root)          // upgrade [data-tui] added later
TUI.refresh()              // re-measure font, redraw all boxes
TUI.fontSize() / setFontSize(px) / fitFontSize(opts) / autoFit(opts | false)  // see Cells
TUI.hideTip()              // hide the open tooltip
TUI.metrics                // { cw, ch } in px
TUI.box(el?, opts)         // make/upgrade a box; returns the element
TUI.update(el, opts)       // change cols/rows/title/border/... and redraw
TUI.redraw(el)
TUI.window(el, opts)
TUI.dialog(opts)           // Promise<label | null>
TUI.popupMenu(anchor, items, opts)  // Promise<{index} | {nav} | null>
TUI.closePopup()           // close the open popup menu (it resolves to null)
TUI.table({ columns: [{ label, width, align }], rows: [[text | { text, colspan, rowspan, align }]], rules, border })
TUI.progress(el, value)
TUI.glyphs(el)             // the border set an element resolves to
TUI.split(el, { sizes })   // upgrade a split, or change its sizes later
TUI.hstack(el) / vstack(el) / grid(el) / spacer(el)
TUI.h, TUI.prefab, TUI.mount   // scenes, see below
```

`opts.actions = [{ text: '[?]', title, onClick }]` adds clickable labels to a box's top
border (used by window's `[×]`).

## Layout

Every layout size is in cells, so children line up with the grid.

| Component | Markup | Notes |
|---|---|---|
| hstack | `<div data-tui="hstack" data-gap="2">` | Children side by side. `data-gap="x y"` in cells and rows (default `2 0`); `data-wrap` wraps; `data-align="stretch\|center\|end"`. |
| vstack | `<div data-tui="vstack" data-gap="1">` | Children top to bottom, gap in rows (default 0). |
| grid | `<div data-tui="grid" data-columns="24 1fr 1fr">` | CSS grid; a number is cells, anything else (`1fr`, `auto`) passes through. `data-min="46"` instead gives auto-fill columns of at least 46 cells. Gap default `2 1`. |
| spacer | `<span data-tui="spacer"></span>` | Takes the leftover width in an hstack. |

Each child is wrapped in a slot (`.tui-slot`). The child sets its slot with `data-size`
(cells; rows in a vstack), `data-grow` (share of the leftover width) or, in a grid,
`data-span` (columns, or `all`). A box with `cols="auto"` needs a slot with a width: give
it `data-grow` or `data-size` in an hstack (a plain hstack slot shrinks to fit its content).

### Split

```html
<div data-tui="split" data-cols="auto" data-sizes="21 1fr" data-border="double">
  <div data-pane data-title="Pilot">…</div>
  <div data-pane>
    <div data-tui="split" data-dir="v">
      <div data-pane data-title="Weapons">…</div>
      <div data-pane data-title="Heat">…</div>
    </div>
  </div>
</div>
```

```
╔═ Pilot ═══════════╤═ Weapons ═════════════════╗
║ Gunnery  3        │ LRM-20  LT   1            ║
║ Piloting 4        │ SRM-6   LT   2            ║
║ Hits     ■□□□□□   ├─ Heat ────────────────────╢
║                   │ ███▌░░░░░░░░░░░░░  30%    ║
╚═══════════════════╧═══════════════════════════╝
```

A split is a box whose dividers are part of its frame. A split that is the only child of
another split's pane draws no frame of its own; its dividers end in tees on the divider or
border they meet. Any number of panes and any depth of nesting work.

- `data-dir`: `h` (side by side, default) or `v` (stacked).
- `data-sizes`: one token per pane, in cells (`24`), percent (`30%`) or fr (`1fr`, the
  default). Sizes always resolve to whole cells; the remainder goes to the last fr pane.
  In a `v` split, sizes are rows when the split has fixed `data-rows`; with `rows="auto"`
  numbers are fixed rows and fr panes take their content height. `data-at="24"` is short
  for `data-sizes="24 1fr"`.
- Pane options: `data-title` (drawn on the line above the pane, cut with `…` to fit),
  `data-min` (cells, default title width + 4), `data-pad` (cells, default 1). A child that
  is not a pane is wrapped in one.
- Resizing: drag a divider, or Tab to it and use ← → (↑ ↓ in a `v` split), Home and End.
  The split fires `tui-resize` with `{ index, sizes, tokens }`; the kit stores nothing.
  `data-fixed` (scene prop `fixed`) turns resizing off: the dividers are drawn but not
  draggable or focusable.
  `TUI.split(el, { sizes: "30 1fr" })` sets sizes from script.
- The split's top border carries pane titles, so a split takes no `data-title` of its own;
  put it in a window when the screen needs one.

## Scenes and prefabs

A scene is a tree of nodes rendered to the same `data-tui` markup as above. `TUI.h`
builds nodes, `TUI.prefab` registers reusable templates, and `TUI.mount` renders a tree and
returns a handle. Scenes are an in-memory format; they are not meant to be serialized.

```js
const { split, pane, vstack, line, col, table, progress, btn, t } = TUI.h;

TUI.prefab('pilot-card', { gunnery: 4, piloting: 5, hits: 0 }, (p) =>
  vstack(
    line(col(9, t('tab.gunnery', null, 'Gunnery')), String(p.gunnery)),
    line(col(9, t('tab.hits', null, 'Hits')), '■'.repeat(p.hits) + '□'.repeat(6 - p.hits)),
  ));

TUI.prefab('mech-status', {}, (p) =>
  split({ cols: 'auto', sizes: '24 1fr' },
    pane(t('tab.pilot', null, 'Pilot'), TUI.h.use('pilot-card', { hits: p.hits })),
    pane({},
      split({ dir: 'v' },
        pane('Weapons', table({ ref: 'weapons', columns, rows: p.rows })),
        pane('Armor',
          progress({ cols: 30, value: p.armor }),
          btn({ onClick: (e, scene) => scene.update({ armor: 1 }) }, 'Repair'))))));

const scene = TUI.mount(document.getElementById('status'),
  TUI.h.use('mech-status', { hits: 2, armor: 0.8, rows }));
scene.update({ armor: 0.5 });          // patches the progress bar only
scene.refs.weapons.el.focus();
```

**Nodes.** `TUI.h.<type>(props?, ...children)`, or `TUI.h(type, props, ...children)`.
Children are nodes, strings, numbers, arrays or `null`/`false` (skipped). Props common to
every type: `key` (identity in a list), `ref` (name in `scene.refs`), `id`, `class`,
`style` (object), `attrs` (object), `tip`, `tipAt`, `tipAnchor`, `tipXY`, `tipFrom`, `hidden`, event handlers, and the slot props
`size`, `grow`, `span` when the parent is a stack or grid. Shorthands: `tab(label, …)`,
`pane(title, …)`, `col(cells, …)`, `el(tag, props?, …)`.

| Types | Props |
|---|---|
| `box`, `window`, `scroll` | `cols rows title titleAlign footer footerRight border tone theme shadow pad`; window adds `closable` |
| `tabs`, `tab` | tabs: the box props; tab: `label`, `active` |
| `split`, `pane` | split: `dir sizes fixed cols rows border tone theme shadow`; pane: `title min pad` |
| `hstack`, `vstack`, `grid`, `spacer` | `gap wrap align`; grid adds `columns min` |
| `table` | `columns rows rules border selected` (same shapes as `TUI.table`) |
| `menu`, `list` with `item`, `sep` | menu/list: box props, list adds `selected`; item: `value shortcut disabled html` |
| `select` with `option` | select: `cols name value options`; option: `value selected` |
| `progress`, `spinner` | progress: `cols value label tone ascii dir rows`; spinner: `frames` |
| `btn`, `button`, `input`, `check`, `radio` | btn: `primary variant disabled`; button: `border cols`; input: `cols placeholder value variant type name`; check/radio: `checked name value disabled` |
| `line`, `col`, `statusbar`, `kbd`, `seg`, `text`, `p`, `el` | col: `col` (cells); seg: `alt`; el: `tag` |

**Text.** `TUI.h.t(key, vars, fallback)` is a translation key, resolved when the scene
renders. Use it in children and props instead of calling `TUI.t()` so a locale switch
can render the scene again in the new language.

**Events.** `onSelect` (`tui-select`), `onTab`, `onClose`, `onResize`, `onChange`,
`onInput`, `onClick`, `onKeydown`, or `on: { name: fn }` for any event. Handlers get
`(event, scene)`. Kit events (`tui-*`) only reach the node that fired them, not its
ancestors.

**Prefabs.** `TUI.prefab(name, defaults, render)` registers `render(props, children)`,
which returns one node; `props` is `defaults` merged with the instance's props, with
keys already translated. Use one with `TUI.h.use(name, props, ...children)` or
`TUI.h(name, …)`, nest them freely, and make variants by registering another name that
calls the first. `TUI.prefab` also returns a builder for the name. From markup,
`<div data-tui-use="pilot-card" data-hits="2">` mounts a prefab in place of the element
(data attributes become props; numbers and `true`/`false` are converted).

**Scene handle.** `TUI.mount(target, node)` replaces target's content and returns
`{ el, props, refs, update(props), flush(), render(), destroy() }`.

- `scene.update(props)` merges into the root node's props. `scene.refs.name.update(props)`
  merges into the node with `ref: "name"`, and those overrides stay across later
  `scene.update()` calls. Both return a promise; updates in one task are batched into one
  pass. `scene.flush()` applies pending updates now.
- An update renders the tree again and compares it with the last one. A node of the same
  type (and `key`) is kept and only its changed props are applied, so focus, scroll
  position, field text and selection survive. Props a component cannot change in place
  (a table's rows, a menu's items, a split's `dir`) replace that one component.
- A locale switch (`TUI.i18n.set()`) renders every scene again from scratch. Props and
  ref overrides are kept; in-DOM state such as focus is not. A scene whose target sat
  inside an `i18n.mount()` root finds its target again by `id`, so give it one.

## i18n

Goal: translated text may change a component's size, but never break the grid.

**1. Count cells, not characters.** All widths go through `compensatedLength()`,
ported from btlib10x `web/terminal/i18n/index.ts` so the kit and the game terminal
agree: code-unit length plus one extra cell per wide code point (Hangul, CJK,
fullwidth, astral). It drives box sizes, tab strips, table columns, tooltips, popup
menus and boxed buttons. `TUI.compensatedLength(s)` and `TUI.fit(s, cols, align)`
are exported.

**2. Snap wide glyphs to 2-cell slots.** Hangul comes from a fallback font whose
advance and ascent differ from the Latin mono, so letting it flow would shift columns
and grow rows. `tui.js` wraps every wide character in `.tui-w`, an inline-block exactly
`compensatedLength(ch)` cells wide and one row tall, top-aligned. A glyph wider than 2
cells is squeezed with `--tui-wide-scale`, measured at startup. A `MutationObserver`
does this for text added later (including `textContent` set from script). Inputs,
selects and `[data-tui-raw]` subtrees are left alone.

**2b. Prose may be tighter.** Running text (`<p>`, dialog text, `.tui-prose`, or any
`[data-wide="natural"]` subtree) keeps Hangul at the font's natural width, about 1.6 to
1.7 cells, since nothing has to line up there. Rows stay one cell tall. Anything that
must align (borders, tables, menus, `.tui-line`, `.tui-col`) keeps the 2-cell slot,
because a grid column can only be a whole number of cells.

**3. Break between words, not inside them.** A word containing wide characters is
wrapped in a no-wrap `.tui-wrun` (the `word-break: keep-all` behaviour Korean wants).
Inside boxes, `overflow-wrap: anywhere` stops one long token from widening a panel.

**4. When space is fixed, cut on a cell boundary.** Fixed-width slots (box titles,
table cells, select labels, menu labels, `.tui-col`) end with `…`; a wide char is never
split in half (the leftover cell becomes a space). A truncated border title keeps the
full text in its `title` tooltip. `<span class="tui-col" style="--col:8">` is a fixed
label column for aligned rows.

**5. Prefer growth that keeps the grid.** Use `rows="auto"` so boxes grow downward,
`cols="auto"` so they fill their container, and let the kit size buttons, tabs and
tooltips from their translated text.

**6. Test with a stretched locale.** `pseudo` accents the source text and pads it by
~40% (`«Fíré ~~»`), which shows truncation and overflow without a translator.

### Translation layer

```html
<span data-i18n="btn.fire"><u>F</u>ire</span>          <!-- text, or HTML if the value has tags -->
<div data-tui="box" data-title="Pilot" data-i18n-attr="data-title=box.pilot">
<input placeholder="Callsign" data-i18n-attr="placeholder=inp.cs; title=inp.cs.tip">
```

```js
TUI.i18n.add('ko', { 'btn.fire': '사격(<u>F</u>)', 'box.pilot': '파일럿' });
TUI.i18n.mount(document.getElementById('app'));  // before DOMContentLoaded
TUI.i18n.set('ko');                               // before init: start locale; after: switch
TUI.t('out.row', { v: 'Atlas' });                 // script strings, {name} slots
```

The source language lives in the markup, so it needs no dictionary; a missing key
falls back to the markup text. Components are built from the translated markup, so
`set()` after startup rebuilds every mounted root from a pristine copy, re-measures,
and fires `tui-locale` on `<html>`. Page state inside a mounted root is reset by a
switch: bind handlers by delegation and restore state on `tui-locale` (the demo does
this). Hotkeys follow the Korean convention `파일(<u>F</u>)`, so the letter still works.

## Known limits of the draft

- Astral characters (emoji) count 3 cells: `compensatedLength` adds 1 to their 2 UTF-16 units, although its comment says 2. The kit follows the function as written.
- `<input>` and native `<option>` text is not snapped (the browser draws it); fields still keep their cell width.
- A box with fixed `rows` does not clip content that is taller; use `rows="auto"` or a scrollbox.
- `cols="auto"` fills a block parent; inside a shrink-to-fit parent it has nothing to fill.
- Window dragging, focus rings drawn as boxes and a menubar submenu level are not in this draft.
- Split dividers line up only when pane content is whole rows tall (true for text, boxes and every kit component); a pane whose content is a fractional height can shift a horizontal divider by part of a row.
