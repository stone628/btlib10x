/**
 * Camera policy for map clips and prompts (docs/INSTANT.md, Camera): what a
 * clip must show (its must-see spots) and where on the canvas it can show it
 * (the clear rectangles between the HUD overlays). Pure apart from reading
 * the overlays' boxes from the DOM.
 */
import type { BattleState, HexCoord } from "btlib10x";

import { JUMP_LIFT } from "../map/anim";
import type { MustSee, Rect } from "../map/view";
import type { Beat } from "./beats";

/** Spots one beat must show; `at` gives a unit's hex as the clip has it then. */
export function beatNeeds(b: Beat, at: (unitId: string) => HexCoord | null): MustSee[] {
  const unit = (id: string, tick = false): MustSee[] => {
    const hex = at(id);
    return hex ? [{ hex, sign: id, tick }] : [];
  };
  switch (b.kind) {
    case "move": {
      // the sign travels the whole path; the landing also ticks (a fall)
      const hexes = b.legs.flatMap((l) => (l.kind === "enter" ? [l.from, l.to] : []));
      const out: MustSee[] = hexes.map((hex, i) => ({
        hex,
        sign: b.unitId,
        tick: i === hexes.length - 1,
      }));
      // a turn in place
      return out.length > 0 ? out : unit(b.unitId);
    }
    case "jump":
      // the sign rises on the arc (map/anim.ts, JUMP_LIFT)
      return [
        { hex: b.from, sign: b.unitId, lift: JUMP_LIFT },
        { hex: b.to, sign: b.unitId, tick: true, lift: JUMP_LIFT },
      ];
    case "volley":
    case "physical":
      return [...unit(b.attackerId, b.kind === "physical"), ...unit(b.targetId, true)];
    case "ams":
      return [...unit(b.unitId, true), ...unit(b.attackerId)];
    default:
      return unit(b.unitId, true);
  }
}

/**
 * Must-see spots of a whole clip, beat by beat: each beat's spots with units
 * where the clip has put them by then (a move ends at its last hex).
 */
export function clipNeeds(
  beats: readonly Beat[],
  before: BattleState,
): { beat: Beat; needs: MustSee[] }[] {
  const where = new Map<string, HexCoord>();
  const at = (id: string) => where.get(id) ?? before.units[id]?.position ?? null;
  return beats.map((beat) => {
    const needs = beatNeeds(beat, at);
    if (beat.kind === "move") {
      const enters = beat.legs.filter((l) => l.kind === "enter");
      const end = enters[enters.length - 1];
      if (end && end.kind === "enter") where.set(beat.unitId, end.to);
    } else if (beat.kind === "jump") where.set(beat.unitId, beat.to);
    return { beat, needs };
  });
}

/** Overlays that lie over the battle map: drawers, edge tabs, orders, DONE / SKIP, frame and LOGS tab. */
const OVER_MAP = ".ia-drawer, .ia-tab-edge, .ia-topmenu, .ia-done, .ia-frame, .ia-fill";

/**
 * The clear parts of the map canvas (CSS px, canvas coordinates): the canvas
 * clipped to the viewport, less every overlay box over it, as the maximal
 * empty rectangles between them (small slivers dropped). `skip` leaves an
 * overlay out (a drawer about to close).
 */
export function safeRects(
  canvas: HTMLCanvasElement,
  skip: (el: Element) => boolean = () => false,
): Rect[] {
  const c = canvas.getBoundingClientRect();
  if (c.width === 0 || c.height === 0) return [];
  const bound: Rect = {
    x0: Math.max(c.left, 0),
    y0: Math.max(c.top, 0),
    x1: Math.min(c.right, window.innerWidth),
    y1: Math.min(c.bottom, window.innerHeight),
  };
  if (bound.x1 - bound.x0 < 8 || bound.y1 - bound.y0 < 8) return [];
  const root = canvas.closest(".ia-battle") ?? document;
  const obstacles: Rect[] = [];
  for (const el of Array.from(root.querySelectorAll(OVER_MAP))) {
    if (skip(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const o = {
      x0: Math.max(r.left, bound.x0),
      y0: Math.max(r.top, bound.y0),
      x1: Math.min(r.right, bound.x1),
      y1: Math.min(r.bottom, bound.y1),
    };
    if (o.x1 - o.x0 > 1 && o.y1 - o.y0 > 1) obstacles.push(o);
  }
  const rects = emptyRects(bound, obstacles).map((r) => ({
    x0: r.x0 - c.left,
    y0: r.y0 - c.top,
    x1: r.x1 - c.left,
    y1: r.y1 - c.top,
  }));
  return rects;
}

/**
 * Maximal axis-aligned rectangles inside `bound` that cross no obstacle,
 * built on the grid of obstacle edges; at most a few dozen candidates, so the
 * brute force is cheap. Rectangles under a fifth of the largest's area, or
 * thinner than 48 px, are dropped.
 */
export function emptyRects(bound: Rect, obstacles: readonly Rect[]): Rect[] {
  const xs = [bound.x0, bound.x1, ...obstacles.flatMap((o) => [o.x0, o.x1])]
    .filter((x) => x >= bound.x0 && x <= bound.x1)
    .sort((a, b) => a - b)
    .filter((x, i, a) => i === 0 || x - a[i - 1]! > 0.5);
  const ys = [bound.y0, bound.y1, ...obstacles.flatMap((o) => [o.y0, o.y1])]
    .filter((y) => y >= bound.y0 && y <= bound.y1)
    .sort((a, b) => a - b)
    .filter((y, i, a) => i === 0 || y - a[i - 1]! > 0.5);
  const clear = (r: Rect) =>
    !obstacles.some((o) => o.x0 < r.x1 && o.x1 > r.x0 && o.y0 < r.y1 && o.y1 > r.y0);
  const found: Rect[] = [];
  for (let a = 0; a < xs.length; a++)
    for (let b = a + 1; b < xs.length; b++)
      for (let c = 0; c < ys.length; c++)
        for (let d = c + 1; d < ys.length; d++) {
          const r = { x0: xs[a]!, x1: xs[b]!, y0: ys[c]!, y1: ys[d]! };
          if (r.x1 - r.x0 < 48 || r.y1 - r.y0 < 48 || !clear(r)) continue;
          found.push(r);
        }
  const within = (a: Rect, b: Rect) => a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
  const maximal = found.filter((r) => !found.some((o) => o !== r && within(r, o)));
  const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);
  const top = Math.max(0, ...maximal.map(area));
  return maximal.filter((r) => area(r) >= top / 5).sort((a, b) => area(b) - area(a));
}

/** The largest clear rectangle, or the whole canvas when the overlays leave none. */
export function largestRect(canvas: HTMLCanvasElement, rects: readonly Rect[]): Rect {
  return rects[0] ?? { x0: 0, y0: 0, x1: canvas.clientWidth, y1: canvas.clientHeight };
}
