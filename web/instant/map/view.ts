/**
 * Vector hex map (plan §6), ported from the map viewer's vector renderer
 * (`map_viewer_vector.html`, generated from `ref/mapviewer/`): flat-top hex
 * prisms on the btlib10x odd-q offset grid, free rotation, view tilt and
 * elevation to scale (a level is 6 m on a 30 m hex, TW pp. 36, 167). Faces are
 * painted back to front; every edge is stroked once by the last shape that
 * has it. Added here: terrain fills, overlays, facing triangles, unit banners
 * and click picking.
 */
import type { Facing, HexCoord, TerrainType } from "btlib10x";

import { UI_THEME } from "../theme";

const { MARK: M, ARROW: A } = UI_THEME;

export interface MapSource {
  readonly width: number;
  readonly height: number;
  terrainAt(hex: HexCoord): TerrainType;
  levelAt(hex: HexCoord): number;
}

/** A unit drawn as an upright glyph banner. */
export interface Banner {
  readonly id: string;
  readonly hex: HexCoord;
  readonly facing: Facing;
  /** 1 / 2, or 0 for a neutral hull. */
  readonly team: number;
  /** Second line: armor pips or a status word. */
  readonly sub: string;
  readonly active?: boolean;
  readonly ghost?: boolean;
}

/** One banded hex: the team colour and the facings drawn (one trapezoid each). */
export interface BandHex {
  readonly team: number;
  readonly facings: readonly Facing[];
}

export interface Overlays {
  /** "col,row" → label drawn on the face (e.g. MP cost). */
  reachable?: ReadonlyMap<string, string>;
  /**
   * "col,row" → a unit may stand there with these facings: a band inside the
   * hex edges, one trapezoid per available facing, in the team's colour. The
   * face is cut into six triangles (centre to hexside), so a click picks the
   * hex and the facing of its triangle; the hovered trapezoid is highlighted.
   */
  bands?: ReadonlyMap<string, BandHex>;
  /** The facing already chosen on a banded hex, drawn in the select colour. */
  chosen?: { readonly hex: string; readonly facing: Facing } | null;
  targets?: ReadonlySet<string>;
  target?: string | null;
  selected?: string | null;
  los?: readonly [HexCoord, HexCoord] | null;
  wreckage?: ReadonlySet<string>;
  clubs?: ReadonlySet<string>;
}

const FACINGS: readonly Facing[] = ["n", "ne", "se", "s", "sw", "nw"];
const SQ3 = Math.sqrt(3);
const HEX_R = 2.1; // circumradius in font sizes: corner to corner = 7 cells of 0.6
const LEVEL_H = (SQ3 * 6) / 30;
const LABEL_FS = 0.62;
const LABEL_INSET = 0.12;
const FONT = '"Bt10x Mono", Consolas, monospace';
const CORNERS = Array.from(
  { length: 6 },
  (_, j) => [Math.cos((j * Math.PI) / 3), Math.sin((j * Math.PI) / 3)] as const,
);
const NORMALS = Array.from(
  { length: 6 },
  (_, j) => [Math.cos(((j + 0.5) * Math.PI) / 3), Math.sin(((j + 0.5) * Math.PI) / 3)] as const,
);
export const TILTS = [40, 65, 90];
/** Tilt range and step of the wheel over the north indicator. */
const TILT_INIT = 25;
const TILT_MIN = 5;
const TILT_MAX = 90;
const TILT_STEP = 5;
/** North indicator: radius and gap to the canvas's top-right corner, CSS px. */
const HUD_R = 16;
const HUD_PAD = 6;


/** Banner metrics (CSS px) at a map font size: font, line height, box height, pole.
 *  The sign's text keeps one size whatever the zoom; only the pole grows with the hexes. */
const bannerMetrics = (fs: number) => {
  // the page's own text size (the kit's --tui-fs), so it follows the A / A buttons
  const bfs = Number.parseFloat(css("--tui-fs", "")) || 14;
  const chh = bfs * 1.175;
  return { fs: bfs, chh, bh: chh * 2.1, pole: Math.max(chh * 0.9, HEX_R * fs * 0.45) };
};

const key = (h: HexCoord) => `${h.col},${h.row}`;
const worldCenter = (col: number, row: number): [number, number] => [
  (col - 1) * 1.5,
  (row - 1 + ((col & 1) === 0 ? 0.5 : 0)) * SQ3,
];
const vertexKey = (x: number, y: number) => `${Math.round(x * 2)},${Math.round((y * 2) / SQ3)}`;

interface HexShape {
  col: number;
  row: number;
  x: number;
  y: number;
  keys: string[];
  level: number;
  drawn: number;
}

