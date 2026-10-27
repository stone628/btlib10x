/**
 * Vector hex map (plan §6), ported from the map viewer's vector renderer
 * (`map_viewer_vector.html`, generated from `ref/mapviewer/`): flat-top hex
 * prisms on the btlib10x odd-q offset grid, free rotation, view tilt and
 * elevation to scale (a level is 6 m on a 30 m hex, TW pp. 36, 167). Faces are
 * painted back to front; every edge is stroked once by the last shape that
 * has it. Added here: terrain fills, overlays, unit banners and click picking.
 */
import type { Facing, HexCoord, TerrainType } from "btlib10x";

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

export interface Overlays {
  /** "col,row" → label drawn on the face (e.g. MP cost). */
  reachable?: ReadonlyMap<string, string>;
  /** "col,row" → team whose deploy zone this is. */
  deploy?: ReadonlyMap<string, number>;
  targets?: ReadonlySet<string>;
  target?: string | null;
  selected?: string | null;
  los?: readonly [HexCoord, HexCoord] | null;
  wreckage?: ReadonlySet<string>;
  clubs?: ReadonlySet<string>;
}

const FACINGS: readonly Facing[] = ["n", "ne", "se", "s", "sw", "nw"];
const ARROWS = ["↑", "↗", "↘", "↓", "↙", "↖"];
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
  tilt = TILTS[0]!;
  /** Font size driving the hex size; null = fit to the canvas. */
  fs: number | null = null;
  /** Pan offset in CSS px (middle-button drag). */
  panX = 0;
  panY = 0;
  overlays: Overlays = {};
  banners: Banner[] = [];
  /** Draw each hex's CCRR coordinate on its face. */
  showCoords = true;
  onPick: ((hex: HexCoord, ev: MouseEvent) => void) | null = null;
  private drawn: Shape[] = [];
  private bannerBoxes: { hex: HexCoord; x0: number; y0: number; x1: number; y1: number }[] = [];
  private world = { cx: 0, cy: 0, radius: 1, maxLevel: 0 };
  private hover: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    let drag: { start: number; angle: number; moved: boolean } | null = null;
    const pointerAngle = (e: PointerEvent) => {
      const v = this.view();
      const r = canvas.getBoundingClientRect();
      return (
        (Math.atan2(e.clientX - r.left - v.ox, -(e.clientY - r.top - v.oy) / v.sq) * 180) / Math.PI
      );
    };
    // Middle (scroll) button drag pans the map.
    let pan: { x: number; y: number; px: number; py: number } | null = null;
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no browser autoscroll
    });
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        pan = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      drag = { start: pointerAngle(e), angle: this.angle, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
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
          this.angle = (((drag.angle - delta) % 360) + 360) % 360;
          this.render();
        }
        return;
      }
      const h = this.hexAtEvent(e);
      const k = h ? key(h) : null;
      if (k !== this.hover) {
        this.hover = k;
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
        const h = this.hexAtEvent(e);
        if (h) this.onPick?.(h, e);
      }
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.render();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom(e.deltaY < 0 ? 2 : -2);
      },
      { passive: false },
    );
  }

  setMap(src: MapSource): void {
    this.src = src;
    const cs: [number, number][] = [];
    let maxLevel = 0;
    for (let col = 1; col <= src.width; col++)
      for (let row = 1; row <= src.height; row++) {
        cs.push(worldCenter(col, row));
        maxLevel = Math.max(maxLevel, src.levelAt({ col, row }));
      }
    const xs = cs.map((c) => c[0]);
    const ys = cs.map((c) => c[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = Math.max(...cs.map(([x, y]) => Math.hypot(x - cx, y - cy))) + 1;
    this.world = { cx, cy, radius, maxLevel };
  }

  rotate(dir: number): void {
    const a = this.angle / 60;
    const steps = dir > 0 ? Math.floor(a + 1e-6) + 1 : Math.ceil(a - 1e-6) - 1;
    this.angle = (((steps * 60) % 360) + 360) % 360;
    this.render();
  }

  zoom(step: number): void {
    const fs = this.fs ?? this.fitFs();
    this.fs = Math.max(4, Math.min(48, fs + step));
    this.render();
  }

  cycleTilt(): void {
    const i = TILTS.indexOf(this.tilt);
    this.tilt = TILTS[(i + 1) % TILTS.length]!;
    this.render();
  }

  reset(): void {
    this.panX = 0;
    this.panY = 0;
    this.angle = 0;
    this.fs = null;
    this.tilt = TILTS[0]!;
    this.render();
  }

  /** Extent of the rotated hex centres, in circumradii, around the map centre. */
  private bounds(angle: number) {
    const t = (angle * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const src = this.src;
    if (src) {
      for (let col = 1; col <= src.width; col++)
        for (let row = 1; row <= src.height; row++) {
          const [wx, wy] = worldCenter(col, row);
          const x = (wx - this.world.cx) * c + (wy - this.world.cy) * s;
          const y = -(wx - this.world.cx) * s + (wy - this.world.cy) * c;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    }
    return { x0: x0 - 1, x1: x1 + 1, y0: y0 - 1, y1: y1 + 1 };
  }

  /** Font size at which the whole map fits the canvas at the current rotation. */
  private fitFs(): number {
    const W = this.canvas.clientWidth || 300;
    const H = this.canvas.clientHeight || 200;
    const rad = (d: number) => (d * Math.PI) / 180;
    const sq = Math.max(Math.sin(rad(this.tilt)), 1e-3);
    const el = LEVEL_H * Math.cos(rad(this.tilt));
    const b = this.bounds(this.angle);
    // room above for the banners on the top row
    const byW = W / ((b.x1 - b.x0) * HEX_R);
    const byH = H / (HEX_R * ((b.y1 - b.y0) * sq + this.world.maxLevel * el + 1.6));
    return Math.max(3, Math.min(byW, byH));
  }

  private view() {
    const fs = this.fs ?? this.fitFs();
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
    const b = this.bounds(this.angle);
    const ox = W / 2 - ((b.x0 + b.x1) / 2) * R + this.panX;
    const oy =
      H / 2 -
      ((b.y0 + b.y1) / 2) * R * sq +
      (this.world.maxLevel * EL) / 2 +
      R * 0.8 * sq +
      this.panY;
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
          const tint = this.tintFor(k, team);
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
      if (s.top && s.label && this.showCoords && v.fs >= 6) this.drawLabel(v, s, d);
      if (s.top) this.drawMarks(v, s, k);
    });
    this.drawn = list;
    this.drawLos(v);
    this.drawBanners(v);
    this.drawHud(v);
  }

  private tintFor(k: string, team: (n: number) => string): string | null {
    const o = this.overlays;
    const alpha = (c: string, a: number) =>
      `color-mix(in srgb, ${c} ${Math.round(a * 100)}%, transparent)`;
    if (o.target === k) return alpha(css("--ia-target", "#ffd24a"), 0.55);
    if (o.selected === k) return alpha(css("--ia-select", "#ffffff"), 0.35);
    if (o.reachable?.has(k)) return alpha(css("--ia-reach", "#7ee787"), 0.35);
    const dz = o.deploy?.get(k);
    if (dz !== undefined) return alpha(team(dz), 0.3);
    if (this.hover === k) return alpha(css("--ia-select", "#ffffff"), 0.15);
    return null;
  }

  private drawLabel(v: ReturnType<MapView["view"]>, s: Shape, d: number): void {
    const ctx = this.ctx;
    const lab = s.label!;
    const top = v.normals.reduce((best, n, j) => (n[1] < v.normals[best]![1] ? j : best), 0);
    const n = v.normals[top]!;
    const r = [-n[1], n[0]] as const;
    ctx.font = `${v.fs * LABEL_FS}px ${FONT}`;
    ctx.textBaseline = "top";
    const tw = ctx.measureText(lab.text).width;
    const apo = SQ3 / 2 - (LABEL_INSET * v.fs) / v.R;
    const [ex, ey] = v.proj([lab.h.x + n[0] * apo, lab.h.y + n[1] * apo], lab.lv);
    const a = r[0];
    const b = r[1] * v.sq;
    const c = -n[0];
    const dd = -n[1] * v.sq;
    ctx.save();
    ctx.setTransform(d * a, d * b, d * c, d * dd, d * (ex - (a * tw) / 2), d * (ey - (b * tw) / 2));
    ctx.fillStyle = css("--ia-map-label", "#9a9a9a");
    ctx.fillText(lab.text, 0, 0);
    ctx.restore();
  }

  /** Reachable MP, wreckage and club marks: upright text at the face centre. */
  private drawMarks(v: ReturnType<MapView["view"]>, s: Shape, k: string): void {
    const marks: string[] = [];
    const mp = this.overlays.reachable?.get(k);
    if (mp) marks.push(mp);
    if (this.overlays.wreckage?.has(k)) marks.push("%");
    if (this.overlays.clubs?.has(k)) marks.push("!");
    if (marks.length === 0) return;
    const ctx = this.ctx;
    const [x, y] = v.proj([s.hex.x, s.hex.y], s.hex.drawn);
    ctx.font = `${Math.max(8, v.fs * 0.8)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = css("--ia-map-mark", "#f0f0f0");
    ctx.fillText(marks.join(" "), x, y + v.fs * 0.35);
    ctx.textAlign = "left";
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

  /** Units as upright signs on a pole, back to front (plan §6, starter design). */
  private drawBanners(v: ReturnType<MapView["view"]>): void {
    if (!this.src) return;
    const ctx = this.ctx;
    const fs = Math.max(9, v.fs * 0.85);
    ctx.font = `${fs}px ${FONT}`;
    const cw = fs * 0.6;
    const chh = fs * 1.175;
    const items = this.banners.map((b) => {
      const w = worldCenter(b.hex.col, b.hex.row);
      const p = v.rot([w[0] - this.world.cx, w[1] - this.world.cy]);
      return { b, p, base: v.proj(p, this.src!.levelAt(b.hex)) };
    });
    items.sort((a, b) => a.p[1] - b.p[1]);
    this.bannerBoxes = [];
    for (const { b, base } of items) {
      const dir = (FACINGS.indexOf(b.facing) * 60 - this.angle + 360) % 360;
      const arrow = ARROWS[Math.round(dir / 60) % 6]!;
      const l1 = ` ${b.id} ${arrow} `;
      const l2 = ` ${b.sub} `;
      const cols = Math.max(l1.length, l2.length);
      const bw = cols * cw;
      const bh = chh * 2.1;
      const pole = Math.max(chh * 0.9, v.R * 0.45);
      const x0 = base[0] - bw / 2;
      const y0 = base[1] - pole - bh;
      const color =
        b.team === 0 ? css("--ia-hull", "#8a8a8a") : css(`--ia-team${b.team}`, "#4fa3ff");
      ctx.save();
      if (b.ghost) ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, fs * 0.09);
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.lineTo(base[0], y0 + bh);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(base[0], base[1], Math.max(1.5, fs * 0.15), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
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
      this.bannerBoxes.push({ hex: b.hex, x0, y0, x1: x0 + bw, y1: y0 + bh + pole });
    }
  }

  /** North arrow and the view state: rotation, zoom against fit, tilt. */
  private drawHud(v: ReturnType<MapView["view"]>): void {
    const ctx = this.ctx;
    const fs = 12;
    const r = 16;
    const cx = v.W - r - 6;
    const cy = r + 6;
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
    const zoom = this.fs === null ? 1 : this.fs / this.fitFs();
    const text = `${Math.round(this.angle) % 360}°  ×${zoom.toFixed(1)}  ${this.tilt}°`;
    ctx.font = `${fs}px ${FONT}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillStyle = css("--ia-map-label", "#9a9a9a");
    ctx.fillText(text, v.W - 6, cy + r + 4);
    ctx.restore();
  }

  private hexAtEvent(e: MouseEvent): HexCoord | null {
    const r = this.canvas.getBoundingClientRect();
    return this.hexAt(e.clientX - r.left, e.clientY - r.top);
  }

  hexAt(px: number, py: number): HexCoord | null {
    for (let i = this.bannerBoxes.length - 1; i >= 0; i--) {
      const b = this.bannerBoxes[i]!;
      if (px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) return b.hex;
    }
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const s = this.drawn[i]!;
      if (s.polys.some((p) => inside(px, py, p))) return { col: s.hex.col, row: s.hex.row };
    }
    return null;
  }
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
