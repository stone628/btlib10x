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

`--tui-sep` is the three glyphs of a separator row inside the box. Built in: `single`,
`double`, `heavy`, `rounded`, `ascii` (the last defined only in CSS as an example).
Change `data-border` on any box and call `TUI.refresh()` (or `TUI.redraw(el)`).

## Theming

All color goes through tokens on `:root`: `--tui-page`, `--tui-fg`, `--tui-bright`,
`--tui-dim`, `--tui-accent`, `--tui-line`, `--tui-surface`, `--tui-surface-2`,
`--tui-field`, `--tui-sel-bg/fg`, `--tui-shadow`, `--tui-overlay`, plus
`--tui-red/yellow/blue/cyan` and their `-bg`. `data-theme="amber"` and
`data-theme="paper"` on `<html>` are example alternates. Boxes take local overrides
`--box-bg`, `--box-line`, `--box-title`, or `data-tone="accent|info|warn|danger|clear"`.

## Components

Markup with `data-tui="…"` is upgraded automatically. Everything can also be built
from script. All `data-*` options below also exist as JS options in camelCase.

| Component | Markup | Notes |
|---|---|---|
| Box / panel | `<div data-tui="box" data-cols="30" data-rows="6" data-title="Pilot">` | `cols`: number or `auto` (fill parent). `rows`: number or `auto` (fit content, default). `data-border`, `data-tone`, `data-shadow`, `data-pad` (cells, default 1), `data-title-align`, `data-footer`, `data-footer-right`. |
| Separator | `<div class="tui-sep"></div>` inside a box | Draws `├───┤` joined to the frame. |
| Window | `<div data-tui="window" data-closable>` | Box with double border, centered title, shadow, `[×]` action. Fires cancelable `tui-close`, then sets `hidden`. |
| Dialog | `await TUI.dialog({ title, text, buttons, cols, border, tone, defaultIndex })` | Modal over a dimmed overlay. Resolves to the button label, or `null` on Esc / `[×]`. Tab is trapped; ← → move between buttons. |
| Button | `<button class="tui-btn">OK</button>` | `[ OK ]`. `data-variant="angle"` gives `< OK >`, `bare` drops brackets. `.is-primary`. Pressed = reverse video; focus = `[▸ OK ◂]`. CSS only. |
| Boxed button | `<button data-tui="button" data-border="rounded">Save</button>` | 3-row box around the label. |
| Text input | `<input class="tui-input" style="--cols:24">` | Field-colored band; `data-variant="line"` for an underline. Inside a box it fills the width. `<span class="tui-prompt">&gt; </span>` for a prompt. |
| Checkbox | `<label class="tui-check"><input type="checkbox"><span class="tui-mark"></span><span>Label</span></label>` | `[ ]` `[x]` `[-]`. CSS only, native input kept for a11y. |
| Radio | same with `tui-radio` and `type="radio"` | `( )` `(•)`. |
| Select | `<select data-tui="select" data-cols="20">` | Native select stays as the source of truth (hidden); a cell-sized button opens a box-drawn popup. `change` fires on the select. |
| Menu | `<div data-tui="menu" data-title="File">` with child items, `<hr>` for separators | `data-key` shows a shortcut, `data-value` is reported, `disabled` greys out, `<u>x</u>` is a hotkey letter. ↑ ↓ Home End Enter. Fires `tui-select` `{index, value}`. |
| List | `<div data-tui="list" data-selected="0">` | Like menu but with a `▸` cursor and a persistent selection. |
| Menubar | `<nav data-tui="menubar"><div data-label="<u>F</u>ile">items…</div></nav>` | Opens menus as popups; ← → move across menus. `data-right` pushes a menu to the right. Fires `tui-select` `{menu, value}` on the nav. |
| Tabs | `<div data-tui="tabs"><section data-tab="Armor">…</section></div>` | Tab labels sit in the top border; active one in reverse video. ← → on a focused tab. Fires `tui-tab`. |
| Table | `<table data-tui="table">` with `thead th[data-width][data-align]` and `tbody` | Replaced by a box with `┬ ┼ ┴` joints. Or `TUI.table({ columns, rows })`. Body cells merge with `td[colspan]` / `td[rowspan]` (or `{ text, colspan, rowspan, align }` in `rows`); joints and rules close up around them. `tr[data-rule]` draws a rule above that row, `table[data-rules="rows"]` (or `rules: "rows"`) between every row. Row select by click or ↑ ↓; fires `tui-select` `{index, row}`, with `row` the texts of the cells in it, merged ones included. |
| Progress | `<span data-tui="progress" data-cols="30" data-value="0.42">` | `█` with eighth-cell partials (`▏…▉`) over a `░` track and a `%` label (`data-label="none"` hides). `data-style="ascii"`, `data-value="indeterminate"`, `data-tone`. Update with `TUI.progress(el, 0.6)`. |
| Spinner | `<span data-tui="spinner" data-frames="◐◓◑◒">` | Any frame string. Static under reduced motion. |
| Scrollbox | `<div data-tui="scroll" data-rows="10">` | Native scrolling with the browser scrollbars hidden. When content is taller than the box the right border becomes `▲ ░▄█▀░ ▼`, with a thumb that moves in half cells; when it is wider (e.g. `.tui-line` rows), the bottom border becomes a half-height bar `◂ ■■■ ▸` (thumb in accent, track dim). Glyphs come from the CSS vars `--tui-vbar` (default `"▲░█▼▀▄"`; the last two are the upper and lower half thumbs) and `--tui-hbar` (default `"◂▥■▸"`): start arrow, track, thumb, end arrow. Wheel, shift+wheel, thumb drag, arrow and track clicks. |
| Fixed column | `<span class="tui-col" style="--col:8">Walk</span>` | A label column that cuts with `…`. CSS only. |
| Tooltip | `data-tip="text"` on any element (`&#10;` for a line break) | Rounded box sized to the text, on hover and focus. `data-tip-border` picks the set. |
| Status bar | `<div class="tui-statusbar"><span class="tui-kbd">F1</span><span>Help</span>…</div>` | `.tui-seg` (reverse), `.tui-seg-alt`, `.tui-grow` spacer. CSS only. |

### JS API

```js
TUI.init()                 // runs automatically; measure + upgrade + tooltips
TUI.upgrade(root)          // upgrade [data-tui] added later
TUI.refresh()              // re-measure font, redraw all boxes
TUI.metrics                // { cw, ch } in px
TUI.box(el?, opts)         // make/upgrade a box; returns the element
TUI.update(el, opts)       // change cols/rows/title/border/... and redraw
TUI.redraw(el)
TUI.window(el, opts)
TUI.dialog(opts)           // Promise<label | null>
TUI.popupMenu(anchor, items, opts)  // Promise<{index} | {nav} | null>
TUI.table({ columns: [{ label, width, align }], rows: [[text | { text, colspan, rowspan, align }]], rules, border })
TUI.progress(el, value)
TUI.glyphs(el)             // the border set an element resolves to
```

`opts.actions = [{ text: '[?]', title, onClick }]` adds clickable labels to a box's top
border (used by window's `[×]`).

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
- Window dragging, resizable panes, focus rings drawn as boxes and a menubar submenu level are not in this draft.