interface Shape {
  polys: [number, number][][];
  segs: { key: string; a: [number, number]; b: [number, number] }[];
  label?: { key: string; text: string; h: HexShape; lv: number };
  hex: HexShape;
  top?: boolean;
}

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private src: MapSource | null = null;
  angle = 0;
  tilt = TILT_INIT;
  /** Font size driving the hex size; null = fit to the canvas. */
  fs: number | null = null;
  /** Pan offset in CSS px (middle-button drag). */
  panX = 0;
  panY = 0;
  overlays: Overlays = {};
  banners: Banner[] = [];
  /** Draw every hex's CCRR coordinate on its face; off, only the hovered hex's. */
  showCoords = false;
  /** `facing`: the facing triangle of the hex's top face, null on a wall or banner. */
  onPick: ((hex: HexCoord, ev: MouseEvent, facing: Facing | null) => void) | null = null;
  /** Hover text for a hex, shown in the kit tooltip under the pointer; null = none. */
  tipFor: ((hex: HexCoord) => string | null) | null = null;
  private drawn: Shape[] = [];
  private bannerBoxes: { hex: HexCoord; x0: number; y0: number; x1: number; y1: number }[] = [];
  private world = { cx: 0, cy: 0 };
  private hover: string | null = null;
  private hoverFacing: Facing | null = null;
  /** Hex whose tooltip shows, the zero-size point the kit tooltip hangs from
   *  and where that point was last put (`"x,y,anchor"`). */
  private tipHex: HexCoord | null = null;
  private tipAnchor: HTMLElement | null = null;
  private tipPlace = "";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    let drag: { start: number; angle: number; moved: boolean } | null = null;
    const pointerAngle = (e: PointerEvent) => {
      const v = this.view();
      const r = canvas.getBoundingClientRect();
      return (
        (Math.atan2(e.clientX - r.left - v.W / 2, -(e.clientY - r.top - v.H / 2) / v.sq) * 180) /
        Math.PI
      );
    };
    // Middle (scroll) button drag pans the map.
    let pan: { x: number; y: number; px: number; py: number } | null = null;
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no browser autoscroll
    });
    // The north indicator has its own controls; nothing under it is picked.
    const onHud = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return this.onIndicator(e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener("contextmenu", (e) => {
      if (onHud(e)) e.preventDefault();
    });
    canvas.addEventListener("pointerdown", (e) => {
      this.hideTip();
      if (onHud(e)) {
        e.preventDefault();
        if (e.button === 0) this.north();
        else if (e.button === 1) this.fit();
        else if (e.button === 2) this.turn(e.shiftKey ? -60 : 60);
        return;
      }
      if (e.button === 1) {
        e.preventDefault();
        this.unfit();
        pan = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      drag = { start: pointerAngle(e), angle: this.angle, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (pan || drag) this.hideTip();
      if (pan) {
        this.panX = pan.px + e.clientX - pan.x;
        this.panY = pan.py + e.clientY - pan.y;
        this.render();
        return;
      }
      if (drag) {
        const delta = pointerAngle(e) - drag.start;
        if (Math.abs(delta) > 4) drag.moved = true;
        if (drag.moved) {
          const angle = (((drag.angle - delta) % 360) + 360) % 360;
          this.anchored(null, () => {
            this.angle = angle;
          });
          this.render();
        }
        return;
      }
      const hud = onHud(e);
      canvas.style.cursor = hud ? "pointer" : "";
      const p = hud ? null : this.pickAtEvent(e);
      const k = p ? key(p.hex) : null;
      const f = p?.facing ?? null;
      this.showTip(p?.hex ?? null);
      if (k !== this.hover || f !== this.hoverFacing) {
        this.hover = k;
        this.hoverFacing = f;
        this.render();
      }
    });
    const end = (e: PointerEvent) => {
      if (pan) {
        pan = null;
        return;
      }
      const d = drag;
      drag = null;
      if (d && !d.moved && e.type === "pointerup") {
        const p = this.pickAtEvent(e);
        if (p) this.onPick?.(p.hex, e, p.facing);
      }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => {
      this.hideTip();
      this.hover = null;
      this.hoverFacing = null;
      this.render();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.hideTip();
        if (onHud(e)) {
          this.tiltBy(e.deltaY < 0 ? TILT_STEP : -TILT_STEP);
          return;
        }
        const r = canvas.getBoundingClientRect();
        this.zoom(e.deltaY < 0 ? 2 : -2, [e.clientX - r.left, e.clientY - r.top]);
      },
      { passive: false },
    );
  }

  setMap(src: MapSource): void {
    this.src = src;
    const cs: [number, number][] = [];
    for (let col = 1; col <= src.width; col++)
      for (let row = 1; row <= src.height; row++) cs.push(worldCenter(col, row));
    const xs = cs.map((c) => c[0]);
    const ys = cs.map((c) => c[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    this.world = { cx, cy };
  }

  /** Forget the hovered hex (the canvas moved to another screen without a pointerleave). */
  clearHover(): void {
    this.hover = null;
    this.hoverFacing = null;
    this.hideTip();
  }

  /** Hide the hex tooltip, if one shows (other kit tooltips are left alone). */
  hideTip(): void {
    if (this.tipHex === null) return;
    this.tipHex = null;
    window.TUI.hideTip();
  }

  /** Tip the hovered hex (`tipFor`); a new hex replaces it. */
  private showTip(hex: HexCoord | null): void {
    const text = hex && this.tipFor ? this.tipFor(hex) : null;
    if (!hex || !text) {
      this.hideTip();
      return;
    }
    if (this.tipHex && key(this.tipHex) === key(hex)) return;
    this.tipHex = hex;
    if (!this.tipAnchor) {
      this.tipAnchor = document.createElement("div");
      Object.assign(this.tipAnchor.style, {
        position: "fixed",
        width: "0",
        height: "0",
        pointerEvents: "none",
      });
      document.body.appendChild(this.tipAnchor);
    }
    this.tipAnchor.dataset.tip = text;
    this.tipPlace = "";
    this.placeTip(this.view());
  }

  /**
   * Hang the tip beside its hex, opening toward the canvas centre: a hex in
   * the upper-right quadrant gets the tip's top-right corner, and so on. The
   * corner sits one hex radius to the side, clear of the hex's marks; the kit
   * keeps the tip inside the viewport. Re-placed only when the spot moves.
   */
  private placeTip(v: ReturnType<MapView["view"]>): void {
    const hex = this.tipHex;
    const el = this.tipAnchor;
    if (!hex || !el || !this.src) return;
    const c = worldCenter(hex.col, hex.row);
    const [x, y] = v.proj(
      v.rot([c[0] - this.world.cx, c[1] - this.world.cy]),
      this.src.levelAt(hex),
    );
    const east = x >= v.W / 2;
    const anchor = `${y < v.H / 2 ? "n" : "s"}${east ? "e" : "w"}`;
    const r = this.canvas.getBoundingClientRect();
    const px = Math.round(r.left + x + (east ? -v.R : v.R));
    const py = Math.round(r.top + y);
    const place = `${px},${py},${anchor}`;
    if (place === this.tipPlace) return;
    this.tipPlace = place;
    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
    el.dataset.tipAnchor = anchor;
    // The kit opens its tooltip on mouseover of a [data-tip] element.
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  }

  rotate(dir: number): void {
    const a = this.angle / 60;
    const steps = dir > 0 ? Math.floor(a + 1e-6) + 1 : Math.ceil(a - 1e-6) - 1;
    this.anchored(null, () => {
      this.angle = (((steps * 60) % 360) + 360) % 360;
    });
    this.render();
  }

  /** Zoom about a canvas point (CSS px), the view centre by default. */
  zoom(step: number, at: readonly [number, number] | null = null): void {
    const fs = this.fs ?? this.fitFs();
    this.anchored(at, () => {
      this.fs = Math.max(4, Math.min(48, fs + step));
    });
    this.render();
  }

  /**
   * The canvas grew or shrank by `k` with the page font: scale a fixed zoom
   * and the pan alike so the same part of the map stays framed. A fitted view
   * re-fits on its own.
   */
  rescale(k: number): void {
    if (!Number.isFinite(k) || k <= 0 || k === 1) return;
    if (this.fs !== null) this.fs *= k;
    this.panX *= k;
    this.panY *= k;
  }

  /**
   * Apply a view change (zoom, rotation) keeping the ground point under a
   * canvas point (the view centre by default) fixed on screen, by re-panning.
   */
  private anchored(at: readonly [number, number] | null, change: () => void): void {
    if (!this.src) {
      change();
      return;
    }
    const v0 = this.view();
    const [px, py] = at ?? [v0.W / 2, v0.H / 2];
    const xr = (px - v0.ox) / v0.R;
    const yr = (py - v0.oy) / (v0.R * v0.sq);
    const t = (this.angle * Math.PI) / 180;
    const w: [number, number] = [
      xr * Math.cos(t) - yr * Math.sin(t),
      xr * Math.sin(t) + yr * Math.cos(t),
    ];
    change();
    const v1 = this.view();
    const [qx, qy] = v1.proj(v1.rot(w), 0);
    this.panX += px - qx;
    this.panY += py - qy;
  }

  /**
   * Leave fit-to-view for a fixed size, keeping the view as it is: a view
   * placed by hand (pan, zoom, focus on a unit) must not re-fit on a turn.
   */
  private unfit(): void {
    if (this.fs !== null) return;
    const fs = this.fitFs();
    this.anchored(null, () => {
      this.fs = fs;
    });
  }

  /** Pan so a hex's centre sits in the middle of the canvas. */
  centerOn(hex: HexCoord): void {
    if (!this.src) return;
    this.unfit();
    const v = this.view();
    const w = worldCenter(hex.col, hex.row);
    const [x, y] = v.proj(
      v.rot([w[0] - this.world.cx, w[1] - this.world.cy]),
      this.src.levelAt(hex),
    );
    this.panX += v.W / 2 - x;
    this.panY += v.H / 2 - y;
    this.render();
  }

  /**
   * Turn, zoom and pan so all `hexes` fit a canvas rectangle (CSS px) as large
   * as they can, with room for their banners. Turns only in 30° steps, and
   * only when that gains more than a tenth in size over the current angle.
   */
  fitHexes(
    hexes: readonly HexCoord[],
    rect: { x0: number; y0: number; x1: number; y1: number },
  ): void {
    if (!this.src || hexes.length === 0) return;
    const sq = Math.max(Math.sin((this.tilt * Math.PI) / 180), 1e-3);
    const pts = hexes.map((hex) => {
      const w = worldCenter(hex.col, hex.row);
      return [w[0] - this.world.cx, w[1] - this.world.cy] as const;
    });
    const inner = (fs: number) => {
      const R = HEX_R * fs;
      const m = bannerMetrics(fs);
      return {
        x0: rect.x0 + R,
        x1: rect.x1 - R,
        y0: rect.y0 + m.pole + m.bh,
        y1: rect.y1 - R * sq,
      };
    };
    /** Largest size (font px) at which the hexes fit, at a map angle. */
    const sizeAt = (deg: number) => {
      const t = (deg * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const xs = pts.map(([x, y]) => x * c + y * s);
      const ys = pts.map(([x, y]) => (-x * s + y * c) * sq);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      let fs = this.fs ?? this.fitFs();
      for (let i = 0; i < 4; i++) {
        const box = inner(fs);
        const w = Math.max(1, box.x1 - box.x0);
        const h = Math.max(1, box.y1 - box.y0);
        fs = Math.min(spanX > 0 ? w / (spanX * HEX_R) : 48, spanY > 0 ? h / (spanY * HEX_R) : 48);
        fs = Math.max(4, Math.min(48, fs));
      }
      return fs;
    };
    let angle = this.angle;
    let fs = sizeAt(angle);
    for (let deg = 0; deg < 360; deg += 30) {
      const f = sizeAt(deg);
      if (f > fs * 1.1) {
        fs = f;
        angle = deg;
      }
    }
    this.angle = angle;
    this.fs = fs;
    const box = inner(fs);
    const v = this.view();
    const on = hexes.map((hex) => {
      const c = worldCenter(hex.col, hex.row);
      return v.proj(v.rot([c[0] - this.world.cx, c[1] - this.world.cy]), this.src!.levelAt(hex));
    });
    const mx = (Math.min(...on.map((p) => p[0])) + Math.max(...on.map((p) => p[0]))) / 2;
    const my = (Math.min(...on.map((p) => p[1])) + Math.max(...on.map((p) => p[1]))) / 2;
    this.panX += (box.x0 + box.x1) / 2 - mx;
    this.panY += (box.y0 + box.y1) / 2 - my;
    this.render();
  }

  /**
   * Turn, zoom and pan so hexes `a` and `b` lie on a diagonal of a canvas
   * rectangle (CSS px), with room for their banners: the diagonal (of the four
   * corner pairings) that needs the least turn wins.
   */
  frame(a: HexCoord, b: HexCoord, rect: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.src) return;
    const wa = worldCenter(a.col, a.row);
    const wb = worldCenter(b.col, b.row);
    const dx = wb[0] - wa[0];
    const dy = wb[1] - wa[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      this.centerOn(a);
      return;
    }
    const sq = Math.max(Math.sin((this.tilt * Math.PI) / 180), 1e-3);
    const inner = (fs: number) => {
      const R = HEX_R * fs;
      const m = bannerMetrics(fs);
      return {
        x0: rect.x0 + R,
        x1: rect.x1 - R,
        y0: rect.y0 + m.pole + m.bh,
        y1: rect.y1 - R * sq,
      };
    };
    let fs = this.fs ?? this.fitFs();
    let box = inner(fs);
    // banner room depends on the size: settle it in a few rounds
    for (let i = 0; i < 4; i++) {
      box = inner(fs);
      const w = Math.max(1, box.x1 - box.x0);
      const h = Math.max(1, box.y1 - box.y0);
      // on screen, |dx'| : |dy'| = w : h, with dy' squashed by the tilt
      const phi = Math.atan2(h / sq, w);
      fs = Math.max(4, Math.min(48, w / (len * Math.cos(phi)) / HEX_R));
    }
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const along = (Math.atan2(dy, dx) * 180) / Math.PI;
    let best = this.angle;
    let turn = Infinity;
    for (const [sx, sy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const phi = (Math.atan2((sy * h) / sq, sx * w) * 180) / Math.PI;
      const t = (((along - phi) % 360) + 360) % 360;
      const d = Math.abs(((t - this.angle + 540) % 360) - 180);
      if (d < turn) {
        turn = d;
        best = t;
      }
    }
    this.angle = best;
    this.fs = fs;
    const v = this.view();
    const at = (hex: HexCoord) => {
      const c = worldCenter(hex.col, hex.row);
      return v.proj(v.rot([c[0] - this.world.cx, c[1] - this.world.cy]), this.src!.levelAt(hex));
    };
    const pa = at(a);
    const pb = at(b);
    this.panX += (box.x0 + box.x1) / 2 - (pa[0] + pb[0]) / 2;
    this.panY += (box.y0 + box.y1) / 2 - (pa[1] + pb[1]) / 2;
    this.render();
  }

  cycleTilt(): void {
    const i = TILTS.indexOf(this.tilt) ?? 0;
    this.tilt = TILTS[(i + 1) % TILTS.length]!;
    this.render();
  }

  reset(): void {
    this.panX = 0;
    this.panY = 0;
    this.angle = 0;
    this.fs = null;
    this.tilt = TILT_INIT;
    this.render();
  }

  /** Turn back to north-up about the view centre. */
  north(): void {
    this.anchored(null, () => {
      this.angle = 0;
    });
    this.render();
  }

  /** Turn by a number of degrees about the view centre. */
  turn(deg: number): void {
    this.anchored(null, () => {
      this.angle = (((this.angle + deg) % 360) + 360) % 360;
    });
    this.render();
  }

  /** Change the tilt within TILT_MIN..TILT_MAX about the view centre. */
  tiltBy(deg: number): void {
    const tilt = Math.max(TILT_MIN, Math.min(TILT_MAX, this.tilt + deg));
    if (tilt === this.tilt) return;
    this.anchored(null, () => {
      this.tilt = tilt;
    });
    this.render();
  }

  /**
   * Fit the whole map to the canvas at the current angle and tilt. Zero pan
   * with no fixed font size is exactly the fitted, centred placement.
   */
  fit(): void {
    this.panX = 0;
    this.panY = 0;
    this.fs = null;
    this.render();
  }

  /** Is a canvas point (CSS px) on the north indicator? */
  private onIndicator(px: number, py: number): boolean {
    const W = this.canvas.clientWidth || 300;
    return Math.hypot(px - (W - HUD_R - HUD_PAD), py - (HUD_R + HUD_PAD)) <= HUD_R;
  }

  /**
   * Projected extent of the map at the current angle and tilt, in circumradii
   * from the projection origin: every hex corner on the ground and at its
   * level, so elevation counts only where it stands. `banner` is the highest
   * banner base (Infinity with none), for headroom.
   */
  private extent() {
    const rad = (d: number) => (d * Math.PI) / 180;
    const sq = Math.max(Math.sin(rad(this.tilt)), 1e-3);
    const el = LEVEL_H * Math.cos(rad(this.tilt));
    const t = rad(this.angle);
    const c = Math.cos(t);
    const s = Math.sin(t);
    const rot = (x: number, y: number): [number, number] => [x * c + y * s, -x * s + y * c];
    const corners = CORNERS.map(([x, y]) => rot(x, y));
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let banner = Infinity;
    const src = this.src;
    if (!src) return { x0: -1, x1: 1, y0: -1, y1: 1, banner };
    for (let col = 1; col <= src.width; col++)
      for (let row = 1; row <= src.height; row++) {
        const w = worldCenter(col, row);
        const [x, y] = rot(w[0] - this.world.cx, w[1] - this.world.cy);
        const up = src.levelAt({ col, row }) * el;
        for (const [dx, dy] of corners) {
          const py = (y + dy) * sq;
          x0 = Math.min(x0, x + dx);
          x1 = Math.max(x1, x + dx);
          y0 = Math.min(y0, py, py - up);
          y1 = Math.max(y1, py, py - up);
        }
      }
    for (const b of this.banners) {
      const w = worldCenter(b.hex.col, b.hex.row);
      const y = rot(w[0] - this.world.cx, w[1] - this.world.cy)[1];
      banner = Math.min(banner, y * sq - src.levelAt(b.hex) * el);
    }
    return { x0, x1, y0, y1, banner };
  }

  /** Top of the fitted box (circumradii) at a font size: the map or a banner's top. */
  private fitTop(e: ReturnType<MapView["extent"]>, fs: number): number {
    const m = bannerMetrics(fs);
    return Math.min(e.y0, e.banner - (m.pole + m.bh) / (HEX_R * fs));
  }

  /** Font size at which the whole map and its banners fit the canvas. */
  private fitFs(e = this.extent()): number {
    const W = this.canvas.clientWidth || 300;
    const H = this.canvas.clientHeight || 200;
    const at = (top: number) => Math.min(W / (HEX_R * (e.x1 - e.x0)), H / (HEX_R * (e.y1 - top)));
    // banners keep a minimum size, so their headroom is not linear in fs: iterate
    let fs = at(e.y0);
    for (let i = 0; i < 3; i++) fs = at(this.fitTop(e, fs));
    return Math.max(3, fs);
  }

  private view() {
    const e = this.extent();
    const fs = this.fs ?? this.fitFs(e);
    const R = HEX_R * fs;
    const rad = (d: number) => (d * Math.PI) / 180;
    const sq = Math.max(Math.sin(rad(this.tilt)), 1e-3);
    const EL = LEVEL_H * R * Math.cos(rad(this.tilt));
    const t = rad(this.angle);
    const c = Math.cos(t);
    const s = Math.sin(t);
    const rot = ([x, y]: readonly [number, number]): [number, number] => [
      x * c + y * s,
      -x * s + y * c,
    ];
    const W = this.canvas.clientWidth || 300;
    const H = this.canvas.clientHeight || 200;
    // centre the box; a fitted view also takes in the banners' headroom
    const top = this.fs === null ? this.fitTop(e, fs) : e.y0;
    const ox = W / 2 - ((e.x0 + e.x1) / 2) * R + this.panX;
    const oy = H / 2 - ((top + e.y1) / 2) * R + this.panY;
    const proj = ([x, y]: readonly [number, number], h: number): [number, number] => [
      ox + x * R,
      oy + y * R * sq - h * EL,
    ];
    return {
      fs,
      R,
      EL,
      sq,
      W,
      H,
      ox,
      oy,
      rot,
      proj,
      corners: CORNERS.map(rot),
      normals: NORMALS.map(rot),
    };
  }

  private shapes(v: ReturnType<MapView["view"]>): Shape[] {
    const src = this.src!;
    const { rot, proj, corners, normals } = v;
    const list: HexShape[] = [];
    for (let col = 1; col <= src.width; col++)
      for (let row = 1; row <= src.height; row++) {
        const w = worldCenter(col, row);
        const [x, y] = rot([w[0] - this.world.cx, w[1] - this.world.cy]);
        const keys = CORNERS.map(([dx, dy]) => vertexKey(w[0] + dx, w[1] + dy));
        const level = src.levelAt({ col, row });
        list.push({ col, row, x, y, keys, level, drawn: level });
      }
    const at = (h: HexShape, j: number, lv: number) =>
      proj([h.x + corners[j]![0], h.y + corners[j]![1]], lv);
    const edge = (h: HexShape, j: number, lv: number) => {
      const [k0, k1] = [h.keys[j]!, h.keys[(j + 1) % 6]!].sort();
      return { key: `e:${k0}|${k1}:${lv}`, a: at(h, j, lv), b: at(h, (j + 1) % 6, lv) };
    };
    const ring = (h: HexShape, lv: number) => Array.from({ length: 6 }, (_, j) => edge(h, j, lv));
    const label = (h: HexShape, lv: number) => ({
      key: `${h.col},${h.row}`,
      text: `${String(h.col).padStart(2, "0")}${String(h.row).padStart(2, "0")}`,
      h,
      lv,
    });
    const out: Shape[] = [];
    for (const h of list) {
      out.push({
        polys: [Array.from({ length: 6 }, (_, j) => at(h, j, 0))],
        segs: ring(h, 0),
        label: label(h, 0),
        hex: h,
        top: true,
      });
    }
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const h of list) {
      const L = h.drawn;
      if (!L) continue;
      const polys: [number, number][][] = [];
      const segs: Shape["segs"] = [];
      normals.forEach((n, j) => {
        if (n[1] <= 1e-9) return;
        const j1 = (j + 1) % 6;
        polys.push([at(h, j, L), at(h, j1, L), at(h, j1, 0), at(h, j, 0)]);
        segs.push(edge(h, j, L), edge(h, j, 0));
        for (const i of [j, j1])
          for (let k = 0; k < L; k++)
            segs.push({ key: `v:${h.keys[i]}:${k}`, a: at(h, i, k), b: at(h, i, k + 1) });
      });
      out.push({ polys, segs, hex: h });
      out.push({
        polys: [Array.from({ length: 6 }, (_, j) => at(h, j, L))],
        segs: ring(h, L),
        label: label(h, L),
        hex: h,
        top: true,
      });
    }
    return out;
  }

  /** Resize the backing store to the element and paint. */
  render(): void {
    if (!this.src) return;
    const d = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    if (W === 0 || H === 0) return;
    if (this.canvas.width !== Math.round(W * d)) this.canvas.width = Math.round(W * d);
    if (this.canvas.height !== Math.round(H * d)) this.canvas.height = Math.round(H * d);
    const v = this.view();
    this.placeTip(v);
    const ctx = this.ctx;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = css("--ia-map-bg", "#141414");
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = Math.max(1, v.fs * 0.06);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const edgeColor = css("--ia-map-edge", "#cfcfcf");
    const list = this.shapes(v);
    const segOwner = new Map<string, number>();
    list.forEach((s, i) => {
      for (const g of s.segs) segOwner.set(g.key, i);
    });
    const team = (n: number) => css(`--ia-team${n}`, n === 1 ? "#4fa3ff" : "#ff6b5a");
    list.forEach((s, i) => {
      const k = `${s.hex.col},${s.hex.row}`;
      for (const p of s.polys) {
        ctx.beginPath();
        p.forEach(([x, y], j) => {
          if (j) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        if (s.top) {
          ctx.fillStyle = css(`--ia-t-${this.src!.terrainAt(s.hex)}`, "#1e1e1e");
          ctx.fill();
          const tint = this.tintFor(k);
          if (tint) {
            ctx.fillStyle = tint;
            ctx.fill();
          }
        } else {
          ctx.fillStyle = css("--ia-map-wall", "#0b0b0b");
          ctx.fill();
        }
      }
      ctx.strokeStyle = edgeColor;
      ctx.beginPath();
      for (const g of s.segs)
        if (segOwner.get(g.key) === i) {
          ctx.moveTo(g.a[0], g.a[1]);
          ctx.lineTo(g.b[0], g.b[1]);
        }
      ctx.stroke();
      const dz = s.top ? this.overlays.bands?.get(k) : undefined;
      if (dz !== undefined) {
        const chosen = this.overlays.chosen?.hex === k ? this.overlays.chosen.facing : null;
        const hot = this.hover === k ? this.hoverFacing : null;
        this.drawBand(s.polys[0]!, team(dz.team), dz.facings, chosen, hot);
      }
      if (s.top && s.label && (this.hover === k || (this.showCoords && v.fs >= 6)))
        this.drawLabel(v, s, d, this.hover === k);
      if (s.top) this.drawMarks(v, s, k, d);
    });
    this.drawn = list;
    this.drawLos(v);
    this.drawFacings(v);
    this.drawBanners(v);
    this.drawHud(v);
  }

  private tintFor(k: string): string | null {
    const o = this.overlays;
    const alpha = (c: string, a: number) =>
      `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;
    if (o.target === k) return alpha(css("--ia-target", "#ffd24a"), 0.55);
    if (o.selected === k) return alpha(css("--ia-select", "#ffffff"), 0.35);
    if (this.hover === k) return alpha(css("--ia-select", "#ffffff"), 0.15);
    return null;
  }

  /**
   * Facing band: a ring 1/8 of the hex's corner-to-corner width inside its
   * edges, cut into one trapezoid per hexside. A trapezoid is drawn for each
   * available facing (the hexside the unit would face), filled with the team
   * colour and outlined in a brighter tint of it; the chosen facing is filled
   * in the select colour and the hovered one lightened with a thick outline.
   */
  private drawBand(
    poly: readonly (readonly [number, number])[],
    color: string,
    facings: readonly Facing[],
    chosen: Facing | null = null,
    hot: Facing | null = null,
  ): void {
    const ctx = this.ctx;
    const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
    const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
    // 1/8 of the width (2 circumradii) is 1/4 of the radius
    const inner = poly.map(([x, y]) => [cx + (x - cx) * 0.75, cy + (y - cy) * 0.75] as const);
    ctx.save();
    ctx.lineJoin = "miter";
    const base = Math.max(1, ctx.lineWidth);
    const select = css("--ia-select", "#ffffff");
    // the chosen and hovered trapezoids last, so their outline is on top
    const order = [...facings].sort((p, q) => rank(p) - rank(q));
    function rank(f: Facing) {
      return f === hot ? 2 : f === chosen ? 1 : 0;
    }
    for (const f of order) {
      // Corner j sits at j·60° (y down), so facing i's hexside runs from corner i+4 to i+5.
      const i = FACINGS.indexOf(f);
      const a = (i + 4) % 6;
      const b = (i + 5) % 6;
      ctx.beginPath();
      for (const [x, y] of [poly[a]!, poly[b]!, inner[b]!, inner[a]!]) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = f === chosen ? select : color;
      ctx.fill();
      if (f === hot) {
        ctx.fillStyle = "color-mix(in srgb, white 45%, transparent)";
        ctx.fill();
      }
      ctx.strokeStyle =
        f === hot || f === chosen ? select : `color-mix(in srgb, ${color} 55%, white)`;
      ctx.lineWidth = f === hot ? base * 2.5 : base;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The hovered hex's label is drawn brighter and at least 8 px, as it is often the only one. */
  private drawLabel(v: ReturnType<MapView["view"]>, s: Shape, d: number, hot: boolean): void {
    const ctx = this.ctx;
    const lab = s.label!;
    const top = v.normals.reduce((best, n, j) => (n[1] < v.normals[best]![1] ? j : best), 0);
    const n = v.normals[top]!;
    const r = [-n[1], n[0]] as const;
    const size = hot ? Math.max(8, v.fs * LABEL_FS) : v.fs * LABEL_FS;
    ctx.font = `${size}px ${FONT}`;
    ctx.textBaseline = "top";
    const tw = ctx.measureText(lab.text).width;
    const apo = SQ3 / 2 - (LABEL_INSET * Math.max(v.fs, size / LABEL_FS)) / v.R;
    const [ex, ey] = v.proj([lab.h.x + n[0] * apo, lab.h.y + n[1] * apo], lab.lv);
    const a = r[0];
    const b = r[1] * v.sq;
    const c = -n[0];
    const dd = -n[1] * v.sq;
    ctx.save();
    ctx.setTransform(d * a, d * b, d * c, d * dd, d * (ex - (a * tw) / 2), d * (ey - (b * tw) / 2));
    ctx.fillStyle = hot ? css("--ia-map-mark", "#f0f0f0") : css("--ia-map-label", "#9a9a9a");
    ctx.fillText(lab.text, 0, 0);
    ctx.restore();
  }

  /**
   * Hex marks below the face centre: the reachable MP lies on the top face,
   * flattened by the tilt like the labels so it stays on the face at any
   * tilt; wreckage `%` and club `!` stand upright there, like the banners.
   */
  private drawMarks(v: ReturnType<MapView["view"]>, s: Shape, k: string, d: number): void {
    const mp = this.overlays.reachable?.get(k);
    const items: string[] = [];
    if (this.overlays.wreckage?.has(k)) items.push("%");
    if (this.overlays.clubs?.has(k)) items.push("!");
    if (!mp && items.length === 0) return;
    const ctx = this.ctx;
    const [x, y] = v.proj([s.hex.x, s.hex.y + (v.fs * 0.35) / v.R], s.hex.drawn);
    const text = [mp, ...items].filter(Boolean).join(" ");
    ctx.save();
    ctx.font = `${Math.max(8, v.fs * 0.8)}px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = css("--ia-map-mark", "#f0f0f0");
    // Lay the whole run out once so the flat and upright parts keep their places.
    let cx = -ctx.measureText(text).width / 2;
    if (mp) {
      ctx.setTransform(d, 0, 0, d * v.sq, d * x, d * y);
      ctx.fillText(mp, cx, 0);
      cx += ctx.measureText(`${mp} `).width;
    }
    if (items.length) {
      ctx.setTransform(d, 0, 0, d, d * x, d * y);
      ctx.textBaseline = "alphabetic";
      ctx.fillText(items.join(" "), cx, 0);
    }
    ctx.restore();
  }

  private drawLos(v: ReturnType<MapView["view"]>): void {
    const los = this.overlays.los;
    if (!los || !this.src) return;
    const p = (h: HexCoord) => {
      const w = worldCenter(h.col, h.row);
      return v.proj(v.rot([w[0] - this.world.cx, w[1] - this.world.cy]), this.src!.levelAt(h));
    };
    const [a, b] = [p(los[0]), p(los[1])];
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = css("--ia-target", "#ffd24a");
    ctx.setLineDash([v.fs * 0.4, v.fs * 0.3]);
    ctx.lineWidth = Math.max(1.5, v.fs * 0.1);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1] - v.fs);
    ctx.lineTo(b[0], b[1] - v.fs);
    ctx.stroke();
    ctx.restore();
  }

  /** Units as sharp triangles lying on their hex face, pointing along the facing. */
  private drawFacings(v: ReturnType<MapView["view"]>): void {
    if (!this.src) return;
    const ctx = this.ctx;
    const h = 0.5; // 1/4 the hex's corner-to-corner width (one circumradius)
    const hw = h * 0.26;
    const nudge = SQ3 / 16; // shifted 1/16 hex toward the facing edge
    const items = this.banners.map((b) => {
      const w = worldCenter(b.hex.col, b.hex.row);
      return { b, w, y: v.rot([w[0] - this.world.cx, w[1] - this.world.cy])[1] };
    });
    items.sort((a, b) => a.y - b.y);
    for (const { b, w } of items) {
      const t = (FACINGS.indexOf(b.facing) * Math.PI) / 3;
      const f = [Math.sin(t), -Math.cos(t)] as const; // world y points south
      const pt = (along: number, across: number) =>
        v.proj(
          v.rot([
            w[0] - this.world.cx + f[0] * (along + nudge) - f[1] * across,
            w[1] - this.world.cy + f[1] * (along + nudge) + f[0] * across,
          ]),
          this.src!.levelAt(b.hex),
        );
      const color =
        b.team === 0 ? css("--ia-hull", "#8a8a8a") : css(`--ia-team${b.team}`, "#4fa3ff");
      ctx.save();
      if (b.ghost) ctx.globalAlpha = 0.55;
      const tri = [pt(h / 2, 0), pt(-h / 2, hw), pt(-h / 2, -hw)];
      const path = () => {
        ctx.beginPath();
        for (const [x, y] of tri) ctx.lineTo(x, y);
        ctx.closePath();
      };
      const edge = Math.max(1, v.fs * 0.06); // the hex wireframe's width
      ctx.lineJoin = "miter";
      ctx.strokeStyle = color;
      if (b.active) {
        // the acting unit's border doubles, growing outward only: a wide
        // stroke clipped to outside the triangle
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, v.W, v.H);
        tri.forEach(([x, y], j) => {
          if (j) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.clip("evenodd");
        path();
        ctx.lineWidth = edge * 3;
        ctx.stroke();
        ctx.restore();
      }
      path();
      ctx.fillStyle = `color-mix(in srgb, ${color} 45%, black)`;
      ctx.fill();
      ctx.lineWidth = edge;
      if (b.team === 0 || b.ghost) ctx.setLineDash([v.fs * 0.25, v.fs * 0.2]);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Units as upright signs on a pole, back to front (plan §6, starter design). */
  private drawBanners(v: ReturnType<MapView["view"]>): void {
    if (!this.src) return;
    const ctx = this.ctx;
    const { fs, chh, bh, pole } = bannerMetrics(v.fs);
    ctx.font = `${fs}px ${FONT}`;
    const cw = fs * 0.6;
    const items = this.banners.map((b) => {
      const w = worldCenter(b.hex.col, b.hex.row);
      const p = v.rot([w[0] - this.world.cx, w[1] - this.world.cy]);
      return { b, p, base: v.proj(p, this.src!.levelAt(b.hex)) };
    });
    items.sort((a, b) => a.p[1] - b.p[1]);
    this.bannerBoxes = [];
    /** Signs already on each hex: a later one stands on a taller pole above them. */
    const stacked = new Map<string, number>();
    for (const { b, base } of items) {
      const k = key(b.hex);
      const tier = stacked.get(k) ?? 0;
      stacked.set(k, tier + 1);
      const l1 = ` ${b.id} `;
      const l2 = ` ${b.sub} `;
      const cols = Math.max(l1.length, l2.length);
      const bw = cols * cw;
      const x0 = base[0] - bw / 2;
      const y0 = base[1] - pole - bh - tier * (bh + chh * 0.3);
      const color =
        b.team === 0 ? css("--ia-hull", "#8a8a8a") : css(`--ia-team${b.team}`, "#4fa3ff");
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, fs * 0.09);
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.lineTo(base[0], y0 + bh);
      ctx.stroke();
      ctx.fillStyle = css("--ia-banner-bg", "#0d0d0d");
      ctx.fillRect(x0, y0, bw, bh);
      if (b.team === 0 || b.ghost) ctx.setLineDash([fs * 0.25, fs * 0.2]);
      ctx.lineWidth = b.active ? Math.max(2, fs * 0.18) : Math.max(1, fs * 0.09);
      ctx.strokeRect(x0, y0, bw, bh);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, bw, chh);
      ctx.fillStyle = css("--ia-banner-ink", "#0d0d0d");
      ctx.textBaseline = "middle";
      ctx.fillText(l1, x0, y0 + chh / 2 + 1);
      ctx.fillStyle = color;
      ctx.fillText(l2, x0, y0 + chh * 1.55);
      ctx.restore();
      this.bannerBoxes.push({ hex: b.hex, x0, y0, x1: x0 + bw, y1: y0 + bh });
    }
  }

  /** North arrow, and to its left the view state: rotation, zoom against fit, tilt. */
  private drawHud(v: ReturnType<MapView["view"]>): void {
    const ctx = this.ctx;
    const fs = 12;
    const r = HUD_R;
    const cx = v.W - r - HUD_PAD;
    const cy = r + HUD_PAD;
    const t = (this.angle * Math.PI) / 180;
    // world north (0, -1) after the view rotation, squashed by the tilt
    let nx = -Math.sin(t);
    let ny = -Math.cos(t) * v.sq;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    ctx.save();
    ctx.fillStyle = css("--ia-banner-bg", "#0d0d0d");
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css("--ia-map-edge", "#cfcfcf");
    ctx.lineWidth = 1;
    ctx.stroke();
    const tipX = cx + nx * (r - 3);
    const tipY = cy + ny * (r - 3);
    ctx.fillStyle = css("--ia-team2", "#ff6b5a");
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(cx - ny * 4, cy + nx * 4);
    ctx.lineTo(cx + ny * 4, cy - nx * 4);
    ctx.closePath();
    ctx.fill();
    ctx.font = `bold ${fs}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = css("--ia-map-mark", "#f0f0f0");
    ctx.fillText("N", cx - nx * 7, cy - ny * 7);
    // view state at the indicator's top-left, outlined to read over any terrain
    const zoom = this.fs === null ? 1 : this.fs / this.fitFs();
    const text = `${A.rotate}${Math.round(this.angle) % 360}° ${M.times}${zoom.toFixed(1)} ${A.tilt}${this.tilt}°`;
    ctx.font = `${fs * 1.2}px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#000";
    ctx.strokeText(text, cx - r - 4, cy - r);
    ctx.fillStyle = css("--ia-map-mark", "#f0f0f0"); // the N's colour
    ctx.fillText(text, cx - r - 4, cy - r);
    ctx.restore();
  }

  private pickAtEvent(e: MouseEvent): { hex: HexCoord; facing: Facing | null } | null {
    const r = this.canvas.getBoundingClientRect();
    return this.pickAt(e.clientX - r.left, e.clientY - r.top);
  }

  hexAt(px: number, py: number): HexCoord | null {
    return this.pickAt(px, py)?.hex ?? null;
  }

  /**
   * The hex under a canvas point and, on its top face, the facing of the
   * triangle (centre to hexside) the point is in; null facing on a banner or
   * a wall.
   */
  pickAt(px: number, py: number): { hex: HexCoord; facing: Facing | null } | null {
    for (let i = this.bannerBoxes.length - 1; i >= 0; i--) {
      const b = this.bannerBoxes[i]!;
      if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) return { hex: b.hex, facing: null };
    }
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const s = this.drawn[i]!;
      if (!s.polys.some((p) => inside(px, py, p))) continue;
      const hex = { col: s.hex.col, row: s.hex.row };
      return { hex, facing: s.top ? facingAt(px, py, s.polys[0]!) : null };
    }
    return null;
  }
}

/** Facing whose triangle (centre, corners i+4 and i+5, as in `drawBand`) holds a point. */
function facingAt(px: number, py: number, poly: readonly (readonly [number, number])[]): Facing {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const i = FACINGS.findIndex((_, i) =>
    inside(px, py, [[cx, cy], poly[(i + 4) % 6]!, poly[(i + 5) % 6]!]),
  );
  return FACINGS[Math.max(0, i)]!;
}

function inside(px: number, py: number, poly: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
