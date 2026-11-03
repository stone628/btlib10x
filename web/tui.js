/* tui.js: cell-sized TUI components for plain HTML. No build step.
 *
 * Load tui.css and this file, then either mark elements with data-tui
 * (auto-upgraded on DOMContentLoaded) or build them from script via the
 * TUI global. See README.md for the full API.
 */
((global) => {
  const doc = document;
  const metrics = { cw: 8.4, ch: 16.45 };
  const boxes = new Set(); // every upgraded box, relaid on refresh()
  const animated = new Set(); // spinners and indeterminate bars
  const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const LOWER_EIGHTHS = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];
  const reduceMotion = global.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- helpers

  function div(cls, text) {
    const d = doc.createElement("div");
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function span(cls, text) {
    const s = doc.createElement("span");
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    return s;
  }
  // ---------------------------------------------------------------- cell widths
  //
  // Ported from btlib10x web/terminal/i18n/index.ts so the kit and the game
  // terminal agree on widths: compensatedLength() is the code-unit length plus
  // one extra cell per wide code point (Hangul, CJK, fullwidth, astral).
  // All sizing and truncation counts these cells, never characters.

  function isWideCodePoint(cp) {
    return (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a || // angle brackets
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
      (cp >= 0xfe10 && cp <= 0xfe1f) || // vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
      cp > 0xffff // astral planes
    );
  }
  function compensatedLength(str) {
    let extra = 0;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code <= 0x7f) continue;
      for (const ch of str.slice(i)) {
        const cp = ch.codePointAt(0) || 0;
        if (cp > 0x7f && isWideCodePoint(cp)) extra += 1;
      }
      break;
    }
    return str.length + extra;
  }
  const WIDE_RE = /[ᄀ-ᅟ〈〉⺀-꓏가-힣豈-﫿︐-︟︰-﹯＀-｠￠-￦]|[\u{10000}-\u{10FFFF}]/u;
  function charWidth(ch) {
    return compensatedLength(ch);
  }
  /* Width of a string in cells. */
  function len(s) {
    return compensatedLength(String(s));
  }
  /* Fit s into exactly w cells: pad, or cut at a cell boundary and end with
     '…'. A wide char never gets split; the gap becomes a space. */
  function fit(s, w, align) {
    s = String(s);
    const total = len(s);
    if (total > w) {
      if (w <= 0) return "";
      let out = "",
        n = 0;
      for (const ch of s) {
        const cw = charWidth(ch);
        if (n + cw > w - 1) break;
        out += ch;
        n += cw;
      }
      // No space before the ellipsis: 'cannot …' reads as 'cannot…'.
      const trimmed = out.trimEnd();
      n -= out.length - trimmed.length;
      return `${trimmed}…${" ".repeat(w - 1 - n)}`;
    }
    const padN = w - total;
    if (align === "right") return " ".repeat(padN) + s;
    if (align === "center") return " ".repeat(padN >> 1) + s + " ".repeat(padN - (padN >> 1));
    return s + " ".repeat(padN);
  }

  /* Snap wide characters to the grid. Each wide char becomes an inline-block
     exactly compensatedLength(ch) cells wide (2 for Hangul) and 1 row tall (.tui-w), so a fallback font with a
     different advance or taller ascent cannot shift columns or grow rows.
     Words that contain wide chars are wrapped in a no-wrap run (.tui-wrun) so
     Korean breaks between words, like word-break: keep-all. */
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "TITLE",
    "NOSCRIPT",
  ]);
  function skipText(el) {
    for (; el && el !== doc.body; el = el.parentElement) {
      if (
        SKIP_TAGS.has(el.tagName) ||
        el.classList.contains("tui-w") ||
        el.hasAttribute("data-tui-raw") ||
        el.isContentEditable
      )
        return true;
    }
    return false;
  }
  function wrapTextNode(t) {
    const parent = t.parentNode;
    if (!parent) return;
    const frag = doc.createDocumentFragment();
    for (const part of t.data.split(/(\s+)/)) {
      if (!part) continue;
      if (!WIDE_RE.test(part)) {
        frag.append(part);
        continue;
      }
      const run = span("tui-wrun");
      let buf = "";
      for (const ch of part) {
        if (WIDE_RE.test(ch)) {
          if (buf) {
            run.append(buf);
            buf = "";
          }
          const w = span("tui-w", ch);
          const cells = charWidth(ch);
          if (cells !== 2) w.style.setProperty("--w", cells);
          run.append(w);
        } else {
          buf += ch;
        }
      }
      if (buf) run.append(buf);
      frag.append(run);
    }
    parent.replaceChild(frag, t);
  }
  function wrapWide(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (WIDE_RE.test(root.data) && !skipText(root.parentElement)) wrapTextNode(root);
      return;
    }
    if (root.nodeType !== 1 || skipText(root)) return;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        WIDE_RE.test(n.data) && !skipText(n.parentElement)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    });
    const list = [];
    while (walker.nextNode()) list.push(walker.currentNode);
    list.forEach(wrapTextNode);
  }
  function emit(el, name, detail) {
    return el.dispatchEvent(new CustomEvent(name, { bubbles: true, cancelable: true, detail }));
  }
  function num(v, d) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  }

  // ---------------------------------------------------------------- metrics

  /* Measure one character cell of the current font. 80 x 10 'M's averages
     out sub-pixel rounding. Publishes --cw / --ch on :root. */
  function measure() {
    const p = div("tui-font tui-probe");
    p.textContent = `${"M".repeat(80)}\n`.repeat(10).slice(0, -1);
    doc.body.appendChild(p);
    const r = p.getBoundingClientRect();
    p.remove();
    if (r.width > 0 && r.height > 0) {
      metrics.cw = r.width / 80;
      metrics.ch = r.height / 10;
    }
    // Wide glyphs come from a fallback font. If they are wider than 2 cells,
    // .tui-w squeezes them with scaleX(--tui-wide-scale).
    const q = div("tui-font tui-probe");
    q.textContent = "가".repeat(20);
    doc.body.appendChild(q);
    const ww = q.getBoundingClientRect().width / 20;
    q.remove();
    metrics.wide = ww;
    const s = doc.documentElement.style;
    s.setProperty("--cw", `${metrics.cw}px`);
    s.setProperty("--ch", `${metrics.ch}px`);
    s.setProperty("--tui-wide-scale", ww > 0 ? Math.min(1, (2 * metrics.cw) / ww).toFixed(4) : 1);
    return { ...metrics };
  }

  // ---------------------------------------------------------------- glyphs

  function cssChars(el, prop, n, fallback) {
    let s = getComputedStyle(el).getPropertyValue(prop).trim();
    if (/^(["']).*\1$/.test(s)) s = s.slice(1, -1);
    const a = Array.from(s);
    return a.length >= n ? a : Array.from(fallback);
  }
  /* Border set of an element, read from its --tui-glyphs. */
  function glyphs(el) {
    const a = cssChars(el, "--tui-glyphs", 11, "┌┐└┘─│├┤┬┴┼");
    const sep = cssChars(el, "--tui-sep", 3, a[6] + a[4] + a[7]);
    return {
      tl: a[0],
      tr: a[1],
      bl: a[2],
      br: a[3],
      h: a[4],
      v: a[5],
      lt: a[6],
      rt: a[7],
      tt: a[8],
      bt: a[9],
      x: a[10],
      sepL: sep[0],
      sepH: sep[1],
      sepR: sep[2],
    };
  }

  // ---------------------------------------------------------------- box

  /* Upgrade el (or a new div) into a box:
       .tui-shadow  optional, offset copy of the background
       .tui-bg      background, inset half a cell so it stops at the line
       .tui-frame   border text, one div per row
       .tui-body    content area, inset one cell (+ pad) from the edge
     Options (all also readable from data-* attributes):
       cols, rows       number, or 'auto' (cols: fill parent; rows: fit content)
       border           single | double | heavy | rounded | ascii | any CSS-defined set
       title, titleAlign ('left' | 'center' | 'right')
       footer, footerRight
       actions          [{ text, title, onClick }] drawn at the top right
       tone             accent | warn | danger | info | clear
       theme            green | amber | paper | any CSS-defined theme
       shadow, pad      boolean, cells of inner padding (default 1)
       inset            "<corner> <cols> <rows>" (corner nw | ne | sw | se): a
                        compartment in that corner sharing the box's two edges,
                        its lines and joints drawn in the box's border glyphs
                        (e.g. "ne 8 5"); its inside is a .tui-inset element,
                        styled by the app. Empty or invalid: none. */
  function box(el, opts) {
    if (!(el instanceof Element)) {
      opts = el;
      el = doc.createElement("div");
    }
    opts = opts || {};
    const d = el.dataset;
    if (!el._tui) el._tui = { actions: [], junctions: [], hooks: [] };
    const st = el._tui;
    const pick = (k, dk, def) =>
      opts[k] !== undefined
        ? opts[k]
        : d[dk] !== undefined
          ? d[dk]
          : st[k] !== undefined
            ? st[k]
            : def;
    st.cols = pick("cols", "cols", 20);
    st.rows = pick("rows", "rows", "auto");
    st.title = pick("title", "title", "");
    st.titleAlign = pick("titleAlign", "titleAlign", "left");
    st.footer = pick("footer", "footer", "");
    st.footerRight = pick("footerRight", "footerRight", "");
    st.inset = pick("inset", "inset", "");
    if (opts.actions) st.actions = opts.actions;
    if (opts.border) d.border = opts.border;
    else if (!d.border) d.border = "single";
    if (opts.tone) d.tone = opts.tone;
    if (opts.theme) d.theme = opts.theme;
    const pad = pick("pad", "pad", 1);
    el.style.setProperty("--pad", pad);
    const shadow =
      opts.shadow !== undefined ? opts.shadow : d.shadow !== undefined && d.shadow !== "false";
    el.classList.add("tui-box");

    if (!st.built) {
      st.built = true;
      const inner = div("tui-body-inner");
      while (el.firstChild) inner.appendChild(el.firstChild);
      st.body = div("tui-body");
      st.body.appendChild(inner);
      st.inner = inner;
      st.bg = div("tui-bg");
      st.frame = div("tui-frame");
      el.append(st.bg, st.frame, st.body);
      boxes.add(el);
      if (typeof ResizeObserver !== "undefined") {
        st.ro = new ResizeObserver(() => layout(el));
        st.ro.observe(inner);
      }
    }
    if (shadow && !st.shadow) {
      st.shadow = div("tui-shadow");
      el.prepend(st.shadow);
    }
    if (!shadow && st.shadow) {
      st.shadow.remove();
      st.shadow = null;
    }
    if (st.ro && st.cols === "auto" && el.parentElement && st.observedParent !== el.parentElement) {
      st.ro.observe(el.parentElement);
      st.observedParent = el.parentElement;
    }
    // An update (title, border, ...) may not change the size: redraw anyway.
    if (Object.keys(opts).length) st.drawn = false;
    layout(el);
    return el;
  }

  function parentCols(el) {
    const p = el.parentElement;
    if (!p) return 20;
    const cs = getComputedStyle(p);
    const w = p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return Math.floor(w / metrics.cw + 0.01);
  }

  /* Resolve cols/rows to cells, size the element, redraw the frame. */
  function layout(el) {
    const st = el._tui;
    if (!st?.built) return;
    let c = st.cols === "auto" ? parentCols(el) : num(st.cols, 20);
    c = Math.max(c, 4);
    if (st.minCols) c = Math.max(c, st.minCols);
    // Containers that size their children in cells (split) do it here, before
    // the content height is measured.
    if (st.sizer) st.sizer(c, st.rows === "auto" ? null : Math.max(num(st.rows, 5), 2) - 2);
    let r;
    if (st.rows === "auto") {
      const h = st.inner.offsetHeight;
      r = Math.max(1, Math.ceil(h / metrics.ch - 0.05)) + 2;
    } else {
      r = Math.max(num(st.rows, 5), 2);
    }
    const changed = c !== st.c || r !== st.r;
    st.c = c;
    st.r = r;
    el.style.setProperty("--cols", c);
    el.style.setProperty("--rows", r);
    if (changed || !st.drawn) draw(el);
  }

  /* Build one border row. segs: [{ at, text, cls, attrs, onClick, onKey }],
     placed at cell positions; junctions get the tee glyph (a junction can
     also be { at, ch } with its own glyph). */
  function edgeRow(c, left, fill, right, segs, junctions, tee) {
    const cells = Array(c).fill(fill);
    cells[0] = left;
    cells[c - 1] = right;
    for (const j of junctions) {
      const x = typeof j === "number" ? j : j.at;
      if (x > 0 && x < c - 1) cells[x] = typeof j === "number" ? tee : j.ch;
    }
    const row = div();
    const sorted = segs.filter((s) => s.text).sort((a, b) => a.at - b.at);
    let x = 0;
    for (const s of sorted) {
      if (s.at < x) continue;
      const room = c - 1 - s.at;
      if (room <= 0) continue;
      const cut = len(s.text) > room;
      // A cut label keeps its closing space (' Title… ') and one line glyph
      // before the corner, like a label that fits.
      const text = cut ? `${fit(s.text.trimEnd(), Math.max(1, room - 2)).trimEnd()} ` : s.text;
      if (s.at > x) row.append(cells.slice(x, s.at).join(""));
      const sp = span(s.cls || "", text);
      if (cut) {
        sp.title = s.text.trim();
        sp.classList.add("tui-trunc");
      } // keep full text
      if (s.attrs) for (const k in s.attrs) sp.setAttribute(k, s.attrs[k]);
      if (s.onClick) {
        sp.classList.add("tui-hit");
        sp.addEventListener("click", s.onClick);
      }
      if (s.onKey) sp.addEventListener("keydown", s.onKey);
      if (s.ref) s.ref(sp);
      row.append(sp);
      x = s.at + len(text);
    }
    if (x < c) row.append(cells.slice(x).join(""));
    return row;
  }

  /* Geometry of a box's inset ("<corner> <cols> <rows>", see box()): its
     cells x0..x0+w-1 by y0..y0+h-1, the column of its vertical line (vx) and
     the row of its horizontal one (hy). Null when absent or not fitting. */
  function insetGeom(spec, c, r) {
    const m = /^(n|s)(w|e)\s+(\d+)\s+(\d+)$/.exec(String(spec || "").trim());
    if (!m) return null;
    const w = +m[3],
      h = +m[4];
    if (w < 3 || h < 3 || w > c - 1 || h > r - 1) return null;
    const x0 = m[2] === "e" ? c - w : 0;
    const y0 = m[1] === "s" ? r - h : 0;
    return {
      n: m[1] === "n",
      e: m[2] === "e",
      x0,
      y0,
      w,
      h,
      vx: m[2] === "e" ? x0 : x0 + w - 1,
      hy: m[1] === "n" ? y0 + h - 1 : y0,
    };
  }

  /* Draw an inset's inner lines, its edge joint and its inside element. */
  function drawInset(f, g, ins) {
    const set = (y, x, ch) => {
      const row = f.children[y];
      // edge rows hold labels in spans: only plain middle rows are rewritten
      if (!row || row.children.length) return;
      const t = row.textContent;
      row.textContent = t.slice(0, x) + ch + t.slice(x + 1);
    };
    for (let y = ins.y0 + 1; y < ins.y0 + ins.h - 1; y++) set(y, ins.vx, g.v);
    const corner = ins.n ? (ins.e ? g.bl : g.br) : ins.e ? g.tl : g.tr;
    const line = ins.e
      ? corner + g.h.repeat(ins.w - 2) + g.rt
      : g.lt + g.h.repeat(ins.w - 2) + corner;
    for (let i = 0; i < ins.w; i++) set(ins.hy, ins.x0 + i, line[i]);
    const d = div("tui-inset");
    d.style.left = `calc(${ins.x0 + 1} * var(--cw))`;
    d.style.top = `calc(${ins.y0 + 1} * var(--ch))`;
    d.style.width = `calc(${ins.w - 2} * var(--cw))`;
    d.style.height = `calc(${ins.h - 2} * var(--ch))`;
    f.appendChild(d);
  }

  function draw(el) {
    const st = el._tui;
    const g = glyphs(el);
    const c = st.c,
      r = st.r;
    st.drawn = true;
    st.glyphKey = g.tl + g.h + g.v;

    // Keep keyboard focus on a frame control (tabs) across a redraw.
    const focusIdx = st.frame.contains(doc.activeElement)
      ? Array.from(st.frame.querySelectorAll("[tabindex]")).indexOf(doc.activeElement)
      : -1;

    // Top edge: title or tabs on the left, actions on the right.
    const top = [];
    if (st.tabs) {
      let at = 2;
      st.tabs.forEach((t, i) => {
        const text = ` ${t.label} `;
        top.push({
          at,
          text,
          cls: `tui-tab${i === st.activeTab ? " is-active" : ""}`,
          attrs: { tabindex: i === st.activeTab ? "0" : "-1" },
          onClick: () => st.selectTab(i, true),
          onKey: (e) => st.tabKey(e, i),
        });
        at += len(text) + 1;
      });
    } else if (st.title) {
      // A narrow box keeps the title whole as long as it can: it drops the
      // "─" after the corner ("┌ Turn ┐"), then the leading space
      // ("┌Turn ┐"), then the trailing one ("┌Turn┐"), and only then cuts
      // the title with an ellipsis ("┌Tu…┐").
      const room = c - 2;
      const tl = len(st.title);
      let text = ` ${st.title} `;
      let edge = 2;
      if (tl + 3 > room) {
        edge = 1;
        if (tl + 2 <= room) text = ` ${st.title} `;
        else if (tl + 1 <= room) text = `${st.title} `;
        else if (tl <= room) text = st.title;
        else text = fit(st.title, room);
      }
      const w = len(text);
      const at =
        st.titleAlign === "center"
          ? Math.max(edge, (c - w) >> 1)
          : st.titleAlign === "right"
            ? Math.max(edge, c - 2 - w)
            : edge;
      top.push({ at, text, cls: "tui-title" });
    }
    if (st.extraTop) top.push(...st.extraTop);
    let ax = c - 2;
    for (let i = st.actions.length - 1; i >= 0; i--) {
      const a = st.actions[i];
      ax -= len(a.text);
      top.push({
        at: ax,
        text: a.text,
        cls: "tui-action",
        attrs: { title: a.title || "" },
        onClick: a.onClick,
      });
      ax -= 1;
    }
    const bottom = [];
    if (st.footer) bottom.push({ at: 2, text: ` ${st.footer} `, cls: "tui-foot" });
    if (st.footerRight) {
      const t = ` ${st.footerRight} `;
      bottom.push({ at: Math.max(2, c - 2 - len(t)), text: t, cls: "tui-foot" });
    }

    const f = st.frame;
    f.textContent = "";
    const ins = insetGeom(st.inset, c, r);
    const topJ = ins?.y0 === 0 ? [...st.junctions, { at: ins.vx, ch: g.tt }] : st.junctions;
    f.appendChild(edgeRow(c, g.tl, g.h, g.tr, top, topJ, g.tt));
    const rightV = st.hideRightEdge ? " " : g.v;
    const mid = g.v + " ".repeat(Math.max(0, c - 2)) + rightV;
    for (let i = 1; i < r - 1; i++) f.appendChild(div(null, mid));
    // Joints on the left and right edges: [{ y, side: 'l' | 'r', ch }].
    for (const j of st.edgeJoints || []) {
      const row = f.children[j.y];
      if (!row || j.y <= 0 || j.y >= r - 1) continue;
      const x = j.side === "l" ? 0 : c - 1;
      const t = row.textContent;
      row.textContent = t.slice(0, x) + j.ch + t.slice(x + 1);
    }
    if (r > 1) {
      const botJ = st.bottomJunctions || st.junctions;
      f.appendChild(
        st.hideBottomEdge
          ? div(null, g.bl + " ".repeat(Math.max(0, c - 2)) + g.br)
          : edgeRow(
              c,
              g.bl,
              g.h,
              g.br,
              bottom,
              ins && ins.y0 + ins.h === r ? [...botJ, { at: ins.vx, ch: g.bt }] : botJ,
              g.bt,
            ),
      );
    }
    if (ins) drawInset(f, g, ins);

    // Separator rows inside this box (not inside nested boxes).
    for (const s of st.inner.querySelectorAll(".tui-sep")) {
      if (s.closest(".tui-box") !== el) continue;
      const cells = Array(c).fill(g.sepH);
      cells[0] = g.sepL;
      cells[c - 1] = g.sepR;
      if (s.dataset.joints) for (const x of s.dataset.joints.split(",")) cells[+x] = g.x;
      s.textContent = cells.join("");
    }
    for (const h of st.hooks) h(g, c, r);

    if (focusIdx >= 0) {
      const t = f.querySelectorAll("[tabindex]")[focusIdx];
      if (t) t.focus();
    }
  }

  // ---------------------------------------------------------------- menu / list

  /* Read items from markup: any child element is an item, <hr> or .tui-sep
     is a separator. data-key shows a shortcut, data-value is reported back,
     [disabled] / data-disabled greys it out. */
  function readItems(container) {
    return Array.from(container.children).map((c) => {
      if (c.tagName === "HR" || c.classList.contains("tui-sep")) return { sep: true };
      return {
        html: c.innerHTML,
        key: c.dataset.key || "",
        value: c.dataset.value !== undefined ? c.dataset.value : c.textContent.trim(),
        disabled: c.hasAttribute("disabled") || c.hasAttribute("data-disabled"),
      };
    });
  }

  function renderItems(target, items, kind) {
    target.textContent = "";
    const els = [];
    for (const it of items) {
      if (it.sep) {
        target.appendChild(div("tui-sep"));
        continue;
      }
      const row = div("tui-item");
      if (it.disabled) row.dataset.disabled = "";
      if (kind === "list") row.appendChild(span("tui-cursor", "  "));
      const label = span("tui-item-label");
      if (it.html !== undefined) label.innerHTML = it.html;
      else label.textContent = it.label;
      row.appendChild(label);
      if (it.key) row.appendChild(span("tui-item-key", it.key));
      row._item = it;
      target.appendChild(row);
      els.push(row);
    }
    return els;
  }

  /* Keyboard + pointer behaviour shared by menus, lists and popups. */
  function menuController(el, rows, kind, onPick) {
    let active = -1;
    const ok = (i) => rows[i] && !rows[i].hasAttribute("data-disabled");
    function set(i) {
      active = i;
      rows.forEach((row, k) => {
        row.classList.toggle("is-active", k === i);
        if (kind === "list") {
          row.firstChild.textContent = k === i ? "▸ " : "  ";
        }
      });
    }
    function move(dir, from) {
      let i = from !== undefined ? from : active;
      for (let n = 0; n < rows.length; n++) {
        i = (i + dir + rows.length) % rows.length;
        if (ok(i)) {
          set(i);
          return;
        }
      }
    }
    rows.forEach((row, i) => {
      // [data-no-hover] on the menu: the pointer never moves its cursor
      row.addEventListener("mousemove", () => {
        if (kind !== "list" && !el.hasAttribute("data-no-hover") && ok(i) && active !== i) set(i);
      });
      row.addEventListener("click", () => {
        if (ok(i)) {
          set(i);
          onPick(i);
        }
      });
    });
    el.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "ArrowDown":
          move(1);
          break;
        case "ArrowUp":
          move(-1);
          break;
        case "Home":
          move(1, -1);
          break;
        case "End":
          move(-1, rows.length);
          break;
        case "Enter":
        case " ":
          if (active >= 0) onPick(active);
          break;
        default: {
          // Hotkey: the <u> letter of an item.
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
          const i = rows.findIndex(
            (row, k) =>
              ok(k) && row.querySelector("u")?.textContent?.toLowerCase() === e.key.toLowerCase(),
          );
          if (i < 0) return;
          set(i);
          onPick(i);
        }
      }
      e.preventDefault();
    });
    return {
      set,
      move,
      get active() {
        return active;
      },
    };
  }

  function menu(el) {
    const kind = el.dataset.tui === "list" ? "list" : "menu";
    const items = readItems(el);
    el.textContent = "";
    if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
    box(el);
    const rows = renderItems(el._tui.inner, items, kind);
    const ctl = menuController(el, rows, kind, (i) => {
      emit(el, "tui-select", { index: i, value: rows[i]._item.value, item: rows[i] });
    });
    if (kind === "list") ctl.set(Math.max(0, num(el.dataset.selected, 0)));
    el.addEventListener("focus", () => {
      if (ctl.active < 0) ctl.move(1);
    });
    el._tui.menu = ctl;
    draw(el);
    return el;
  }

  // ---------------------------------------------------------------- popups

  function placeAt(el, x, y, below) {
    const vw = doc.documentElement.clientWidth;
    const w = el.offsetWidth,
      h = el.offsetHeight;
    let left = Math.min(x, vw - w - 4);
    left = Math.max(4, left);
    let top = y;
    const vh = global.innerHeight;
    if (below && y + h > vh && below.top - h > 0) top = below.top - h;
    el.style.left = `${left + global.scrollX}px`;
    el.style.top = `${top + global.scrollY}px`;
  }

  /* Popups live in <body>, outside any themed box, so they copy the theme
     of the element that opened them. */
  function inheritTheme(el, from) {
    const t = from?.closest?.("[data-theme]")?.dataset.theme;
    if (t) el.dataset.theme = t;
  }

  let openPopup = null;
  function closePopup(result) {
    if (openPopup) {
      const p = openPopup;
      openPopup = null;
      p.close(result);
    }
  }

  /* Open a menu box under anchor. Resolves to { index } on pick,
     { nav: -1 | 1 } on Left/Right, or null on dismiss. */
  function popupMenu(anchor, items, opts) {
    opts = opts || {};
    closePopup(null);
    return new Promise((resolve) => {
      const el = div("tui-popup tui-font");
      el.tabIndex = -1;
      inheritTheme(el, anchor);
      doc.body.appendChild(el);
      const longest = items.reduce(
        (m, it) =>
          Math.max(
            m,
            it.sep ? 0 : len(it.label || stripTags(it.html)) + (it.key ? len(it.key) + 2 : 0),
          ),
        0,
      );
      const pad = opts.pad !== undefined ? opts.pad : 1;
      box(el, {
        cols: Math.max(opts.cols || 0, longest + 2 + pad * 2),
        rows: "auto",
        border: opts.border || "single",
        shadow: true,
        pad,
      });
      const rows = renderItems(el._tui.inner, items, "menu");
      draw(el);
      const r = anchor.getBoundingClientRect();
      placeAt(el, r.left + (opts.dx || 0), r.bottom, r);
      function finish(v) {
        doc.removeEventListener("mousedown", outside, true);
        el.remove();
        if (openPopup && openPopup.el === el) openPopup = null;
        resolve(v);
      }
      const ctl = menuController(el, rows, "menu", (i) => finish({ index: i }));
      if (opts.active >= 0 && rows[opts.active]) ctl.set(opts.active);
      else ctl.move(1);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          finish(null);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          finish({ nav: -1 });
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          finish({ nav: 1 });
        }
      });
      function outside(e) {
        if (!el.contains(e.target) && !anchor.contains(e.target)) finish(null);
      }
      doc.addEventListener("mousedown", outside, true);
      openPopup = { el, close: finish };
      el.focus();
    });
  }
  function stripTags(html) {
    const t = doc.createElement("template");
    t.innerHTML = html || "";
    return t.content.textContent;
  }

  // ---------------------------------------------------------------- select

  function select(sel) {
    const cols = num(sel.dataset.cols, 20);
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "tui-select";
    btn.style.setProperty("--cols", cols);
    if (sel.id) btn.id = `${sel.id}-tui`;
    const label = span("tui-select-label");
    btn.append(label, span("tui-select-arrow", "▼"));
    sel.classList.add("tui-native");
    sel.after(btn);
    const sync = () => {
      label.textContent = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : "";
    };
    sync();
    sel.addEventListener("change", sync);
    async function open() {
      if (btn.classList.contains("is-open")) return closePopup(null);
      btn.classList.add("is-open");
      const items = Array.from(sel.options).map((o) => ({
        label: o.text,
        value: o.value,
        disabled: o.disabled,
      }));
      const res = await popupMenu(btn, items, {
        cols: cols + 2,
        pad: 0,
        active: sel.selectedIndex,
        dx: -metrics.cw,
        border: sel.dataset.border,
      });
      btn.classList.remove("is-open");
      if (res && res.index !== undefined && res.index !== sel.selectedIndex) {
        sel.selectedIndex = res.index;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      btn.focus();
    }
    btn.addEventListener("click", open);
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        open();
      }
    });
    sel._tuiButton = btn;
    return btn;
  }

  // ---------------------------------------------------------------- menubar

  /* <nav data-tui="menubar"><div data-label="File">items…</div>…</nav> */
  function menubar(bar) {
    const menus = Array.from(bar.children).map((m) => ({
      label: m.dataset.label || "",
      items: readItems(m),
      right: m.hasAttribute("data-right"),
    }));
    bar.textContent = "";
    bar.classList.add("tui-menubar");
    const buttons = [];
    menus.forEach((m, i) => {
      if (m.right && !bar.querySelector(".tui-menubar-spacer"))
        bar.appendChild(div("tui-menubar-spacer"));
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "tui-menubar-item";
      b.innerHTML = m.label;
      b.addEventListener("click", () => open(i));
      b.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          open(i);
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          buttons[(i + 1) % buttons.length].focus();
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          buttons[(i - 1 + buttons.length) % buttons.length].focus();
        }
      });
      bar.appendChild(b);
      buttons.push(b);
    });
    let current = -1;
    async function open(i) {
      if (current === i) {
        closePopup(null);
        return;
      }
      current = i;
      buttons.forEach((b, k) => {
        b.classList.toggle("is-open", k === i);
      });
      const res = await popupMenu(buttons[i], menus[i].items, { dx: -metrics.cw });
      if (current !== i) return; // replaced by another open()
      current = -1;
      buttons[i].classList.remove("is-open");
      if (!res) {
        buttons[i].focus();
        return;
      }
      if (res.nav) {
        open((i + res.nav + menus.length) % menus.length);
        return;
      }
      const it = menus[i].items[res.index];
      buttons[i].focus();
      emit(bar, "tui-select", {
        menu: stripTags(menus[i].label),
        value: it.value,
        index: res.index,
      });
    }
    return bar;
  }

  // ---------------------------------------------------------------- tabs

  /* <div data-tui="tabs"><section data-tab="General">…</section>…</div> */
  function tabs(el) {
    const panes = Array.from(el.children).filter((c) => c.dataset.tab !== undefined);
    box(el);
    const st = el._tui;
    st.tabs = panes.map((p) => ({ label: p.dataset.tab, pane: p }));
    st.activeTab = Math.max(
      0,
      panes.findIndex((p) => p.hasAttribute("data-active")),
    );
    panes.forEach((p, i) => {
      p.hidden = i !== st.activeTab;
    });
    st.selectTab = (i, focus) => {
      st.activeTab = i;
      panes.forEach((p, k) => {
        p.hidden = k !== i;
      });
      st.frame.querySelectorAll(".tui-tab").forEach((t, k) => {
        t.classList.toggle("is-active", k === i);
        t.setAttribute("tabindex", k === i ? "0" : "-1");
        if (k === i && focus) t.focus();
      });
      emit(el, "tui-tab", { index: i, label: st.tabs[i].label });
    };
    st.tabKey = (e, i) => {
      const n = st.tabs.length;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        st.selectTab((i + 1) % n, true);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        st.selectTab((i - 1 + n) % n, true);
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        st.selectTab(i, true);
      }
    };
    // The tab strip needs room: grow the box if the labels do not fit.
    st.minCols = st.tabs.reduce((m, t) => m + len(t.label) + 3, 4);
    draw(el);
    layout(el);
    return el;
  }

  // ---------------------------------------------------------------- table

  /* From a <table> (thead th / tbody td; th[data-width], th[data-align])
     or from TUI.table({ columns: [{ label, width, align }], rows: [[…]] }).
     Body cells merge with td[colspan] / td[rowspan], or { text, colspan,
     rowspan, align } in rows. Rules between data rows: tr[data-rule] (above
     that row), table[data-rules="rows"], or opts.rules = "rows" | [index…]. */
  function table(src, opts) {
    let columns, rows, el, rules;
    if (src instanceof Element) {
      const ths = Array.from(src.querySelectorAll("thead th"));
      columns = ths.map((th) => ({
        label: th.textContent.trim(),
        width: th.dataset.width && +th.dataset.width,
        align: th.dataset.align,
      }));
      const trs = Array.from(src.querySelectorAll("tbody tr"));
      rows = trs.map((tr) =>
        Array.from(tr.children).map((td) => {
          const text = td.textContent.trim();
          if (td.colSpan <= 1 && td.rowSpan <= 1 && !td.dataset.align) return text;
          return { text, colspan: td.colSpan, rowspan: td.rowSpan, align: td.dataset.align };
        }),
      );
      rules =
        src.dataset.rules === "rows"
          ? "rows"
          : trs.flatMap((tr, i) => (tr.hasAttribute("data-rule") ? [i] : []));
      el = div();
      for (const a of src.attributes) if (a.name !== "data-tui") el.setAttribute(a.name, a.value);
      src.replaceWith(el);
    } else {
      opts = src || {};
      columns = opts.columns;
      rows = opts.rows;
      rules = opts.rules;
      el = div();
      if (opts.border) el.dataset.border = opts.border;
    }
    const n = columns.length;

    // Place cells on a grid, as HTML does: owner[i][k] is the cell covering
    // data row i, column k (or undefined where a row is short).
    const owner = rows.map(() => Array(n));
    const cells = [];
    rows.forEach((row, i) => {
      let k = 0;
      for (const raw of row) {
        while (k < n && owner[i][k]) k++;
        if (k >= n) break;
        const o = raw !== null && typeof raw === "object" ? raw : { text: raw };
        const cell = {
          text: String(o.text ?? ""),
          align: o.align,
          r0: i,
          k0: k,
          cs: Math.min(Math.max(1, o.colspan || 1), n - k),
          rs: Math.min(Math.max(1, o.rowspan || 1), rows.length - i),
        };
        for (let y = i; y < i + cell.rs; y++)
          for (let x = k; x < k + cell.cs; x++) if (!owner[y][x]) owner[y][x] = cell;
        cells.push(cell);
        k += cell.cs;
      }
    });

    // Column widths: single cells first, then widen the last column of a
    // merged cell that does not fit its span (' text ' plus the joints inside).
    const spanWidth = (k0, cs) => {
      let w = 3 * (cs - 1);
      for (let k = k0; k < k0 + cs; k++) w += columns[k].width;
      return w;
    };
    columns.forEach((c, k) => {
      if (c.width) c.fixed = true;
      else
        c.width = Math.max(
          len(c.label),
          ...cells.filter((x) => x.k0 === k && x.cs === 1).map((x) => len(x.text)),
        );
    });
    for (const x of cells) {
      const last = columns[x.k0 + x.cs - 1];
      const short = len(x.text) - spanWidth(x.k0, x.cs);
      if (x.cs > 1 && short > 0 && !last.fixed) last.width += short;
    }
    // Interior width: each column is ' text ' plus one separator between.
    const inner = columns.reduce((s, c) => s + c.width + 2, 0) + n - 1;
    const joints = []; // frame cell of the joint left of column k (k ≥ 1)
    const starts = [1]; // frame cell where column k starts
    let x = 0;
    columns.forEach((c, k) => {
      x += c.width + 2;
      if (k < n - 1) {
        joints.push(x + 1);
        x += 1;
        starts.push(x + 1);
      }
    });
    // A joint shows in a row where the cells either side differ.
    const split = (i, b) => i < 0 || !owner[i][b] || owner[i][b] !== owner[i][b - 1];
    const ruleSet = new Set(
      rules === "rows" ? rows.map((_, i) => i).slice(1) : Array.isArray(rules) ? rules : [],
    );
    ruleSet.delete(0);

    el.classList.add("tui-table");
    el.tabIndex = 0;
    el.textContent = "";
    box(el, { cols: inner + 2, rows: "auto", pad: 0 });
    const st = el._tui;
    st.junctions = joints;
    st.bottomJunctions = joints.filter((_, b) => split(rows.length - 1, b + 1));
    const head = div("tui-row is-head");
    const ruleRows = []; // [div, row above (-1 = header), row below]
    const dataRows = [];
    st.inner.append(head);
    rows.forEach((_, i) => {
      if (i === 0 || ruleSet.has(i)) {
        const d = div("tui-sep");
        ruleRows.push([d, i - 1, i]);
        st.inner.append(d);
      }
      const d = div("tui-row is-data");
      dataRows.push(d);
      st.inner.append(d);
    });

    function fillRow(row, i, v) {
      row.textContent = "";
      for (let k = 0; k < n; ) {
        const cell = i < 0 ? { text: columns[k].label, k0: k, cs: 1, r0: i } : owner[i][k];
        const cs = cell ? cell.cs - (k - cell.k0) : 1;
        const text = cell && cell.r0 === i ? cell.text : "";
        if (k) row.appendChild(span("tui-col-sep", v));
        const align = cell?.align || (cs === 1 ? columns[k].align : undefined);
        row.append(` ${fit(text, spanWidth(k, cs), align)} `);
        k += cs;
      }
    }
    // Arms of each joint: up/down from the rows' joints, left/right from the
    // rule running over the columns either side.
    const JOIN = { 1111: "x", 1101: "tt", 1110: "bt", "0111": "lt", 1011: "rt", 1100: "h" };
    function fillRule(d, a, b, g) {
      const along = (k) => a < 0 || !owner[a][k] || owner[a][k] !== owner[b][k];
      const out = Array(inner + 2).fill(" ");
      out[0] = along(0) ? g.sepL : g.v;
      out[inner + 1] = along(n - 1) ? g.sepR : g.v;
      columns.forEach((c, k) => {
        if (along(k)) out.fill(g.sepH, starts[k], starts[k] + c.width + 2);
      });
      joints.forEach((at, j) => {
        const key = `${+along(j)}${+along(j + 1)}${+split(a, j + 1)}${+split(b, j + 1)}`;
        const corner = { 1001: g.tr, "0101": g.tl, 1010: g.br, "0110": g.bl, "0011": g.v };
        const name = JOIN[key];
        out[at] = name === "h" ? g.sepH : name ? g[name] : corner[key] || " ";
      });
      d.textContent = out.join("");
    }
    st.hooks.push((g) => {
      fillRow(head, -1, g.v);
      dataRows.forEach((row, i) => {
        fillRow(row, i, g.v);
      });
      for (const [d, a, b] of ruleRows) fillRule(d, a, b, g);
    });

    // Reported row: the text of each distinct cell in it, merged ones included.
    const rowText = (i) => [...new Set(owner[i].filter(Boolean))].map((c) => c.text);
    let active = -1;
    function set(i) {
      active = i;
      dataRows.forEach((r, k) => {
        r.classList.toggle("is-active", k === i);
      });
    }
    dataRows.forEach((r, i) => {
      r.addEventListener("click", () => {
        set(i);
        emit(el, "tui-select", { index: i, row: rowText(i) });
      });
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") set(Math.min(rows.length - 1, active + 1));
      else if (e.key === "ArrowUp") set(Math.max(0, active - 1));
      else if (e.key === "Enter" && active >= 0)
        emit(el, "tui-select", { index: active, row: rowText(active) });
      else return;
      e.preventDefault();
    });
    st.selectRow = set;
    draw(el);
    return el;
  }

  // ---------------------------------------------------------------- progress / spinner

  function progress(el, value) {
    el.classList.add("tui-progress");
    if (value !== undefined) el.dataset.value = value;
    if (el.dataset.dir === "v") return vprogress(el);
    el.classList.remove("is-vertical");
    const v = el.dataset.value;
    const cols = num(el.dataset.cols, 20);
    if (v === "indeterminate") {
      el._tuiTick = 0;
      animated.add(el);
      tickProgress(el);
      return el;
    }
    animated.delete(el);
    const p = Math.min(1, Math.max(0, num(v, 0)));
    const label =
      el.dataset.label === "none" ? "" : ` ${fit(`${Math.round(p * 100)}%`, 4, "right")}`;
    const w = cols - len(label);
    const ascii = el.dataset.style === "ascii";
    const cells = p * w;
    let full = Math.floor(cells);
    const part = ascii ? "" : EIGHTHS[Math.floor((cells - full) * 8)];
    if (ascii && cells - full >= 0.5) full += 1;
    const rest = w - full - len(part);
    el.textContent = "";
    el.append(span("tui-fill", (ascii ? "#" : "█").repeat(full)));
    if (part) el.append(partialCell("░", part));
    el.append(span("tui-track", (ascii ? "-" : "░").repeat(Math.max(0, rest))));
    if (label) el.append(span("tui-pct", label));
    return el;
  }
  /* A cell that is partly filled: the track glyph, with the partial block
     drawn over it so the unfilled part of the cell shows the track too. */
  function partialCell(track, part, n = 1) {
    const c = span("tui-track tui-partial", track.repeat(n));
    c.append(span("tui-fill", part.repeat(n)));
    return c;
  }
  /* Vertical bar: rows tall, cols wide, filled from the bottom with
     eighth-row partials (▁…▇) over a ░ track; the % label sits below. */
  function vprogress(el) {
    el.classList.add("is-vertical");
    const v = el.dataset.value;
    const rows = Math.max(1, num(el.dataset.rows, 8));
    const cols = Math.max(1, num(el.dataset.cols, 1));
    const ascii = el.dataset.style === "ascii";
    const track = ascii ? "." : "░";
    const indet = v === "indeterminate";
    let p = 0;
    if (indet) {
      if (!animated.has(el)) el._tuiTick = 0;
      animated.add(el);
    } else {
      animated.delete(el);
      p = Math.min(1, Math.max(0, num(v, 0)));
    }
    const label = indet || el.dataset.label === "none" ? "" : `${Math.round(p * 100)}%`;
    const w = Math.max(cols, len(label));
    const lpad = (w - cols) >> 1;
    // Row k counted from the bottom: full, partial, or track.
    let glyph;
    if (indet) {
      const block = Math.max(1, Math.min(rows - 1, Math.round(rows / 4)));
      const travel = rows - block;
      const t = el._tuiTick % Math.max(1, travel * 2);
      const pos = t < travel ? t : travel * 2 - t;
      glyph = (k) => (k >= pos && k < pos + block ? "█" : "");
    } else {
      const cells = p * rows;
      const full = ascii ? Math.round(cells) : Math.floor(cells);
      const part = ascii ? "" : LOWER_EIGHTHS[Math.floor((cells - full) * 8)];
      glyph = (k) => (k < full ? (ascii ? "#" : "█") : k === full ? part : "");
    }
    el.textContent = "";
    for (let i = rows - 1; i >= 0; i--) {
      const g = glyph(i);
      const row = div("tui-vrow");
      if (lpad) row.append(" ".repeat(lpad));
      if (!g) row.append(span("tui-track", track.repeat(cols)));
      else if (LOWER_EIGHTHS.includes(g)) row.append(partialCell(track, g, cols));
      else row.append(span("tui-fill", g.repeat(cols)));
      if (w - cols - lpad) row.append(" ".repeat(w - cols - lpad));
      el.appendChild(row);
    }
    if (label) el.appendChild(div("tui-vrow tui-pct", fit(label, w, "center")));
    return el;
  }
  function tickProgress(el) {
    if (el.dataset.dir === "v") {
      el._tuiTick++;
      return vprogress(el);
    }
    const cols = num(el.dataset.cols, 20);
    const block = 4;
    const span2 = cols - block;
    const t = el._tuiTick++ % (span2 * 2);
    const pos = t < span2 ? t : span2 * 2 - t;
    el.textContent = "";
    el.append(
      span("tui-track", "░".repeat(pos)),
      span("tui-fill", "█".repeat(block)),
      span("tui-track", "░".repeat(cols - block - pos)),
    );
  }
  function spinner(el) {
    el.classList.add("tui-spinner");
    el._tuiFrames = Array.from(el.dataset.frames || "◐◓◑◒");
    el._tuiTick = 0;
    el.textContent = el._tuiFrames[0];
    animated.add(el);
    return el;
  }
  if (!reduceMotion) {
    setInterval(() => {
      for (const el of animated) {
        if (!el.isConnected) {
          animated.delete(el);
          continue;
        }
        if (el._tuiFrames) el.textContent = el._tuiFrames[++el._tuiTick % el._tuiFrames.length];
        else tickProgress(el);
      }
    }, 110);
  }

  // ---------------------------------------------------------------- scrollbox

  /* A box whose right border becomes a scrollbar (▲ ░░█░░ ▼) when content is
     taller than the box, and whose bottom border does (◀ ░░█░░ ▶) when it is wider. */
  function scroll(el) {
    box(el);
    const st = el._tui;
    el.classList.add("tui-scroll");
    const vbar = div("tui-scrollbar");
    const hbar = div("tui-hscrollbar");
    el.append(vbar, hbar);
    const body = st.body;
    const geom = { x: null, y: null };

    /* Thumb size and position on one axis, or null when it does not overflow.
       The track is the border minus its two corners and two arrows. */
    function axisGeom(axis) {
      const v = axis === "y";
      const track = (v ? st.r : st.c) - 4;
      const client = v ? body.clientHeight : body.clientWidth;
      const total = v ? body.scrollHeight : body.scrollWidth;
      const over = total - client;
      if (!(over > 1 && track >= 1)) return null;
      // The vertical thumb moves in half cells; pos and size are in sub-cells.
      const sub = v ? 2 : 1;
      const n = track * sub;
      const size = Math.max(sub, Math.round((n * client) / total));
      const pos = Math.round(((n - size) * (v ? body.scrollTop : body.scrollLeft)) / over);
      return { track, sub, size, pos, over, client };
    }
    /* Glyphs come from CSS: --tui-vbar / --tui-hbar = start arrow, track,
       thumb, end arrow; --tui-vbar adds the upper and lower half thumbs drawn
       over the track where the thumb covers half a cell. */
    function cells(bar, g, tag, prop, fallback) {
      const [first, trackCh, thumbCh, last, upper = "▀", lower = "▄"] = cssChars(
        el,
        prop,
        4,
        fallback,
      );
      const on = (k) => k >= g.pos && k < g.pos + g.size;
      bar.append(tag("tui-arrow", first));
      for (let i = 0; i < g.track; i++) {
        const top = on(i * g.sub);
        const bottom = on(i * g.sub + g.sub - 1);
        if (top && bottom) bar.append(tag("tui-thumb", thumbCh));
        else if (!top && !bottom) bar.append(tag("tui-trackcell", trackCh));
        else {
          const c = tag("tui-trackcell", trackCh);
          c.append(tag("tui-thumb tui-half", top ? upper : lower));
          bar.append(c);
        }
      }
      bar.append(tag("tui-arrow", last));
    }
    function render() {
      geom.y = axisGeom("y");
      geom.x = axisGeom("x");
      // The scrollbars replace the right and bottom border lines.
      if (!!geom.y !== !!st.hideRightEdge || !!geom.x !== !!st.hideBottomEdge) {
        st.hideRightEdge = !!geom.y;
        st.hideBottomEdge = !!geom.x;
        draw(el);
      }
      vbar.textContent = "";
      hbar.textContent = "";
      if (geom.y) cells(vbar, geom.y, div, "--tui-vbar", "▲░█▼▀▄");
      if (geom.x) cells(hbar, geom.x, span, "--tui-hbar", "◂▀▀▸");
    }
    body.addEventListener("scroll", render, { passive: true });
    st.hooks.push(() => requestAnimationFrame(render));
    if (st.ro) st.ro.observe(body);

    /* Arrow: one cell. Track: one page. Thumb: drag. */
    function onBar(bar, axis) {
      bar.addEventListener("pointerdown", (e) => {
        const g = geom[axis];
        if (!g) return;
        const v = axis === "y";
        const unit = v ? metrics.ch : metrics.cw;
        const r = bar.getBoundingClientRect();
        const at = (v ? e.clientY - r.top : e.clientX - r.left) + 0.01;
        const i = Math.floor(at / unit);
        const k = Math.floor((at * g.sub) / unit) - g.sub; // sub-cell in the track
        const by = (d) => body.scrollBy(v ? 0 : d, v ? d : 0);
        if (i === 0) by(-unit);
        else if (i === g.track + 1) by(unit);
        else if (k < g.pos) by(-g.client + unit);
        else if (k >= g.pos + g.size) by(g.client - unit);
        else {
          e.preventDefault();
          bar.setPointerCapture(e.pointerId);
          const p0 = v ? e.clientY : e.clientX;
          const s0 = v ? body.scrollTop : body.scrollLeft;
          const per = g.over / Math.max(1, ((g.track * g.sub - g.size) * unit) / g.sub);
          const move = (ev) => {
            const s = s0 + ((v ? ev.clientY : ev.clientX) - p0) * per;
            if (v) body.scrollTop = s;
            else body.scrollLeft = s;
          };
          const up = () => {
            bar.removeEventListener("pointermove", move);
            bar.removeEventListener("pointerup", up);
          };
          bar.addEventListener("pointermove", move);
          bar.addEventListener("pointerup", up);
        }
      });
    }
    onBar(vbar, "y");
    onBar(hbar, "x");
    render();
    return el;
  }

  // ---------------------------------------------------------------- window / dialog

  function windowBox(el, opts) {
    opts = opts || {};
    el.classList.add("tui-window");
    const closable = opts.closable !== undefined ? opts.closable : el.hasAttribute("data-closable");
    box(el, {
      border: el.dataset.border || opts.border || "double",
      shadow: el.dataset.shadow !== "false",
      titleAlign: el.dataset.titleAlign || "center",
      actions: closable
        ? [
            {
              text: "[×]",
              title: "Close",
              onClick: () => {
                if (emit(el, "tui-close")) el.hidden = true;
              },
            },
          ]
        : undefined,
      ...opts,
    });
    return el;
  }

  /* TUI.dialog({ title, text | content, buttons, cols, border, tone, theme, defaultIndex })
     Resolves to the clicked button's label, or null on Escape. */
  function dialog(opts) {
    opts = opts || {};
    const buttons = opts.buttons || ["OK"];
    return new Promise((resolve) => {
      const prevFocus = doc.activeElement;
      const overlay = div("tui-overlay tui-font");
      if (opts.theme) overlay.dataset.theme = opts.theme;
      const win = div("tui-dialog");
      const text = div("tui-dialog-text");
      if (opts.content instanceof Node) text.appendChild(opts.content);
      else text.textContent = opts.text || "";
      const actions = div("tui-dialog-actions");
      const btnEls = buttons.map((b, i) => {
        const e = doc.createElement("button");
        e.type = "button";
        e.className = `tui-btn${i === (opts.defaultIndex || 0) ? " is-primary" : ""}`;
        e.textContent = b;
        e.addEventListener("click", () => finish(b));
        return e;
      });
      actions.append(...btnEls);
      win.append(text, div("tui-line"), actions);
      overlay.appendChild(win);
      doc.body.appendChild(overlay);
      const maxCols = Math.floor((doc.documentElement.clientWidth - 2 * metrics.cw) / metrics.cw);
      windowBox(win, {
        title: opts.title || "",
        cols: Math.min(opts.cols || 44, maxCols),
        rows: "auto",
        border: opts.border || "double",
        tone: opts.tone,
        pad: 2,
        closable: opts.closable !== false,
      });
      win.addEventListener("tui-close", (e) => {
        e.preventDefault();
        finish(null);
      });
      function finish(v) {
        overlay.remove();
        doc.removeEventListener("keydown", onKey, true);
        if (prevFocus?.focus) prevFocus.focus();
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
          return;
        }
        const focusables = Array.from(
          win.querySelectorAll('button, input, select, [tabindex="0"]'),
        ).filter((x) => !x.disabled && x.offsetParent);
        const i = focusables.indexOf(doc.activeElement);
        if (e.key === "Tab") {
          e.preventDefault();
          const n = focusables.length;
          focusables[(i + (e.shiftKey ? -1 : 1) + n) % n].focus();
        } else if (
          (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
          btnEls.includes(doc.activeElement)
        ) {
          e.preventDefault();
          const k = btnEls.indexOf(doc.activeElement) + (e.key === "ArrowRight" ? 1 : -1);
          btnEls[(k + btnEls.length) % btnEls.length].focus();
        }
      }
      doc.addEventListener("keydown", onKey, true);
      btnEls[opts.defaultIndex || 0].focus();
    });
  }

  // ---------------------------------------------------------------- tooltip

  let tipEl = null;
  function showTip(target) {
    hideTip();
    const lines = target.dataset.tip.split("\n");
    const w = Math.max(...lines.map(len));
    tipEl = div("tui-popup tui-font tui-tip");
    inheritTheme(tipEl, target);
    // data-tip-runs: the same text as styled runs, JSON [[text, class], …]
    const runs = parseRuns(target.dataset.tipRuns);
    if (runs) {
      for (const [text, cls] of runs) {
        const s = doc.createElement("span");
        if (cls) s.className = cls;
        s.textContent = text;
        tipEl.appendChild(s);
      }
    } else tipEl.textContent = lines.join("\n");
    doc.body.appendChild(tipEl);
    box(tipEl, {
      cols: w + 4,
      rows: lines.length + 2,
      border: target.dataset.tipBorder || "rounded",
    });
    placeTip(tipEl, target);
  }

  function parseRuns(json) {
    if (!json) return null;
    try {
      const runs = JSON.parse(json);
      return Array.isArray(runs) ? runs : null;
    } catch {
      return null;
    }
  }

  /* Compass points of a rectangle as fractions of its width and height:
     corners nw ne sw se, edge midpoints n e s w. */
  const TIP_POINTS = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    w: [0, 0.5],
    e: [1, 0.5],
    sw: [0, 1],
    s: [0.5, 1],
    se: [1, 1],
  };
  const tipPoint = (v, fallback) => TIP_POINTS[String(v || "").trim()] || TIP_POINTS[fallback];

  /* A designated tip point: data-tip-xy="x,y" in cells (fractions and
     negatives allowed) from the top-left of the element data-tip-from names
     (a CSS selector), or of the viewport without it. Returned as a zero-size
     rect, so the at point is the coordinate itself. Null when unset or the
     origin element is missing. */
  function tipXY(target) {
    const xy = String(target.dataset.tipXy || "")
      .split(",")
      .map((t) => Number.parseFloat(t));
    if (xy.length !== 2 || xy.some((n) => !Number.isFinite(n))) return null;
    let ox = 0;
    let oy = 0;
    const from = target.dataset.tipFrom;
    if (from) {
      const o = doc.querySelector(from);
      if (!o) return null;
      const r = o.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
    }
    const x = ox + xy[0] * metrics.cw;
    const y = oy + xy[1] * metrics.ch;
    return { left: x, top: y, width: 0, height: 0 };
  }

  /* Put the tip's data-tip-anchor point (default nw) on the target's
     data-tip-at point (default sw: under the target, left edges aligned),
     or on the data-tip-xy coordinate when one is set. An axis that would
     leave the viewport is mirrored on both points (e.g. at e / anchor w
     becomes at w / anchor e), then the tip is kept inside the viewport. */
  function placeTip(el, target) {
    const r = tipXY(target) || target.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = doc.documentElement.clientWidth;
    const vh = global.innerHeight;
    let [ax, ay] = tipPoint(target.dataset.tipAt, "sw");
    let [bx, by] = tipPoint(target.dataset.tipAnchor, "nw");
    const at = () => [r.left + ax * r.width - bx * w, r.top + ay * r.height - by * h];
    let [left, top] = at();
    if (left < 0 || left + w > vw) {
      [ax, bx] = [1 - ax, 1 - bx];
      const [l2] = at();
      if (l2 >= 0 && l2 + w <= vw) left = l2;
    }
    if (top < 0 || top + h > vh) {
      [ay, by] = [1 - ay, 1 - by];
      const [, t2] = at();
      if (t2 >= 0 && t2 + h <= vh) top = t2;
    }
    left = Math.max(4, Math.min(left, vw - w - 4));
    top = Math.max(0, Math.min(top, vh - h));
    el.style.left = `${left + global.scrollX}px`;
    el.style.top = `${top + global.scrollY}px`;
  }
  function hideTip() {
    if (tipEl) {
      boxes.delete(tipEl);
      tipEl.remove();
      tipEl = null;
    }
  }
  function initTooltips() {
    doc.addEventListener("mouseover", (e) => {
      const t = e.target.closest?.("[data-tip]");
      if (t) showTip(t);
    });
    doc.addEventListener("mouseout", (e) => {
      const t = e.target.closest?.("[data-tip]");
      if (t && !t.contains(e.relatedTarget)) hideTip();
    });
    doc.addEventListener("focusin", (e) => {
      const t = e.target.closest?.("[data-tip]");
      if (t) showTip(t);
    });
    doc.addEventListener("focusout", hideTip);
  }

  // ---------------------------------------------------------------- boxed button

  function button(el) {
    const label = el.textContent.trim();
    if (el.tagName === "BUTTON" && !el.type) el.type = "button";
    box(el, {
      cols: num(el.dataset.cols, len(label) + 4),
      rows: 3,
      pad: 1,
      border: el.dataset.border || "single",
    });
    return el;
  }

  // ---------------------------------------------------------------- layout
  //
  // hstack / vstack / grid place their children in slots (.tui-slot) sized in
  // cells, so a child box with cols="auto" has a definite width to fill.
  // Slot options come from the child: data-size (cells; rows in a vstack),
  // data-grow (share of the leftover space), data-span (grid columns, or "all").

  function gapOf(el, dx, dy) {
    const [a, b] = String(el.dataset.gap ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((x) => num(x, 0));
    return { x: a ?? dx, y: b ?? (a !== undefined && dy === null ? a : (dy ?? 0)) };
  }
  function applySlot(slot, d) {
    const size = d.size,
      grow = d.grow,
      sp = d.span;
    slot.classList.toggle("is-sized", size != null && size !== "");
    slot.classList.toggle("is-grow", grow != null && grow !== "" && !(size != null && size !== ""));
    if (size != null && size !== "") slot.style.setProperty("--size", num(size, 0));
    else slot.style.removeProperty("--size");
    if (grow != null && grow !== "")
      slot.style.setProperty("--grow", grow === true ? 1 : num(grow, 1));
    else slot.style.removeProperty("--grow");
    if (sp === "all") slot.style.gridColumn = "1 / -1";
    else if (sp != null && sp !== "") slot.style.gridColumn = `span ${num(sp, 1)}`;
    else slot.style.removeProperty("grid-column");
  }
  /* Wrap child in a slot (or reuse it when it is one) and size the slot. */
  function wrapSlot(child, d) {
    let slot = child;
    if (!child.classList?.contains("tui-slot")) {
      slot = div("tui-slot");
      if (child.parentNode) child.replaceWith(slot);
      slot.appendChild(child);
    }
    const cd = child.dataset || {};
    const spacer = child.classList?.contains("tui-spacer") || cd.tui === "spacer";
    applySlot(
      slot,
      d || {
        size: cd.size,
        grow: cd.grow !== undefined ? cd.grow || 1 : spacer ? 1 : undefined,
        span: cd.span,
      },
    );
    return slot;
  }
  function stackSetup(el, kind) {
    el.classList.add("tui-stack", `tui-${kind}`);
    const g =
      kind === "hstack"
        ? gapOf(el, 2, 0)
        : kind === "vstack"
          ? gapOf(el, 0, null)
          : gapOf(el, 2, 1);
    // A vstack gap is in rows: one number means rows, not columns.
    if (kind === "vstack") {
      const v = String(el.dataset.gap ?? "").trim();
      g.y = v ? num(v.split(/\s+/)[0], 0) : 0;
      g.x = 0;
    }
    el.style.setProperty("--gap-x", g.x);
    el.style.setProperty("--gap-y", g.y);
    if (kind === "grid") {
      const min = el.dataset.min;
      el.style.gridTemplateColumns = min
        ? `repeat(auto-fill, minmax(min(100%, calc(${num(min, 20)} * var(--cw))), 1fr))`
        : String(el.dataset.columns || "1fr")
            .trim()
            .split(/\s+/)
            .map((t) => (/^\d+(\.\d+)?$/.test(t) ? `calc(${t} * var(--cw))` : t))
            .join(" ");
    }
  }
  function stack(el, kind) {
    stackSetup(el, kind);
    for (const c of Array.from(el.children)) {
      if (c.classList.contains("tui-slot")) applySlot(c, c.dataset);
      else wrapSlot(c);
    }
    return el;
  }
  const hstack = (el) => stack(el, "hstack");
  const vstack = (el) => stack(el, "vstack");
  const grid = (el) => stack(el, "grid");
  function spacer(el) {
    el.classList.add("tui-spacer", "tui-grow");
    return el;
  }

  // ---------------------------------------------------------------- split
  //
  // One box divided into panes. The dividers belong to the frame: their ends
  // become tees on the outer border (┬ ┴ ├ ┤, or ╤ ╧ ╟ ╢ in a double box) and
  // nested splits join the divider they meet. Pane sizes are whole cells.
  //
  //   <div data-tui="split" data-dir="h" data-sizes="26 1fr" data-cols="auto">
  //     <div data-pane data-title="Pilot">…</div>
  //     <div data-pane data-title="Weapons">…</div>
  //   </div>
  //
  // dir: h (side by side, default) | v (stacked). sizes: one token per pane,
  // cells ("26"), percent ("30%") or fr ("1fr", default). A split that is the
  // only child of another split's pane draws no frame of its own.

  function sizeTokens(spec, n) {
    const a = String(spec ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    while (a.length < n) a.push("1fr");
    return a.slice(0, n);
  }
  /* Resolve size tokens to whole cells that add up to avail. */
  function resolveSizes(tokens, avail, mins) {
    const n = tokens.length;
    const out = Array(n).fill(0);
    const fr = [];
    let used = 0;
    tokens.forEach((t, i) => {
      if (/fr$/.test(t)) fr.push([i, num(t, 1) || 1]);
      else {
        out[i] = Math.floor(/%$/.test(t) ? (avail * num(t, 0)) / 100 : num(t, 0));
        used += out[i];
      }
    });
    const rest = Math.max(0, avail - used);
    const total = fr.reduce((s, [, w]) => s + w, 0);
    for (const [i, w] of fr) out[i] = Math.floor((rest * w) / total);
    // Remainder (or overflow) goes to the last fr pane, else the last pane.
    const sum = () => out.reduce((s, x) => s + x, 0);
    const sink = fr.length ? fr[fr.length - 1][0] : n - 1;
    out[sink] += avail - sum();
    // Minimums: grow small panes, then take the cells back from the others,
    // last pane first; below that the last pane is cut.
    for (let i = 0; i < n; i++) out[i] = Math.max(out[i], Math.min(mins[i], avail));
    let over = sum() - avail;
    for (let i = n - 1; i >= 0 && over > 0; i--) {
      const give = Math.max(0, Math.min(over, out[i] - mins[i]));
      out[i] -= give;
      over -= give;
    }
    for (let i = n - 1; i >= 0 && over > 0; i--) {
      const give = Math.min(over, out[i] - 1);
      out[i] -= give;
      over -= give;
    }
    return out;
  }

  function split(el, opts) {
    opts = opts || {};
    if (el._split) {
      // Re-entry: TUI.split(el, { sizes, dir }) changes the layout.
      const sp = el._split;
      if (opts.sizes !== undefined) {
        sp.tokens = sizeTokens(
          Array.isArray(opts.sizes) ? opts.sizes.join(" ") : opts.sizes,
          sp.panes.length,
        );
        el.dataset.sizes = sp.tokens.join(" ");
      }
      relayoutSplit(sp.root);
      return el;
    }
    const d = el.dataset;
    const parentPane = el.parentElement?.closest(".tui-pane");
    const nested =
      !!parentPane &&
      parentPane.parentElement?.classList.contains("tui-split-grid") &&
      Array.from(parentPane.children).filter((c) => !c.classList.contains("tui-slot")).length === 1;
    el._tuiDone = true;
    el.classList.add("tui-split");
    const dir = (opts.dir || d.dir) === "v" ? "v" : "h";
    el.dataset.dir = dir;

    // Panes: [data-pane] / .tui-pane children; anything else gets wrapped.
    const kids = Array.from(el.children);
    const panes = kids.map((c) => {
      if (c.classList.contains("tui-pane") || c.hasAttribute("data-pane")) return c;
      const p = div();
      c.replaceWith(p);
      p.appendChild(c);
      return p;
    });
    let gridEl;
    if (nested) {
      el.classList.add("is-nested", "tui-split-grid");
      gridEl = el;
    } else {
      box(el, { pad: 0, cols: opts.cols, rows: opts.rows, border: opts.border });
      gridEl = div("tui-split-grid");
      el._tui.inner.appendChild(gridEl);
    }
    panes.forEach((p, i) => {
      p.classList.add("tui-pane");
      if (p.dataset.pad !== undefined) p.style.setProperty("--pad", num(p.dataset.pad, 1));
      if (i) gridEl.appendChild(div("tui-split-gutter"));
      gridEl.appendChild(p);
    });
    const sp = {
      el,
      dir,
      panes,
      grid: gridEl,
      nested,
      tokens: sizeTokens(opts.sizes ?? d.sizes ?? (d.at ? `${d.at} 1fr` : ""), panes.length),
      root: null,
      sizes: [],
    };
    el._split = sp;
    // A pane whose only child is a split hosts it edge to edge.
    for (const p of panes) {
      const only = Array.from(p.children);
      if (only.length === 1 && only[0].dataset.tui === "split") {
        p.classList.add("is-host");
        split(only[0]);
      }
    }
    if (nested) return el;

    // Root: size every split in the tree before rows are measured, paint all
    // dividers after the frame is drawn, repaint when a pane changes size.
    const markRoot = (s) => {
      s.root = el;
      for (const p of s.panes) {
        const c = p.firstElementChild;
        if (p.classList.contains("is-host") && c?._split) markRoot(c._split);
      }
    };
    markRoot(sp);
    const st = el._tui;
    st.sizer = (c, fixedRows) => sizeSplit(sp, c - 2, fixedRows);
    st.hooks.push((g) => paintSplit(el, g));
    if (typeof ResizeObserver !== "undefined") {
      let queued = 0;
      st.splitRo = new ResizeObserver(() => {
        if (queued) return;
        queued = requestAnimationFrame(() => {
          queued = 0;
          if (el.isConnected) relayoutSplit(el);
        });
      });
      const watch = (s) => {
        for (const p of s.panes) {
          st.splitRo.observe(p);
          const c = p.firstElementChild;
          if (p.classList.contains("is-host") && c?._split) watch(c._split);
        }
      };
      watch(sp);
    }
    el.addEventListener("keydown", (e) => {
      const h = e.target.closest?.(".tui-split-handle");
      h?._drag?.key(e);
    });
    st.drawn = false;
    layout(el);
    return el;
  }

  function relayoutSplit(root) {
    if (!root?._tui) return;
    root._tui.drawn = false;
    layout(root);
  }

  function paneMin(p) {
    if (p.dataset.min !== undefined) return Math.max(1, num(p.dataset.min, 3));
    const t = p.dataset.title;
    return t ? len(t) + 4 : 3;
  }

  /* Give every pane of sp (and of the splits nested in it) its cell size.
     w: cells across; h: rows down when fixed, null when content decides. */
  function sizeSplit(sp, w, h) {
    const n = sp.panes.length;
    const mins = sp.panes.map(paneMin);
    const cell = (x, unit) => `calc(${x} * var(${unit}))`;
    if (sp.dir === "h") {
      const ws = resolveSizes(sp.tokens, Math.max(n, w - (n - 1)), mins);
      sp.sizes = ws;
      sp.grid.style.gridTemplateColumns = ws.map((x) => cell(x, "--cw")).join(" var(--cw) ");
      sp.grid.style.gridTemplateRows = "";
      sp.grid.style.height = h != null ? cell(h, "--ch") : "";
      sp.panes.forEach((p, i) => {
        const c = p.firstElementChild;
        if (p.classList.contains("is-host") && c?._split) sizeSplit(c._split, ws[i], h);
      });
    } else {
      let hs;
      if (h != null)
        hs = resolveSizes(
          sp.tokens,
          Math.max(n, h - (n - 1)),
          mins.map(() => 1),
        );
      else {
        // Content decides: fixed tokens keep their rows; the last fr pane
        // takes what is left when the split is stretched by its parent.
        const lastFr = sp.tokens.map((t) => /fr$/.test(t)).lastIndexOf(true);
        hs = sp.tokens.map((t, i) =>
          /^\d+(\.\d+)?$/.test(t) ? num(t, 1) : i === lastFr ? "fr" : null,
        );
      }
      sp.sizes = hs;
      sp.grid.style.gridTemplateColumns = "";
      sp.grid.style.gridTemplateRows = hs
        .map((x) => (x === null ? "auto" : x === "fr" ? "minmax(auto, 1fr)" : cell(x, "--ch")))
        .join(" var(--ch) ");
      sp.grid.style.height = h != null ? cell(h, "--ch") : "";
      sp.panes.forEach((p, i) => {
        p.classList.toggle("is-fixed", typeof hs[i] === "number");
        const c = p.firstElementChild;
        if (p.classList.contains("is-host") && c?._split)
          sizeSplit(c._split, w, typeof hs[i] === "number" ? hs[i] : null);
      });
    }
  }

  /* Draw the dividers of every split in root's tree. Ends that land on the
     outer border become frame joints; ends that land on another divider are
     drawn over it (a tee over a line reads as the joint). Pane titles sit on
     the line above each pane. */
  function paintSplit(root, g) {
    const st = root._tui;
    if (!st.splitLayer) {
      st.splitLayer = div("tui-split-lines");
      root.appendChild(st.splitLayer);
    }
    const layer = st.splitLayer;
    const focused = layer.contains(doc.activeElement) ? doc.activeElement._drag?.id : null;
    layer.textContent = "";
    const c = st.c,
      r = st.r;
    const R = root.getBoundingClientRect();
    if (!R.width) return; // hidden (e.g. an inactive tab): paint when shown
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return {
        x: Math.round((b.left - R.left) / metrics.cw),
        y: Math.round((b.top - R.top) / metrics.ch),
        w: Math.round(b.width / metrics.cw),
        h: Math.round(b.height / metrics.ch),
      };
    };
    const dv = cssChars(root, "--tui-div", 7, g.h + g.v + g.lt + g.rt + g.tt + g.bt + g.x);
    const dg = { h: dv[0], v: dv[1], lt: dv[2], rt: dv[3], tt: dv[4], bt: dv[5] };
    const vs = cssChars(root, "--tui-vsep", 3, g.tt + dg.v + g.bt);
    const top = [],
      bottom = [],
      edges = [],
      titles = [];
    const place = (x, y, text, cls) => {
      const s = div(cls || "tui-split-line", text);
      s.style.left = `calc(${x} * var(--cw))`;
      s.style.top = `calc(${y} * var(--ch))`;
      layer.appendChild(s);
      return s;
    };
    const title = (x, y, text, room) => {
      if (!text || room < 3) return;
      let t = ` ${text} `;
      if (len(t) > room) t = `${fit(text, Math.max(1, room - 2)).trimEnd()} `;
      if (len(t) > room) return;
      if (y === 0) titles.push({ at: x, text: t, cls: "tui-title tui-pane-title" });
      else {
        const s = place(x, y, t, "tui-split-line tui-pane-title");
        if (t.trim() !== text) s.title = text;
      }
    };
    let id = 0;
    const walk = (sp, R0) => {
      const rs = sp.panes.map(rect);
      const n = rs.length;
      if (sp.dir === "h") {
        for (let k = 0; k < n - 1; k++) {
          const x = rs[k].x + rs[k].w;
          const y0 = R0.y,
            y1 = R0.y + R0.h - 1;
          const col = place(
            x,
            y0,
            Array(Math.max(0, y1 - y0 + 1))
              .fill(dg.v)
              .join("\n"),
          );
          handle(col, sp, k, id++);
          if (y0 - 1 === 0) top.push({ at: x, ch: vs[0] });
          else place(x, y0 - 1, dg.tt);
          if (y1 + 1 === r - 1) bottom.push({ at: x, ch: vs[2] });
          else place(x, y1 + 1, dg.bt);
        }
        sp.panes.forEach((p, i) => {
          title(rs[i].x + 1, R0.y - 1, p.dataset.title, rs[i].w - 1);
        });
      } else {
        for (let k = 0; k < n - 1; k++) {
          const y = rs[k].y + rs[k].h;
          const x0 = R0.x,
            x1 = R0.x + R0.w - 1;
          const row = place(x0, y, dg.h.repeat(Math.max(0, x1 - x0 + 1)));
          handle(row, sp, k, id++);
          if (x0 - 1 === 0) edges.push({ y, side: "l", ch: g.sepL });
          else place(x0 - 1, y, dg.lt);
          if (x1 + 1 === c - 1) edges.push({ y, side: "r", ch: g.sepR });
          else place(x1 + 1, y, dg.rt);
        }
        sp.panes.forEach((p, i) => {
          title(R0.x + 1, i ? rs[i - 1].y + rs[i - 1].h : R0.y - 1, p.dataset.title, R0.w - 1);
        });
      }
      sp.panes.forEach((p, i) => {
        const ch = p.firstElementChild;
        if (p.classList.contains("is-host") && ch?._split) walk(ch._split, rs[i]);
        // A .tui-sep in a pane reaches one cell into the divider or border on
        // each side; give it the matching tees.
        for (const s of p.querySelectorAll(".tui-sep")) {
          if (s.closest(".tui-pane") !== p || s.closest(".tui-box") !== root) continue;
          const { x, w } = rs[i];
          const y = rect(s).y;
          const left = x - 1 === 0 ? g.sepL : dg.lt;
          const right = x + w === c - 1 ? g.sepR : dg.rt;
          s.textContent = left + dg.h.repeat(Math.max(0, w)) + right;
          if (x - 1 === 0) edges.push({ y, side: "l", ch: g.sepL });
          if (x + w === c - 1) edges.push({ y, side: "r", ch: g.sepR });
        }
      });
    };
    walk(root._split, { x: 1, y: 1, w: c - 2, h: r - 2 });
    if (focused != null) layer.querySelector(`[data-split-id="${focused}"]`)?.focus();

    // The frame joints and top titles are part of the frame: redraw it once
    // when they change (draw runs this hook again, which then finds no change).
    const key = JSON.stringify([top, bottom, edges, titles]);
    if (key !== st.splitKey) {
      st.splitKey = key;
      st.junctions = top;
      st.bottomJunctions = bottom;
      st.edgeJoints = edges;
      st.extraTop = titles;
      draw(root);
    }
  }

  /* Make a painted divider draggable and keyboard-movable. */
  function handle(el, sp, k, id) {
    if (sp.el.dataset.fixed !== undefined) return; // data-fixed: sizes are not user-adjustable
    const h = sp.dir === "h";
    el.classList.add("tui-split-handle", h ? "is-v" : "is-h");
    el.tabIndex = 0;
    el.dataset.splitId = id;
    const now = () =>
      h ? sp.sizes : sp.panes.map((p) => Math.round(p.getBoundingClientRect().height / metrics.ch));
    const move = (delta) => {
      const cur = now();
      const mins = sp.panes.map(h ? paneMin : () => 1);
      const a = Math.max(mins[k], Math.min(cur[k] + delta, cur[k] + cur[k + 1] - mins[k + 1]));
      if (a === cur[k]) return;
      const b = cur[k] + cur[k + 1] - a;
      const old = sp.tokens;
      const next = cur.map(String);
      next[k] = String(a);
      next[k + 1] = String(b);
      // The last pane keeps an fr size so the split still fills its parent.
      const last = old.length - 1;
      if (/fr$/.test(old[last])) next[last] = old[last];
      else if (k + 1 !== last && /fr$/.test(old[k + 1])) next[k + 1] = old[k + 1];
      sp.tokens = next;
      sp.el.dataset.sizes = next.join(" ");
      relayoutSplit(sp.root);
      emit(sp.el, "tui-resize", { index: k, sizes: now(), tokens: next.slice() });
    };
    el._drag = {
      id,
      key(e) {
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[e.key];
        if (step && e.key.startsWith("Arrow") && (h ? /Left|Right/ : /Up|Down/).test(e.key)) {
          e.preventDefault();
          move(step);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          move(e.key === "Home" ? -9999 : 9999);
        }
      },
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.focus();
      const unit = h ? metrics.cw : metrics.ch;
      let p0 = h ? e.clientX : e.clientY;
      const mv = (ev) => {
        const steps = Math.trunc(((h ? ev.clientX : ev.clientY) - p0) / unit);
        if (!steps) return;
        p0 += steps * unit;
        move(steps);
      };
      const up = () => {
        doc.removeEventListener("pointermove", mv);
        doc.removeEventListener("pointerup", up);
        doc.body.classList.remove("tui-dragging");
      };
      doc.body.classList.add("tui-dragging");
      doc.addEventListener("pointermove", mv);
      doc.addEventListener("pointerup", up);
    });
  }

  // ---------------------------------------------------------------- scenes
  //
  // A scene is a tree of nodes rendered to the same data-tui markup the kit
  // upgrades. TUI.h builds nodes, TUI.prefab registers reusable templates and
  // TUI.mount renders a tree and returns a handle. update() re-renders the
  // tree and patches only the components whose props or children changed; a
  // locale switch re-renders every scene from scratch.

  const NODE = Symbol("tui.node");
  const prefabs = new Map();
  const scenes = new Set();
  const EVENTS = {
    onSelect: "tui-select",
    onTab: "tui-tab",
    onClose: "tui-close",
    onResize: "tui-resize",
    onChange: "change",
    onInput: "input",
    onClick: "click",
    onKeydown: "keydown",
  };
  const SLOT_PROPS = ["size", "grow", "span"];
  const COMMON = new Set([
    "id",
    "class",
    "style",
    "attrs",
    "tip",
    "tipAt",
    "tipAnchor",
    "tipXY",
    "tipFrom",
    "tipRuns",
    "hidden",
    "on",
    ...SLOT_PROPS,
  ]);
  const BOXP = [
    "cols",
    "rows",
    "title",
    "titleAlign",
    "footer",
    "footerRight",
    "border",
    "tone",
    "theme",
    "shadow",
    "pad",
    "inset",
  ];
  const BOXDEF = {
    cols: 20,
    rows: "auto",
    title: "",
    titleAlign: "left",
    footer: "",
    footerRight: "",
    border: "single",
    shadow: false,
    pad: 1,
    inset: "",
  };

  const isNode = (x) => !!x && typeof x === "object" && !!x[NODE];
  const isTok = (x) => !!x && typeof x === "object" && x.__t !== undefined;
  const isPlain = (x) =>
    !!x &&
    typeof x === "object" &&
    Object.getPrototypeOf(x) === Object.prototype &&
    !isNode(x) &&
    !isTok(x);

  /* h(type, props?, ...children): a node. props.key keeps identity in a list,
     props.ref names the node for scene.refs. */
  function h(type, props, ...children) {
    if (!isPlain(props)) {
      if (props != null) children.unshift(props);
      props = {};
    }
    const { key, ref, ...rest } = props;
    return { [NODE]: true, type, props: rest, key, ref, children };
  }
  function flatKids(list, out = []) {
    for (const c of list) {
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) flatKids(c, out);
      else if (isNode(c)) out.push(c);
      else out.push({ [NODE]: true, type: "#text", props: { text: c }, children: [] });
    }
    return out;
  }
  /* A fresh instance of a node tree (rendering writes .el into it). Props of
     a node with a ref get that ref's overrides from ref.update(). */
  function inst(v, ov) {
    const props = v.ref && ov[v.ref] ? { ...v.props, ...ov[v.ref] } : v.props;
    let kids = flatKids(v.children || []);
    if (v.type === "split")
      kids = kids.map((c) =>
        c.type === "pane" ? c : h("pane", c.props.title ? { title: c.props.title } : {}, c),
      );
    return {
      [NODE]: true,
      type: v.type,
      props,
      key: v.key,
      ref: v.ref,
      children: kids.map((c) => inst(c, ov)),
    };
  }
  /* Resolve TUI.h.t() tokens to text in the current locale. */
  function res(v) {
    if (isTok(v)) return i18n.t(v.__t, v.vars, v.fallback);
    if (Array.isArray(v)) return v.map(res);
    if (isPlain(v)) {
      const o = {};
      for (const k in v) o[k] = res(v[k]);
      return o;
    }
    return v;
  }
  const str = (v) => (v == null ? "" : String(res(v)));
  function deepEq(a, b) {
    if (a === b) return true;
    if (typeof a === "function" || typeof b === "function") return true; // handlers rebind anyway
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a),
      kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
  }
  const sig = (v) => ({ t: v.type, k: v.key, p: res(v.props), c: v.children.map(sig) });
  const sameKids = (a, b) => deepEq(a.map(sig), b.map(sig));

  function setData(el, k, v) {
    if (v == null || v === false) delete el.dataset[k];
    else el.dataset[k] = v === true ? "" : String(v);
  }
  function common(el, p, o = {}) {
    if (p.id !== o.id) {
      if (p.id) el.id = p.id;
      else el.removeAttribute("id");
    }
    if (p.class !== o.class) {
      const cls = (c) =>
        String(c || "")
          .split(/\s+/)
          .filter(Boolean);
      el.classList.remove(...cls(o.class));
      el.classList.add(...cls(p.class));
    }
    if (!deepEq(p.style, o.style)) {
      for (const k in o.style || {}) el.style.removeProperty(k);
      for (const k in p.style || {}) el.style.setProperty(k, p.style[k]);
    }
    if (!deepEq(p.attrs, o.attrs)) {
      for (const k in o.attrs || {}) if (!(k in (p.attrs || {}))) el.removeAttribute(k);
      for (const k in p.attrs || {}) el.setAttribute(k, p.attrs[k]);
    }
    if (p.tip !== o.tip) setData(el, "tip", p.tip);
    if (p.tipAt !== o.tipAt) setData(el, "tipAt", p.tipAt);
    if (p.tipAnchor !== o.tipAnchor) setData(el, "tipAnchor", p.tipAnchor);
    if (p.tipXY !== o.tipXY) setData(el, "tipXy", p.tipXY);
    if (p.tipFrom !== o.tipFrom) setData(el, "tipFrom", p.tipFrom);
    if (!deepEq(p.tipRuns, o.tipRuns))
      setData(el, "tipRuns", p.tipRuns ? JSON.stringify(p.tipRuns) : undefined);
    if (!!p.hidden !== !!o.hidden) el.hidden = !!p.hidden;
  }
  function bindEvents(el, p, sc) {
    const map = {};
    for (const k in EVENTS) if (typeof p[k] === "function") map[EVENTS[k]] = p[k];
    for (const k in p.on || {}) map[k] = p.on[k];
    el._tuiOn = map;
    el._tuiBound = el._tuiBound || new Set();
    for (const name in map) {
      if (el._tuiBound.has(name)) continue;
      el._tuiBound.add(name);
      el.addEventListener(name, (e) => {
        // Kit events bubble from nested components: only take our own.
        if (name.startsWith("tui-") && e.target !== el) return;
        el._tuiOn[name]?.(e, sc.handle);
      });
    }
  }
  const make = (tag, cls, tui) => {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (tui) el.dataset.tui = tui;
    return el;
  };
  const boxCreate =
    (tui, tag = "div") =>
    (p) => {
      const el = make(tag, "", tui);
      for (const k of BOXP) setData(el, k, p[k]);
      return el;
    };
  function boxPatch(el, k, v) {
    if (!BOXP.includes(k)) return false;
    setData(el, k, v);
    // A theme only swaps color tokens: CSS repaints, no relayout.
    if (k === "theme") return true;
    if (k === "tone") {
      el._tui.drawn = false;
      layout(el);
    } else box(el, { [k]: v ?? BOXDEF[k] });
    return true;
  }
  const innerOf = (el) => el._tui?.inner || el;
  const stackCreate = (kind) => (p) => {
    const el = make("div", "", kind);
    setData(el, "gap", p.gap);
    setData(el, "wrap", p.wrap);
    setData(el, "align", p.align);
    if (kind === "grid") {
      setData(el, "columns", p.columns);
      setData(el, "min", p.min);
    }
    return el;
  };
  const stackPatch = (kind) => (el, k, v) => {
    if (!["gap", "wrap", "align", "columns", "min"].includes(k)) return false;
    setData(el, k, v);
    stackSetup(el, kind);
    return true;
  };
  function check(kind) {
    return {
      create(p, _v, append) {
        const el = make("label", `tui-${kind}`);
        const inp = make("input");
        inp.type = kind === "check" ? "checkbox" : "radio";
        if (p.name) inp.name = p.name;
        if (p.value != null) inp.value = p.value;
        inp.checked = !!p.checked;
        inp.disabled = !!p.disabled;
        const label = make("span");
        el.append(inp, make("span", "tui-mark"), label);
        append(label);
        return el;
      },
      host: (el) => el.lastElementChild,
      patch(el, k, v) {
        const inp = el.firstElementChild;
        if (k === "checked") inp.checked = !!v;
        else if (k === "disabled") inp.disabled = !!v;
        else if (k === "value") inp.value = v ?? "";
        else if (k === "name") inp.name = v ?? "";
        else return false;
        return true;
      },
    };
  }
  /* Raw markup for the components whose upgrader reads its children
     (menu, list, select): built once, replaced when anything changes. */
  function itemsMarkup(el, kids) {
    for (const c of kids) {
      const p = res(c.props);
      if (c.type === "sep") el.appendChild(make("hr"));
      else if (c.type === "item") {
        const it = make("div");
        if (p.value != null) it.dataset.value = p.value;
        if (p.shortcut) it.dataset.key = p.shortcut;
        if (p.disabled) it.setAttribute("disabled", "");
        if (p.html != null) it.innerHTML = p.html;
        else it.textContent = c.children.map((x) => str(x.props.text)).join("");
        el.appendChild(it);
      }
    }
  }

  const TYPES = {
    "#text": { create: () => make("span", "", null), children: "none" },
    box: { create: boxCreate("box"), patch: boxPatch, host: innerOf },
    window: {
      create: (p) => {
        const el = boxCreate("window")(p);
        if (p.closable) el.dataset.closable = "";
        return el;
      },
      patch: (el, k, v) => k !== "closable" && boxPatch(el, k, v),
      host: innerOf,
    },
    scroll: { create: boxCreate("scroll"), patch: boxPatch, host: innerOf },
    tabs: { create: boxCreate("tabs"), patch: boxPatch, host: innerOf, children: "tabs" },
    tab: {
      create: (p) => {
        const el = make("section");
        el.dataset.tab = str(p.label);
        if (p.active) el.dataset.active = "";
        return el;
      },
      patch(el, k, v) {
        if (k !== "active") return false;
        const tabs = el.closest(".tui-box");
        const i = tabs?._tui?.tabs?.findIndex((t) => t.pane === el);
        if (v && i >= 0) tabs._tui.selectTab(i);
        return true;
      },
    },
    split: {
      create: (p) => {
        const el = boxCreate("split")(p);
        setData(el, "dir", p.dir);
        setData(el, "sizes", Array.isArray(p.sizes) ? p.sizes.join(" ") : p.sizes);
        setData(el, "fixed", p.fixed);
        return el;
      },
      patch(el, k, v) {
        if (k === "sizes") {
          split(el, { sizes: v ?? "" });
          return true;
        }
        if (k === "fixed") {
          setData(el, "fixed", v);
          return true;
        }
        return !el.classList.contains("is-nested") && k !== "dir" && boxPatch(el, k, v);
      },
      host: (el) => el._split?.grid || el,
      children: "split",
    },
    pane: {
      create: (p) => {
        const el = make("div");
        el.dataset.pane = "";
        setData(el, "title", p.title);
        setData(el, "min", p.min);
        setData(el, "pad", p.pad);
        return el;
      },
      patch(el, k, v) {
        if (!["title", "min", "pad"].includes(k)) return false;
        setData(el, k, v);
        if (k === "pad") el.style.setProperty("--pad", num(v, 1));
        const sp = el.parentElement?.closest(".tui-split");
        relayoutSplit(sp?._split?.root || sp);
        return true;
      },
    },
    hstack: { create: stackCreate("hstack"), patch: stackPatch("hstack"), children: "slot" },
    vstack: { create: stackCreate("vstack"), patch: stackPatch("vstack"), children: "slot" },
    grid: { create: stackCreate("grid"), patch: stackPatch("grid"), children: "slot" },
    spacer: { create: () => make("span", "", "spacer"), children: "none" },
    table: {
      create: (p) => {
        const el = table({
          columns: p.columns || [],
          rows: p.rows || [],
          rules: p.rules,
          border: p.border,
        });
        if (p.selected != null) el._tui.selectRow(p.selected);
        return el;
      },
      patch(el, k, v) {
        if (k !== "selected") return false;
        el._tui.selectRow(v ?? -1);
        return true;
      },
      children: "none",
    },
    progress: {
      create: (p) => {
        const el = make("span", "", "progress");
        setData(el, "cols", p.cols);
        setData(el, "value", p.value);
        setData(el, "label", p.label);
        setData(el, "tone", p.tone);
        setData(el, "dir", p.dir);
        setData(el, "rows", p.rows);
        if (p.ascii) el.dataset.style = "ascii";
        return el;
      },
      patch(el, k, v) {
        if (k === "value") progress(el, v);
        else if (["tone", "dir", "rows", "cols", "label"].includes(k)) {
          setData(el, k, v);
          progress(el);
        } else return false;
        return true;
      },
      children: "none",
    },
    spinner: {
      create: (p) => {
        const el = make("span", "", "spinner");
        setData(el, "frames", p.frames);
        return el;
      },
      children: "none",
    },
    menu: {
      create: (p, v) => {
        const el = boxCreate("menu")(p);
        itemsMarkup(el, v.children);
        return el;
      },
      children: "replace",
    },
    list: {
      create: (p, v) => {
        const el = boxCreate("list")(p);
        setData(el, "selected", p.selected);
        itemsMarkup(el, v.children);
        return el;
      },
      children: "replace",
    },
    item: { create: () => make("div"), children: "replace" },
    sep: { create: () => make("div", "tui-sep"), children: "none" },
    select: {
      create: (p, v) => {
        const wrap = make("span", "tui-select-wrap");
        const sel = make("select", "", "select");
        setData(sel, "cols", p.cols);
        if (p.name) sel.name = p.name;
        const opts = (p.options || []).map((o) =>
          typeof o === "object" ? o : { value: o, label: o },
        );
        for (const c of v.children)
          if (c.type === "option")
            opts.push({
              ...res(c.props),
              label: c.children.map((x) => str(x.props.text)).join(""),
            });
        for (const o of opts) {
          const op = make("option");
          op.value = o.value ?? o.label;
          op.textContent = o.label ?? o.value;
          if (o.selected || (p.value != null && String(op.value) === String(p.value)))
            op.selected = true;
          sel.appendChild(op);
        }
        wrap.appendChild(sel);
        return wrap;
      },
      // A new value keeps the element (and its focus); new options rebuild it.
      patch(el, k, v) {
        if (k !== "value") return false;
        const sel = el.querySelector("select");
        if (!sel) return false;
        sel.value = String(v ?? "");
        const label = sel._tuiButton?.querySelector(".tui-select-label");
        if (label)
          label.textContent = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : "";
        return true;
      },
      children: "replace",
    },
    option: { create: () => make("option"), children: "replace" },
    button: {
      create: (p, v) => {
        const el = make("button", "", "button");
        el.type = "button";
        setData(el, "border", p.border);
        setData(el, "cols", p.cols);
        // The label is read from the text at upgrade, so it goes in now.
        el.textContent = v.children.map((x) => str(x.props.text)).join("");
        return el;
      },
      children: "replace",
    },
    btn: {
      create: (p) => {
        const el = make("button", `tui-btn${p.primary ? " is-primary" : ""}`);
        el.type = "button";
        setData(el, "variant", p.variant);
        el.disabled = !!p.disabled;
        return el;
      },
      patch(el, k, v) {
        if (k === "primary") el.classList.toggle("is-primary", !!v);
        else if (k === "disabled") el.disabled = !!v;
        else if (k === "variant") setData(el, "variant", v);
        else return false;
        return true;
      },
    },
    input: {
      create: (p) => {
        const el = make("input", "tui-input");
        el.type = p.type || "text";
        if (p.cols) el.style.setProperty("--cols", p.cols);
        if (p.name) el.name = p.name;
        if (p.placeholder != null) el.placeholder = p.placeholder;
        if (p.value != null) el.value = p.value;
        setData(el, "variant", p.variant);
        return el;
      },
      patch(el, k, v) {
        // value is only written when the prop changes, so typing is not undone.
        if (k === "value") el.value = v ?? "";
        else if (k === "placeholder") el.placeholder = v ?? "";
        else if (k === "cols") el.style.setProperty("--cols", v);
        else if (k === "variant") setData(el, "variant", v);
        else return false;
        return true;
      },
      children: "none",
    },
    check: check("check"),
    radio: check("radio"),
    line: { create: () => make("span", "tui-line") },
    col: {
      create: (p) => {
        const el = make("span", "tui-col");
        el.style.setProperty("--col", p.col ?? 8);
        return el;
      },
      patch(el, k, v) {
        if (k !== "col") return false;
        el.style.setProperty("--col", v ?? 8);
        return true;
      },
    },
    statusbar: { create: () => make("div", "tui-statusbar") },
    kbd: { create: () => make("span", "tui-kbd") },
    seg: {
      create: (p) => make("span", p.alt ? "tui-seg-alt" : "tui-seg"),
      patch(el, k, v) {
        if (k !== "alt") return false;
        el.className = v ? "tui-seg-alt" : "tui-seg";
        return true;
      },
    },
    text: { create: () => make("span") },
    p: { create: () => make("p") },
    el: { create: (p) => make(p.tag || "div") },
  };

  function slotProps(p) {
    return { size: p.size, grow: p.grow, span: p.span };
  }

  /* Build v's element (and its subtree). Not upgraded yet: settle() does that
     once the element is in the document. */
  function render(v, sc, parent) {
    v.parent = parent || null;
    v.scene = sc;
    const pf = prefabs.get(v.type);
    if (pf) {
      v.rendered = inst(prefabOut(pf, v), sc.overrides);
      render(v.rendered, sc, v);
      v.el = v.rendered.el;
      return v.el;
    }
    const spec = TYPES[v.type];
    if (!spec) throw new Error(`TUI: unknown node type "${v.type}"`);
    const p = res(v.props);
    let appended = false;
    const append = (host) => {
      appended = true;
      for (const c of v.children) host.appendChild(placeChild(c, sc, v, spec));
    };
    const el = spec.create(p, v, append);
    v.el = el;
    if (v.type === "#text") el.textContent = str(v.props.text);
    common(el, p);
    bindEvents(el, v.props, sc);
    const mode = spec.children || "inplace";
    if (!appended && (mode === "inplace" || mode === "slot" || mode === "tabs" || mode === "split"))
      append(el);
    return el;
  }
  function placeChild(c, sc, parent, spec) {
    const el = render(c, sc, parent);
    c.slot = spec.children === "slot" ? wrapSlot(el, slotProps(res(c.props))) : null;
    return c.slot || el;
  }
  function prefabOut(pf, v) {
    const out = pf.render(res({ ...pf.defaults, ...v.props }), v.children);
    return isNode(out) ? out : flatKids([out])[0] || h("text");
  }
  const outerOf = (v) => v.slot || v.el;

  /* Upgrade a freshly inserted subtree and redraw its boxes (a box built
     before it was in the document read no border glyphs from CSS). */
  function settle(el) {
    if (el.nodeType !== 1) return;
    upgrade(el);
    const boxesIn = [el, ...el.querySelectorAll(".tui-box")];
    for (const b of boxesIn) {
      if (!b._tui?.built) continue;
      b._tui.drawn = false;
      layout(b);
    }
  }

  function replace(o, n) {
    const sc = o.scene;
    render(n, sc, o.parent);
    o.el.replaceWith(n.el);
    n.slot = o.slot;
    if (n.slot) applySlot(n.slot, slotProps(res(n.props)));
    settle(n.el);
    const host = n.el.parentElement?.closest(".tui-split");
    if (host) relayoutSplit(host._split?.root || host);
    return n;
  }

  /* Bring the rendered node o in line with the new (unrendered) node n.
     Returns the node that is now in the tree: o, patched, or n, rendered. */
  function patch(o, n) {
    if (o === n) return o;
    if (o.type !== n.type || o.key !== n.key) return replace(o, n);
    const sc = o.scene;
    if (n.type === "#text") {
      const t = str(n.props.text);
      if (o.el.textContent !== t) o.el.textContent = t;
      o.props = n.props;
      return o;
    }
    const pf = prefabs.get(n.type);
    if (pf) {
      o.props = n.props;
      o.children = n.children;
      o.ref = n.ref;
      const r = patch(o.rendered, inst(prefabOut(pf, o), sc.overrides));
      r.parent = o;
      o.rendered = r;
      o.el = r.el;
      return o;
    }
    const spec = TYPES[n.type];
    const op = res(o.props),
      np = res(n.props);
    const keys = new Set([...Object.keys(op), ...Object.keys(np)]);
    for (const k of keys) {
      if (COMMON.has(k) || EVENTS[k] || deepEq(op[k], np[k])) continue;
      if (!spec.patch?.(o.el, k, np[k], np, o)) return replace(o, n);
    }
    const mode = spec.children || "inplace";
    if (mode === "replace" && !sameKids(o.children, n.children)) return replace(o, n);
    if (mode === "tabs" || mode === "split") {
      const shape = (v) =>
        v.children.map((c) => (mode === "tabs" ? `${c.type}:${str(c.props.label)}` : c.type));
      if (!deepEq(shape(o), shape(n))) return replace(o, n);
    }
    common(o.el, np, op);
    bindEvents(o.el, n.props, sc);
    if (o.slot && SLOT_PROPS.some((k) => !deepEq(op[k], np[k]))) applySlot(o.slot, slotProps(np));
    o.props = n.props;
    o.ref = n.ref;
    if (mode !== "replace" && mode !== "none") patchKids(o, n.children, spec);
    return o;
  }

  function patchKids(o, news, spec) {
    const host = spec.host ? spec.host(o.el) : o.el;
    const old = o.children;
    const byKey = new Map();
    for (const c of old) if (c.key != null) byKey.set(c.key, c);
    const used = new Set();
    const fresh = new Set();
    const out = news.map((n, i) => {
      let m = n.key != null ? byKey.get(n.key) : old[i];
      if (m && (used.has(m) || (n.key == null && m.key != null))) m = null;
      if (m) {
        used.add(m);
        return patch(m, n);
      }
      placeChild(n, o.scene, o, spec);
      fresh.add(n);
      return n;
    });
    for (const c of old) if (!used.has(c)) outerOf(c).remove();
    // Move only what is out of place, so focus and scroll inside survive.
    // Split panes never move (the shape check above keeps them in order) and
    // sit between gutters.
    let prev = null;
    for (const v of out) {
      v.parent = o;
      if (spec.children === "split") continue;
      const node = outerOf(v);
      const want = prev ? prev.nextSibling : host.firstChild;
      if (node !== want) host.insertBefore(node, want);
      prev = node;
    }
    for (const v of fresh) settle(v.el);
    o.children = out;
  }

  function indexRefs(sc) {
    sc.refMap = new Map();
    const walk = (v) => {
      if (v.ref) sc.refMap.set(v.ref, v);
      if (v.rendered) walk(v.rendered);
      for (const c of v.children) walk(c);
    };
    if (sc.tree) walk(sc.tree);
  }

  /* Render sc from scratch (first mount, locale switch). */
  function renderScene(sc) {
    const tree = inst(sc.source, sc.overrides);
    const old = sc.tree;
    if (old?.el?.isConnected) {
      render(tree, sc, null);
      old.el.replaceWith(tree.el);
    } else if (sc.replaceTarget) {
      // Mounted in place of a data-tui-use element. Once that element's root
      // is rebuilt from markup, upgrade() mounts a new scene there.
      if (old || !sc.target.isConnected) return scenes.delete(sc);
      render(tree, sc, null);
      sc.target.replaceWith(tree.el);
    } else {
      const target = sc.target.isConnected
        ? sc.target
        : sc.targetId && doc.getElementById(sc.targetId);
      if (!target) return scenes.delete(sc);
      sc.target = target;
      render(tree, sc, null);
      target.replaceChildren(tree.el);
    }
    sc.tree = tree;
    sc.dirty = false;
    settle(tree.el);
    indexRefs(sc);
  }
  function flushScene(sc) {
    if (!sc.dirty || !sc.tree) return;
    sc.dirty = false;
    sc.tree = patch(sc.tree, inst(sc.source, sc.overrides));
    sc.tree.parent = null;
    indexRefs(sc);
  }
  function schedule(sc) {
    sc.dirty = true;
    if (!sc.queued)
      sc.queued = Promise.resolve().then(() => {
        sc.queued = null;
        flushScene(sc);
      });
    return sc.queued;
  }

  /* TUI.mount(target, node) renders node into target and returns
       { el, refs, update(props), flush(), render(), destroy() }.
     refs.name is { el, props, update(props) } for the node with ref: "name";
     its updates stick across later scene updates. */
  function mount(target, node, opts) {
    const sc = {
      source: node,
      overrides: {},
      tree: null,
      target,
      targetId: target.id || "",
      replaceTarget: !!opts?.replace,
      dirty: false,
      queued: null,
      refMap: new Map(),
    };
    const refCache = {};
    const refs = new Proxy(
      {},
      {
        get(_, name) {
          if (typeof name !== "string") return undefined;
          if (!refCache[name]) refCache[name] = refHandle(name);
          return refCache[name];
        },
      },
    );
    function refHandle(name) {
      return {
        get el() {
          return sc.refMap.get(name)?.el;
        },
        get props() {
          const v = sc.refMap.get(name);
          return v ? res(v.props) : undefined;
        },
        update(p) {
          sc.overrides[name] = { ...sc.overrides[name], ...p };
          return schedule(sc);
        },
      };
    }
    sc.handle = {
      refs,
      get el() {
        return sc.tree?.el;
      },
      get props() {
        return res(sc.source.props);
      },
      update(p) {
        sc.source = { ...sc.source, props: { ...sc.source.props, ...p } };
        return schedule(sc);
      },
      flush: () => flushScene(sc),
      render: () => renderScene(sc),
      destroy() {
        scenes.delete(sc);
        sc.tree?.el?.remove();
        sc.tree = null;
      },
    };
    scenes.add(sc);
    renderScene(sc);
    return sc.handle;
  }

  /* TUI.prefab(name, defaults, render): render(props, children) returns a node. */
  function prefab(name, defaults, renderFn) {
    if (typeof defaults === "function") [defaults, renderFn] = [{}, defaults];
    if (TYPES[name]) throw new Error(`TUI: "${name}" is a built-in type`);
    prefabs.set(name, { defaults: defaults || {}, render: renderFn });
    return (props, ...kids) => h(name, props, ...kids);
  }

  /* <div data-tui-use="pilot-card" data-name="Atlas" data-hits="2"> */
  function useMount(el) {
    const name = el.dataset.tuiUse;
    if (!prefabs.has(name)) return;
    const props = {};
    for (const [k, v] of Object.entries(el.dataset)) {
      if (k === "tuiUse") continue;
      props[k] =
        v === "" || v === "true"
          ? true
          : v === "false"
            ? false
            : /^-?\d+(\.\d+)?$/.test(v)
              ? +v
              : v;
    }
    if (el.id) props.id = el.id;
    mount(el, h(name, props), { replace: true });
  }

  // Builder helpers: TUI.h.box(props?, ...children), TUI.h.t(key), ...
  for (const name of Object.keys(TYPES)) if (name !== "#text") h[name] = (...a) => h(name, ...a);
  const labelled =
    (type, prop) =>
    (first, ...kids) =>
      typeof first === "string" || isTok(first)
        ? h(type, { [prop]: first }, ...kids)
        : h(type, first, ...kids);
  h.tab = labelled("tab", "label");
  h.pane = labelled("pane", "title");
  h.col = (n, ...kids) =>
    typeof n === "number" ? h("col", { col: n }, ...kids) : h("col", n, ...kids);
  h.el = (tag, props, ...kids) =>
    isPlain(props) ? h("el", { ...props, tag }, ...kids) : h("el", { tag }, props, ...kids);
  h.t = (key, vars, fallback) => ({ __t: key, vars, fallback });
  h.use = (name, props, ...kids) => h(name, props, ...kids);

  // ---------------------------------------------------------------- i18n
  //
  // Markup carries the source-language text plus keys:
  //   <span data-i18n="btn.fire">Fire</span>            text (or HTML if the
  //                                                      translation has tags)
  //   <div data-i18n-attr="data-title=box.log; data-tip=tip.log">
  //                                                      any attributes
  // A missing translation keeps the markup's own text, so the source language
  // needs no dictionary. Locale 'pseudo' stretches source text by ~40% with
  // accents to test layouts without a translator.
  //
  // Components are built from the translated markup, so switching locale
  // rebuilds each mounted root from a pristine copy (i18n.mount(root)).

  const ACCENT = {
    a: "á",
    e: "é",
    i: "í",
    o: "ö",
    u: "ü",
    A: "Á",
    E: "É",
    I: "Í",
    O: "Ö",
    U: "Ü",
    c: "ç",
    C: "Ç",
    n: "ñ",
    N: "Ñ",
    y: "ý",
    Y: "Ý",
  };
  function pseudo(str) {
    if (!str) return str;
    let n = 0;
    const out = str.replace(/(<[^>]*>)|(\{[^}]*\})|([^<{]+)/g, (m, tag, v, txt) => {
      if (tag || v) return m;
      n += len(txt.trim());
      return txt.replace(/[aeiouAEIOUcCnNyY]/g, (c) => ACCENT[c]);
    });
    if (!n) return out;
    const extra = Math.max(1, Math.ceil(n * 0.4));
    return `«${out} ${"~".repeat(extra)}»`;
  }

  const i18n = {
    locale: "en",
    source: "en",
    dicts: {},
    roots: [],
    add(locale, dict) {
      this.dicts[locale] = Object.assign(this.dicts[locale] || {}, dict);
      return this;
    },
    /* Look up a key for script-built text. vars fill {name} slots. */
    t(key, vars, fallback) {
      const own = this.dicts[this.locale]?.[key];
      let str = own !== undefined ? own : this.dicts[this.source]?.[key];
      if (str === undefined) str = fallback !== undefined ? fallback : key;
      if (this.locale === "pseudo" && own === undefined) str = pseudo(str);
      if (vars) str = str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
      return str;
    },
    lookup(key, original) {
      const own = this.dicts[this.locale]?.[key];
      if (own !== undefined) return own;
      if (this.locale === this.source) return original;
      if (this.locale === "pseudo") return pseudo(original);
      return original;
    },
    /* Translate data-i18n / data-i18n-attr inside root (before upgrade). */
    apply(root) {
      root = root || doc;
      const els = Array.from(root.querySelectorAll("[data-i18n], [data-i18n-attr]"));
      if (root instanceof Element && root.matches("[data-i18n], [data-i18n-attr]"))
        els.unshift(root);
      for (const el of els) {
        const key = el.dataset.i18n;
        if (key) {
          const v = this.lookup(key, el.innerHTML.trim());
          if (/<[a-z]/i.test(v)) el.innerHTML = v;
          else el.textContent = v;
        }
        if (el.dataset.i18nAttr) {
          for (const pair of el.dataset.i18nAttr.split(";")) {
            const [attr, k] = pair.split("=").map((x) => x.trim());
            if (!attr || !k) continue;
            el.setAttribute(attr, this.lookup(k, el.getAttribute(attr) || ""));
          }
        }
      }
      return root;
    },
    /* Remember root's markup before upgrade so set() can rebuild it. */
    mount(root) {
      this.roots.push({ root, tpl: root.cloneNode(true) });
      return root;
    },
    /* Switch locale: rebuild mounted roots, re-measure, emit 'tui-locale'. */
    set(locale) {
      this.locale = locale;
      doc.documentElement.lang = locale === "pseudo" ? "en-XA" : locale;
      if (!started) return;
      closePopup(null);
      hideTip();
      for (const { root, tpl } of this.roots) {
        const fresh = tpl.cloneNode(true);
        root.replaceChildren(...fresh.childNodes);
        this.apply(root);
        upgrade(root);
      }
      // Scenes hold their text as keys: render each again in the new locale.
      for (const sc of [...scenes]) renderScene(sc);
      refresh();
      emit(doc.documentElement, "tui-locale", { locale });
    },
  };

  // ---------------------------------------------------------------- init

  const upgraders = {
    box: (el) => box(el),
    window: (el) => windowBox(el),
    menu,
    list: menu,
    menubar,
    tabs,
    select,
    table: (el) => table(el),
    progress: (el) => progress(el),
    spinner,
    scroll,
    button,
    hstack,
    vstack,
    grid,
    spacer,
    split: (el) => split(el),
  };

  function upgrade(root) {
    root = root || doc;
    const uses = Array.from(root.querySelectorAll("[data-tui-use]"));
    if (root instanceof Element && root.dataset.tuiUse) uses.unshift(root);
    uses.forEach(useMount);
    const els = Array.from(root.querySelectorAll("[data-tui]"));
    if (root instanceof Element && root.dataset.tui) els.unshift(root);
    for (const el of els) {
      if (el._tuiDone) continue;
      const fn = upgraders[el.dataset.tui];
      if (!fn) continue;
      el._tuiDone = true;
      fn(el);
    }
  }

  /* Re-measure the font and relayout every box (call after changing
     --tui-fs, --tui-font or a border set). */
  function refresh() {
    measure();
    for (const el of boxes) {
      if (!el.isConnected) {
        if (el._tui.ro) el._tui.ro.disconnect();
        boxes.delete(el);
        continue;
      }
      el._tui.drawn = false;
      layout(el);
    }
  }

  // ---------------------------------------------------------------- font size

  /* Current --tui-fs in px (computed on :root). */
  function fontSize() {
    return parseFloat(getComputedStyle(doc.documentElement).getPropertyValue("--tui-fs")) || 14;
  }

  /* Set --tui-fs on :root to px and refresh. */
  function setFontSize(px) {
    doc.documentElement.style.setProperty("--tui-fs", `${px}px`);
    refresh();
  }

  /* Largest whole-px --tui-fs at which cols x rows cells fit the container
     (an element, or the viewport without one), from the measured cell shape;
     clamped to opts.min / opts.max. */
  function fitFontSize(opts) {
    opts = opts || {};
    const el = opts.container;
    const w = el ? el.clientWidth : doc.documentElement.clientWidth;
    const h = el ? el.clientHeight : global.innerHeight;
    const fs = fontSize();
    const ideal = Math.floor(
      Math.min(
        w / ((opts.cols || 80) * (metrics.cw / fs)),
        h / ((opts.rows || 25) * (metrics.ch / fs)),
      ),
    );
    return Math.min(opts.max || Infinity, Math.max(opts.min || 1, ideal));
  }

  /* Auto-fit: keep --tui-fs at fitFontSize(opts) on every window resize and
     font load. opts.onFit({ size, fits }) runs after each fit; fits is false
     when even opts.min is too large. autoFit(false) switches it off and
     leaves the current size. */
  let autoFitOpts = null;
  function applyAutoFit() {
    if (!autoFitOpts) return;
    const o = autoFitOpts;
    const size = fitFontSize(o);
    const free = fitFontSize({ ...o, min: 1, max: Infinity });
    if (size !== fontSize()) setFontSize(size);
    o.onFit?.({ size, fits: free >= size });
  }
  function autoFit(opts) {
    autoFitOpts = opts ? { ...opts } : null;
    applyAutoFit();
  }

  let started = false;
  function init() {
    started = true;
    doc.documentElement.lang = i18n.locale === "pseudo" ? "en-XA" : i18n.locale;
    measure();
    i18n.apply(doc);
    upgrade(doc);
    wrapWide(doc.body);
    new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.type === "characterData") wrapWide(r.target);
        else r.addedNodes.forEach(wrapWide);
      }
    }).observe(doc.body, { childList: true, subtree: true, characterData: true });
    initTooltips();
    if (doc.fonts?.ready)
      doc.fonts.ready.then(() => {
        refresh();
        applyAutoFit();
      });
    let t = 0;
    global.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        refresh();
        applyAutoFit();
      }, 80);
    });
  }

  global.TUI = {
    init,
    refresh,
    upgrade,
    measure,
    metrics,
    fontSize,
    setFontSize,
    fitFontSize,
    autoFit,
    hideTip,
    box,
    update: (el, opts) => box(el, opts),
    redraw: (el) => {
      el._tui.drawn = false;
      layout(el);
    },
    window: windowBox,
    menu,
    menubar,
    tabs,
    select,
    table,
    progress,
    spinner,
    scroll,
    button,
    hstack,
    vstack,
    grid,
    spacer,
    split,
    h,
    mount,
    prefab,
    dialog,
    popupMenu,
    /* Close the open popup menu (it resolves to null); no-op when none is open. */
    closePopup: () => closePopup(null),
    glyphs,
    i18n,
    t: (key, vars, fallback) => i18n.t(key, vars, fallback),
    compensatedLength,
    cells: len,
    fit,
    wrapWide,
  };

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})(window);
