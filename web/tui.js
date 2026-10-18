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
       shadow, pad      boolean, cells of inner padding (default 1) */
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
    if (opts.actions) st.actions = opts.actions;
    if (opts.border) d.border = opts.border;
    else if (!d.border) d.border = "single";
    if (opts.tone) d.tone = opts.tone;
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
      st.frame.setAttribute("aria-hidden", "false");
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
     placed at cell positions; junctions get the tee glyph. */
  function edgeRow(c, left, fill, right, segs, junctions, tee) {
    const cells = Array(c).fill(fill);
    cells[0] = left;
    cells[c - 1] = right;
    for (const x of junctions) if (x > 0 && x < c - 1) cells[x] = tee;
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
          attrs: {
            role: "tab",
            tabindex: i === st.activeTab ? "0" : "-1",
            "aria-selected": String(i === st.activeTab),
          },
          onClick: () => st.selectTab(i, true),
          onKey: (e) => st.tabKey(e, i),
        });
        at += len(text) + 1;
      });
    } else if (st.title) {
      const text = ` ${st.title} `;
      const w = len(text);
      const at =
        st.titleAlign === "center"
          ? Math.max(2, (c - w) >> 1)
          : st.titleAlign === "right"
            ? Math.max(2, c - 2 - w)
            : 2;
      top.push({ at, text, cls: "tui-title" });
    }
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
    f.appendChild(edgeRow(c, g.tl, g.h, g.tr, top, st.junctions, g.tt));
    const rightV = st.hideRightEdge ? " " : g.v;
    const mid = g.v + " ".repeat(Math.max(0, c - 2)) + rightV;
    for (let i = 1; i < r - 1; i++) f.appendChild(div(null, mid));
    if (r > 1) {
      f.appendChild(
        st.hideBottomEdge
          ? div(null, g.bl + " ".repeat(Math.max(0, c - 2)) + g.br)
          : edgeRow(c, g.bl, g.h, g.br, bottom, st.junctions, g.bt),
      );
    }

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
     [disabled] / aria-disabled greys it out. */
  function readItems(container) {
    return Array.from(container.children).map((c) => {
      if (c.tagName === "HR" || c.classList.contains("tui-sep")) return { sep: true };
      return {
        html: c.innerHTML,
        key: c.dataset.key || "",
        value: c.dataset.value !== undefined ? c.dataset.value : c.textContent.trim(),
        disabled: c.hasAttribute("disabled") || c.getAttribute("aria-disabled") === "true",
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
      row.setAttribute("role", kind === "list" ? "option" : "menuitem");
      if (it.disabled) row.setAttribute("aria-disabled", "true");
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
    const ok = (i) => rows[i] && rows[i].getAttribute("aria-disabled") !== "true";
    function set(i) {
      active = i;
      rows.forEach((row, k) => {
        row.classList.toggle("is-active", k === i);
        if (kind === "list") {
          row.setAttribute("aria-selected", String(k === i));
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
      row.addEventListener("mousemove", () => {
        if (kind !== "list" && ok(i) && active !== i) set(i);
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
    el.setAttribute("role", kind === "list" ? "listbox" : "menu");
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
    btn.setAttribute("aria-haspopup", "listbox");
    const label = span("tui-select-label");
    btn.append(label, span("tui-select-arrow", "▾"));
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
    bar.setAttribute("role", "menubar");
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
      p.setAttribute("role", "tabpanel");
    });
    st.selectTab = (i, focus) => {
      st.activeTab = i;
      panes.forEach((p, k) => {
        p.hidden = k !== i;
      });
      st.frame.querySelectorAll(".tui-tab").forEach((t, k) => {
        t.classList.toggle("is-active", k === i);
        t.setAttribute("tabindex", k === i ? "0" : "-1");
        t.setAttribute("aria-selected", String(k === i));
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
     or from TUI.table({ columns: [{ label, width, align }], rows: [[…]] }). */
  function table(src, opts) {
    let columns, rows, el;
    if (src instanceof Element) {
      const ths = Array.from(src.querySelectorAll("thead th"));
      columns = ths.map((th) => ({
        label: th.textContent.trim(),
        width: th.dataset.width && +th.dataset.width,
        align: th.dataset.align,
      }));
      rows = Array.from(src.querySelectorAll("tbody tr")).map((tr) =>
        Array.from(tr.children).map((td) => td.textContent.trim()),
      );
      el = div();
      for (const a of src.attributes) if (a.name !== "data-tui") el.setAttribute(a.name, a.value);
      src.replaceWith(el);
    } else {
      opts = src || {};
      columns = opts.columns;
      rows = opts.rows;
      el = div();
      if (opts.border) el.dataset.border = opts.border;
    }
    columns.forEach((c, k) => {
      if (!c.width) c.width = Math.max(len(c.label), ...rows.map((r) => len(String(r[k] ?? ""))));
    });
    // Interior width: each column is ' text ' plus one separator between.
    const inner = columns.reduce((s, c) => s + c.width + 2, 0) + columns.length - 1;
    const joints = [];
    let x = 0;
    columns.forEach((c, k) => {
      x += c.width + 2;
      if (k < columns.length - 1) {
        joints.push(x + 1);
        x += 1;
      }
    });

    el.classList.add("tui-table");
    el.tabIndex = 0;
    el.setAttribute("role", "grid");
    el.textContent = "";
    box(el, { cols: inner + 2, rows: "auto", pad: 0 });
    const st = el._tui;
    st.junctions = joints;
    const head = div("tui-row is-head");
    const rule = div("tui-sep");
    rule.dataset.joints = joints.join(",");
    const dataRows = rows.map(() => div("tui-row is-data"));
    st.inner.append(head, rule, ...dataRows);

    function fillRow(row, cells, v) {
      row.textContent = "";
      columns.forEach((c, k) => {
        if (k) row.appendChild(span("tui-col-sep", v));
        row.append(` ${fit(cells[k] ?? "", c.width, c.align)} `);
      });
    }
    st.hooks.push((g) => {
      fillRow(
        head,
        columns.map((c) => c.label),
        g.v,
      );
      dataRows.forEach((row, i) => {
        fillRow(row, rows[i], g.v);
      });
    });

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
        emit(el, "tui-select", { index: i, row: rows[i] });
      });
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") set(Math.min(rows.length - 1, active + 1));
      else if (e.key === "ArrowUp") set(Math.max(0, active - 1));
      else if (e.key === "Enter" && active >= 0)
        emit(el, "tui-select", { index: active, row: rows[active] });
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
    el.setAttribute("role", "progressbar");
    if (value !== undefined) el.dataset.value = value;
    const v = el.dataset.value;
    const cols = num(el.dataset.cols, 20);
    if (v === "indeterminate") {
      el.removeAttribute("aria-valuenow");
      el._tuiTick = 0;
      animated.add(el);
      tickProgress(el);
      return el;
    }
    animated.delete(el);
    const p = Math.min(1, Math.max(0, num(v, 0)));
    el.setAttribute("aria-valuenow", Math.round(p * 100));
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
    el.append(
      span("tui-fill", (ascii ? "#" : "█").repeat(full) + part),
      span("tui-track", (ascii ? "-" : "░").repeat(Math.max(0, rest))),
    );
    if (label) el.append(span("tui-pct", label));
    return el;
  }
  function tickProgress(el) {
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
    vbar.setAttribute("aria-hidden", "true");
    hbar.setAttribute("aria-hidden", "true");
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

  /* TUI.dialog({ title, text | content, buttons, cols, border, tone, defaultIndex })
     Resolves to the clicked button's label, or null on Escape. */
  function dialog(opts) {
    opts = opts || {};
    const buttons = opts.buttons || ["OK"];
    return new Promise((resolve) => {
      const prevFocus = doc.activeElement;
      const overlay = div("tui-overlay tui-font");
      const win = div("tui-dialog");
      win.setAttribute("role", "dialog");
      win.setAttribute("aria-modal", "true");
      if (opts.title) win.setAttribute("aria-label", opts.title);
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
    tipEl.setAttribute("role", "tooltip");
    tipEl.textContent = lines.join("\n");
    doc.body.appendChild(tipEl);
    box(tipEl, {
      cols: w + 4,
      rows: lines.length + 2,
      border: target.dataset.tipBorder || "rounded",
    });
    const r = target.getBoundingClientRect();
    placeAt(tipEl, r.left, r.bottom, r);
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
  };

  function upgrade(root) {
    root = root || doc;
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
    if (doc.fonts?.ready) doc.fonts.ready.then(refresh);
    let t = 0;
    global.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(refresh, 80);
    });
  }

  global.TUI = {
    init,
    refresh,
    upgrade,
    measure,
    metrics,
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
    dialog,
    popupMenu,
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
