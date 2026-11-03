/**
 * Map animations: plays one step's beats (`battle/beats.ts`) on the map view
 * as a clip of tweens (redrawn every frame while active) and one-shot state
 * changes on the shown banners. The engine has already applied the step; the
 * clip only lets the map catch up, and `skip()` jumps it to the end. A small
 * "decor" lane (the hand-off ring) runs on its own and never holds play.
 */
import type { Facing, HexCoord, UnitDamageState } from "btlib10x";

import {
  type Beat,
  beatTime,
  isReel,
  legTimes,
  type Shot,
  SPEED_K,
  shotGap,
  T,
} from "../battle/beats";
import { locName, t } from "../i18n";
import type { Banner, BannerPose, FxContext, FxDraw, MapView } from "./view";

/** Highest point of a jump's arc, in hex circumradii. */
export const JUMP_LIFT = 1.6;

const FACINGS: readonly Facing[] = ["n", "ne", "se", "s", "sw", "nw"];
const angleOf = (f: Facing) => (FACINGS.indexOf(f) * Math.PI) / 3;
/** Shortest turn from `a` to `b`, radians. */
const turnTo = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const easeOut = (p: number) => 1 - (1 - p) ** 3;
const mix = (c: string, a: number) =>
  `color-mix(in srgb, ${c} ${Math.round(Math.max(0, Math.min(1, a)) * 100)}%, transparent)`;

type MutableBanner = { -readonly [K in keyof Banner]: Banner[K] };
type MutablePose = { -readonly [K in keyof BannerPose]: BannerPose[K] };

/** A banner's state change a beat asks for; the caller renders the second line. */
export type LookChange =
  | { readonly damage: UnitDamageState }
  | { readonly prone: true }
  | { readonly off: true }
  | { readonly removed: "hull" | "destroyed" };

export interface ClipInput {
  /** Banners as the step found them (before the commit). */
  readonly banners: readonly Banner[];
  readonly beats: readonly Beat[];
  /** Time factor: 1 Full, 0.5 Fast. */
  readonly k: number;
  /** Reduced motion: cuts and fades instead of travel, shakes and rises. */
  readonly reduced: boolean;
  /** The banner's second line after a change (null: keep it). */
  readonly sub: (unitId: string, change: LookChange) => string | null;
  /**
   * Camera follow (a reel too big to show whole): before each beat it picks,
   * `run` frames that beat and the clip waits `gap` ms (unscaled) for it.
   */
  readonly follow?:
    | {
        readonly picks: (b: Beat) => boolean;
        readonly run: (b: Beat) => void;
        readonly gap: number;
      }
    | undefined;
}

interface Item {
  at: number;
  dur: number;
  fn?: (p: number, ms: number) => void;
  once?: () => void;
  done?: boolean;
}

interface Lane {
  t0: number;
  items: Item[];
  end: number;
}

/** What a clip shows: the attack reel, or one unit moving, jumping or else acting. */
export type ClipStatus =
  | { readonly kind: "reel" }
  | { readonly kind: "move" | "jump" | "other"; readonly unitId: string };

export function clipStatus(beats: readonly Beat[]): ClipStatus | null {
  if (isReel(beats)) return { kind: "reel" };
  const m = beats.find((b) => b.kind === "move" || b.kind === "jump");
  if (m && (m.kind === "move" || m.kind === "jump")) return { kind: m.kind, unitId: m.unitId };
  const first = beats[0];
  return first && "unitId" in first ? { kind: "other", unitId: first.unitId } : null;
}

export class MapAnimator {
  private clip: Lane | null = null;
  private decor: Lane[] = [];
  private shown: MutableBanner[] = [];
  private poses = new Map<string, MutablePose>();
  private layers: { under: FxDraw[]; mid: FxDraw[]; over: FxDraw[] } = {
    under: [],
    mid: [],
    over: [],
  };
  private tickRows = new Map<string, number>();
  private done: (() => void)[] = [];
  private view: MapView | null = null;
  /** What the playing clip shows, for the orders panel; null when idle. */
  status: ClipStatus | null = null;
  /** When the clock stopped (`pause`), else null. */
  private pausedAt: number | null = null;

  /** A clip is playing, paused or not (play holds, commit keys skip it). */
  get busy(): boolean {
    return this.clip !== null;
  }

  /** The clock is stopped: the map keeps the frozen frame until `resume`. */
  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /**
   * Hold the clip's start for `ms` (the camera glides into place first). Only
   * right after `play`, before any of it has run past its first frames.
   */
  delayStart(ms: number): void {
    if (this.clip) this.clip.t0 = performance.now() + ms;
  }

  /** Stop the clock (the battle menu is open); nothing moves until `resume`. */
  pause(): void {
    if (this.pausedAt !== null || !this.clip) return;
    this.pausedAt = performance.now();
  }

  /** Restart the clock where `pause` stopped it. */
  resume(): void {
    const at = this.pausedAt;
    if (at === null) return;
    this.pausedAt = null;
    const gap = performance.now() - at;
    if (this.clip) this.clip.t0 += gap;
    for (const lane of this.decor) lane.t0 += gap;
    this.view?.wake(true);
  }

  /** The banners the map shows while a clip plays. */
  banners(): Banner[] {
    return this.shown;
  }

  /** Run `fn` when the current clip ends or is skipped (at once when none plays). */
  whenDone(fn: () => void): void {
    if (this.clip) this.done.push(fn);
    else fn();
  }

  /** Attach to a view: it calls back every frame while anything animates. */
  attach(view: MapView): void {
    this.view = view;
    view.onFrame = (now) => this.frame(now);
  }

  play(view: MapView, input: ClipInput): void {
    this.skip();
    this.attach(view);
    this.shown = input.banners.map((b) => ({ ...b }));
    this.tickRows.clear();
    const seq = new Builder(this, input);
    let at = 0;
    const follow = input.follow;
    for (const b of input.beats) {
      if (follow?.picks(b)) {
        seq.items.push({ at: at * input.k, dur: 0, once: () => follow.run(b) });
        at += follow.gap / input.k;
      }
      at = seq.beat(b, at);
    }
    const items = seq.items;
    if (items.length === 0) {
      this.shown = [];
      return;
    }
    const end = Math.max(...items.map((i) => i.at + i.dur));
    this.status = clipStatus(input.beats);
    this.clip = { t0: performance.now(), items, end };
    view.banners = this.shown;
    view.wake(true);
  }

  /** A ring growing out of a hex once, without holding play (actor hand-off). */
  ping(view: MapView, hex: HexCoord, team: number, k: number, reduced: boolean): void {
    this.attach(view);
    const color = (f: FxContext) => f.color(`--ia-team${team}`, "#4fa3ff");
    const dur = (reduced ? 300 : T.ping) * k;
    const fn = (p: number) =>
      this.layers.under.push((f) => {
        f.hexPath(hex, reduced ? 0.95 : 0.6 + 0.8 * easeOut(p));
        f.ctx.strokeStyle = mix(color(f), 1 - p);
        f.ctx.lineWidth = 3 * (1 - p) + 1;
        f.ctx.stroke();
      });
    this.decor.push({ t0: performance.now(), items: [{ at: 0, dur, fn }], end: dur });
    view.wake(true);
  }

  /** End the clip at once: every state change applied, effects dropped. */
  skip(): void {
    const c = this.clip;
    if (!c) return;
    for (const it of c.items.filter((i) => i.once && !i.done).sort((a, b) => a.at - b.at)) {
      it.done = true;
      it.once!();
    }
    this.finish();
  }

  private finish(): void {
    this.clip = null;
    this.status = null;
    this.pausedAt = null;
    this.shown = [];
    this.poses.clear();
    this.layers = { under: [], mid: [], over: [] };
    if (this.view) {
      this.view.poses = new Map();
      this.view.fx = this.layers;
    }
    const done = this.done;
    this.done = [];
    for (const fn of done) fn();
  }

  /** @internal pose of a unit for this frame */
  pose(unitId: string): MutablePose {
    const id = this.bannerOf(unitId)?.id ?? unitId;
    let p = this.poses.get(id);
    if (!p) {
      p = {};
      this.poses.set(id, p);
    }
    return p;
  }

  /** @internal the shown banner of a unit (a hull's id is `-id`) */
  bannerOf(unitId: string): MutableBanner | undefined {
    return this.shown.find((b) => b.id === unitId || b.id === `-${unitId}`);
  }

  /** @internal */
  fx(layer: "under" | "mid" | "over", draw: FxDraw): void {
    this.layers[layer].push(draw);
  }

  /** @internal next free ticker row beside a unit's sign */
  tickRow(unitId: string): number {
    const n = this.tickRows.get(unitId) ?? 0;
    this.tickRows.set(unitId, n + 1);
    return n;
  }

  private frame(now: number): boolean {
    // paused: the frame drawn last stays; `resume` wakes the view again
    if (this.pausedAt !== null) return false;
    this.poses.clear();
    this.layers = { under: [], mid: [], over: [] };
    const run = (lane: Lane) => {
      const ms = now - lane.t0;
      for (const it of lane.items) {
        if (it.once) {
          if (!it.done && it.at <= ms) {
            it.done = true;
            it.once();
          }
          continue;
        }
        if (ms >= it.at && ms < it.at + it.dur) it.fn!((ms - it.at) / it.dur, ms - it.at);
      }
      return ms <= lane.end;
    };
    this.decor = this.decor.filter(run);
    const c = this.clip;
    if (c && !run(c)) {
      this.finish();
      return this.decor.length > 0;
    }
    if (this.view) {
      if (this.clip) this.view.banners = this.shown;
      this.view.poses = this.poses;
      this.view.fx = this.layers;
    }
    return this.clip !== null || this.decor.length > 0;
  }
}

/** Turns beats into timed items, at the clip's speed. */
class Builder {
  readonly items: Item[] = [];
  private readonly k: number;
  private readonly reduced: boolean;

  constructor(
    private readonly a: MapAnimator,
    private readonly input: ClipInput,
  ) {
    this.k = input.k;
    this.reduced = input.reduced;
  }

  private tween(at: number, dur: number, fn: (p: number, ms: number) => void): void {
    this.items.push({ at: at * this.k, dur: Math.max(1, dur * this.k), fn });
  }

  private once(at: number, fn: () => void): void {
    this.items.push({ at: at * this.k, dur: 0, once: fn });
  }

  private set(at: number, unitId: string, change: Partial<MutableBanner>): void {
    this.once(at, () => {
      const b = this.a.bannerOf(unitId);
      if (b) Object.assign(b, change);
    });
  }

  private look(at: number, unitId: string, change: LookChange): void {
    this.once(at, () => {
      const b = this.a.bannerOf(unitId);
      const sub = this.input.sub(unitId, change);
      if (b && sub !== null) b.sub = sub;
    });
  }

  private actor(at: number, unitId: string): void {
    this.once(at, () => {
      for (const b of this.a.banners()) (b as MutableBanner).active = false;
      const b = this.a.bannerOf(unitId);
      if (b) b.active = true;
    });
  }

  beat(b: Beat, at: number): number {
    switch (b.kind) {
      case "move":
        this.move(b, at);
        break;
      case "jump":
        this.jump(b, at);
        break;
      case "volley":
        this.volley(b, at);
        break;
      case "physical":
        this.physical(b, at);
        break;
      case "ams":
        this.tick(at, b.unitId, t("anim.ams"), "--ia-target");
        break;
      case "psr":
        this.psr(b, at);
        break;
      case "fall":
        this.fall(b, at);
        break;
      case "pilot":
        this.flash(at, b.unitId, "--tui-red");
        this.tick(at, b.unitId, t("anim.pilot", { n: b.hits }), "--tui-red");
        break;
      case "ko":
        this.tick(at, b.unitId, t("anim.ko"), "--tui-red");
        break;
      case "explode":
        this.explode(b.unitId, at);
        break;
      case "shutdown":
        this.chip(at, b.unitId, t("anim.shutdown"), "--ia-orange", T.chip);
        this.look(at, b.unitId, { off: true });
        break;
      case "removed":
        this.set(at, b.unitId, { team: 0, active: false });
        this.look(at, b.unitId, { removed: b.hull ? "hull" : "destroyed" });
        this.tick(at, b.unitId, t(b.hull ? "anim.hull" : "anim.destroyed"), "--ia-hull");
        break;
    }
    return at + beatTime(b);
  }

  // ------------------------------------------------------------ movement

  private move(b: Extract<Beat, { kind: "move" }>, at: number): void {
    const id = b.unitId;
    if (this.reduced) {
      const enters = b.legs.filter((l) => l.kind === "enter");
      const end = enters.length ? enters[enters.length - 1]!.to : null;
      const facing = [...b.legs].reverse().find((l) => l.kind === "turn");
      this.set(at, id, {
        ...(end ? { hex: end } : {}),
        ...(facing?.kind === "turn" ? { facing: facing.to } : {}),
      });
      const pts = enters.length ? [enters[0]!.from, ...enters.map((l) => l.to)] : [];
      if (pts.length) this.trail(at, pts, id, 900);
      return;
    }
    const times = legTimes(b.legs, b.mode);
    const dots = b.mode === "run" ? 3 : 1;
    let tt = at;
    b.legs.forEach((leg, i) => {
      const d = times[i]!;
      if (leg.kind === "turn") {
        const a0 = angleOf(leg.from);
        const da = turnTo(a0, angleOf(leg.to));
        this.tween(tt, d, (p) => {
          this.a.pose(id).angle = a0 + da * ease(p);
        });
        this.set(tt + d, id, { facing: leg.to });
      } else {
        const run = b.mode === "run";
        this.tween(tt, d, (p) => {
          const o = this.a.pose(id);
          o.from = leg.from;
          o.to = leg.to;
          o.t = run ? p : ease(p);
        });
        this.footprints(tt, leg.from, leg.to, id, dots);
        this.set(tt + d, id, { hex: leg.to });
      }
      tt += d;
    });
  }

  private jump(b: Extract<Beat, { kind: "jump" }>, at: number): void {
    const id = b.unitId;
    if (this.reduced) {
      this.set(at, id, { hex: b.to, facing: b.facing });
      this.trail(at, [b.from, b.to], id, 900);
      return;
    }
    const dur = T.jumpBase + T.jumpHex * b.hexes;
    const a0 = angleOf(b.fromFacing);
    const da = turnTo(a0, angleOf(b.facing));
    this.tween(at, dur, (p) => {
      const o = this.a.pose(id);
      o.from = b.from;
      o.to = b.to;
      o.t = ease(p);
      o.lift = Math.sin(Math.PI * p) * JUMP_LIFT;
      o.angle = a0 + da * Math.min(1, Math.max(0, (p - 0.3) / 0.4));
      o.shadow = true;
    });
    this.set(at + dur, id, { hex: b.to, facing: b.facing });
    const to = b.to;
    this.tween(at + dur, 300, (p) =>
      this.a.fx("under", (f) => {
        f.hexPath(to, 0.5 + 0.6 * easeOut(p));
        f.ctx.strokeStyle = mix(f.color("--ia-map-mark", "#d7e4d7"), 0.8 * (1 - p));
        f.ctx.lineWidth = 2;
        f.ctx.stroke();
      }),
    );
  }

  private footprints(at: number, from: HexCoord, to: HexCoord, id: string, dots: number): void {
    const team = this.a.bannerOf(id)?.team ?? 1;
    this.tween(at, 1300, (p) =>
      this.a.fx("under", (f) => {
        const a = f.ground(from);
        const b = f.ground(to);
        f.ctx.fillStyle = mix(f.color(`--ia-team${team}`, "#4fa3ff"), 0.8 * (1 - p));
        for (let i = 0; i < dots; i++) {
          const k = (i + 1) / (dots + 1) - 0.5;
          const x = a[0] + (b[0] - a[0]) * k * 0.6;
          const y = a[1] + (b[1] - a[1]) * k * 0.6;
          f.ctx.beginPath();
          f.ctx.ellipse(
            x,
            y,
            Math.max(2, f.R * 0.07),
            Math.max(1.5, f.R * 0.05),
            0,
            0,
            Math.PI * 2,
          );
          f.ctx.fill();
        }
      }),
    );
  }

  /** Reduced motion: the path as a dotted line, fading. */
  private trail(at: number, hexes: readonly HexCoord[], id: string, dur: number): void {
    const team = this.a.bannerOf(id)?.team ?? 1;
    this.tween(at, dur, (p) =>
      this.a.fx("under", (f) => {
        const c = f.ctx;
        c.save();
        c.strokeStyle = mix(f.color(`--ia-team${team}`, "#4fa3ff"), 0.9 * (1 - p));
        c.lineWidth = 3;
        c.setLineDash([2, 6]);
        c.beginPath();
        hexes.forEach((h, j) => {
          const [x, y] = f.ground(h);
          if (j) c.lineTo(x, y);
          else c.moveTo(x, y);
        });
        c.stroke();
        c.restore();
      }),
    );
  }

  // ------------------------------------------------------------ attacks

  private volley(b: Extract<Beat, { kind: "volley" }>, at: number): void {
    this.actor(at, b.attackerId);
    const gap = shotGap(b.shots.length);
    b.shots.forEach((s, i) => {
      const t0 = at + T.volleyLead + i * gap;
      this.tracer(t0, b.attackerId, b.targetId, s, i);
      const hit = t0 + T.flight;
      if (s.hit) {
        this.impact(hit, b.targetId);
        this.look(hit, b.targetId, { damage: s.after });
        this.tick(
          hit,
          b.targetId,
          damageText(s.damage, s.locations, s.crit),
          s.crit ? "--ia-orange" : "--ia-select",
        );
      } else {
        this.tick(hit, b.targetId, t(s.jammed ? "anim.jammed" : "anim.miss"), "--ia-map-label");
      }
    });
  }

  private physical(b: Extract<Beat, { kind: "physical" }>, at: number): void {
    const id = b.attackerId;
    this.actor(at, id);
    this.chip(at, id, t(`phys.${b.attack}`), "--ia-target", T.lunge + T.flight);
    if (!this.reduced) {
      const tgt = b.targetId;
      this.tween(at, T.lunge, (p) => {
        const me = this.a.bannerOf(id);
        const them = this.a.bannerOf(tgt);
        if (!me || !them) return;
        const o = this.a.pose(id);
        o.from = me.hex;
        o.to = them.hex;
        o.t = Math.sin(Math.PI * p) * 0.4;
      });
    }
    const hit = at + T.lunge;
    if (b.hit) {
      this.impact(hit, b.targetId);
      if (b.after) this.look(hit, b.targetId, { damage: b.after });
      this.tick(
        hit,
        b.targetId,
        damageText(b.damage, b.locations, b.crit),
        b.crit ? "--ia-orange" : "--ia-select",
      );
    } else {
      this.tick(hit, b.targetId, t("anim.miss"), "--ia-map-label");
    }
    if (b.selfDamage > 0) {
      this.flash(hit + 120, id, "--ia-target");
      if (b.attackerAfter) this.look(hit + 120, id, { damage: b.attackerAfter });
      this.tick(hit + 120, id, `−${b.selfDamage}`, "--ia-target");
    }
  }

  private tracer(at: number, from: string, to: string, s: Shot, i: number): void {
    const side = i % 2 === 0 ? 1 : -1;
    const ends = (f: FxContext): [[number, number], [number, number]] | null => {
      const a = f.torso(this.a.bannerOf(from)?.id ?? from);
      const b = f.torso(this.a.bannerOf(to)?.id ?? to);
      if (!a || !b) return null;
      if (s.hit) return [a, b];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L;
      const ny = dx / L;
      return [
        a,
        [
          b[0] + nx * f.R * 0.7 * side + (dx / L) * f.R * 0.9,
          b[1] + ny * f.R * 0.7 * side + (dy / L) * f.R * 0.9,
        ],
      ];
    };
    const team = this.a.bannerOf(from)?.team ?? 1;
    const beamColor = (f: FxContext) =>
      `color-mix(in srgb, ${f.color(`--ia-team${team}`, "#4fa3ff")} 55%, white)`;
    if (this.reduced) {
      this.tween(at, 260, (p) =>
        this.a.fx("over", (f) => {
          const e = ends(f);
          if (e) line(f, e[0], e[1], beamColor(f), 2, 1 - p, !s.hit);
        }),
      );
      return;
    }
    if (s.look === "beam") {
      this.tween(at, 300, (p) =>
        this.a.fx("over", (f) => {
          const e = ends(f);
          if (!e) return;
          const [a, b] = e;
          const g = Math.min(1, p / 0.3);
          const tip: [number, number] = [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g];
          line(f, a, tip, beamColor(f), s.hit ? 3 : 1.5, p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4, !s.hit);
        }),
      );
    } else {
      const n = s.look === "missile" ? 4 : 1;
      this.tween(at, T.flight + (s.hit ? 0 : 140), (p) =>
        this.a.fx("over", (f) => {
          const e = ends(f);
          if (!e) return;
          const [a, b] = e;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const L = Math.hypot(dx, dy) || 1;
          const col = f.color(n > 1 ? "--ia-orange" : "--ia-target", "#d8c26a");
          for (let j = 0; j < n; j++) {
            const q = Math.max(0, Math.min(1, p * 1.15 - j * 0.05));
            const wob = n > 1 ? Math.sin(q * Math.PI) * (j - 1.5) * f.R * 0.12 : 0;
            const x = a[0] + dx * q - (dy / L) * wob;
            const y = a[1] + dy * q + (dx / L) * wob;
            const tail = n > 1 ? 6 : 10;
            line(
              f,
              [x - (dx / L) * tail, y - (dy / L) * tail],
              [x, y],
              col,
              n > 1 ? 2 : 3,
              s.hit ? 1 : 1 - p * 0.7,
              false,
            );
          }
        }),
      );
    }
  }

  /** A hit: spark, hex flash, sign shake. */
  private impact(at: number, unitId: string): void {
    const id = this.a.bannerOf(unitId)?.id ?? unitId;
    this.tween(at, 200, (p) =>
      this.a.fx("over", (f) => {
        const pt = f.torso(id);
        if (pt) spark(f, pt, p);
      }),
    );
    this.flash(at, unitId, "--ia-select");
    this.shake(at, unitId, 3, 220);
  }

  private flash(at: number, unitId: string, token: string, dur = 260): void {
    this.tween(at, dur, (p) =>
      this.a.fx("under", (f) => {
        const b = this.a.bannerOf(unitId);
        if (!b) return;
        f.hexPath(b.hex, 0.98);
        f.ctx.fillStyle = mix(f.color(token, "#ffffff"), 0.5 * (1 - p));
        f.ctx.fill();
      }),
    );
  }

  private shake(at: number, unitId: string, amp: number, dur: number): void {
    this.tween(at, dur, (p) => {
      const o = this.a.pose(unitId);
      o.flash = 1 - p;
      if (!this.reduced) o.dx = Math.sin(p * Math.PI * 6) * amp * (1 - p);
    });
  }

  // ------------------------------------------------------------ penalties

  private psr(b: Extract<Beat, { kind: "psr" }>, at: number): void {
    const roll = b.roll === null ? t("anim.auto") : String(b.roll);
    const text = `${t("anim.psr")} ${b.target}+ · ${roll} ${b.success ? "✓" : "✗"}`;
    this.chip(at, b.unitId, text, b.success ? "--ia-reach" : "--tui-red", 1100);
    if (b.success && !this.reduced) {
      this.tween(at + 120, 360, (p) => {
        this.a.pose(b.unitId).tilt = Math.sin(p * Math.PI * 3) * 0.08 * (1 - p);
      });
    }
  }

  private fall(b: Extract<Beat, { kind: "fall" }>, at: number): void {
    const id = b.unitId;
    const banner = () => this.a.bannerOf(id);
    if (!this.reduced) {
      this.tween(at, T.fall, (p) => {
        const cur = banner();
        if (!cur) return;
        const a0 = angleOf(cur.facing);
        const o = this.a.pose(id);
        o.poleK = 1 - 0.65 * easeOut(p);
        o.tilt = Math.sin(p * Math.PI) * 0.25;
        o.angle = a0 + turnTo(a0, angleOf(b.facing)) * ease(p);
      });
    }
    const end = at + T.fall;
    this.set(end, id, { facing: b.facing });
    this.look(end, id, { prone: true });
    this.flash(end, id, "--ia-target", 300);
    this.tick(
      end,
      id,
      b.damage > 0 ? `${t("anim.fall")} −${b.damage}` : t("anim.fall"),
      "--ia-target",
    );
  }

  private explode(unitId: string, at: number): void {
    for (let i = 0; i < 2; i++) {
      this.tween(at + i * 160, this.reduced ? 300 : 520, (p) =>
        this.a.fx("under", (f) => {
          const b = this.a.bannerOf(unitId);
          if (!b) return;
          const orange = f.color("--ia-orange", "#e09a4f");
          f.hexPath(b.hex, this.reduced ? 0.95 : 0.5 + 1.1 * easeOut(p));
          f.ctx.strokeStyle = mix(orange, 1 - p);
          f.ctx.lineWidth = 4 * (1 - p) + 1;
          f.ctx.stroke();
          f.hexPath(b.hex, 0.98);
          f.ctx.fillStyle = mix(orange, 0.45 * (1 - p));
          f.ctx.fill();
        }),
      );
    }
    this.shake(at, unitId, 5, 400);
    this.chip(at, unitId, t("anim.ammo"), "--ia-orange", 1300);
  }

  // ------------------------------------------------------------ labels

  /** A ticker line to the right of a unit's sign, held then faded. */
  private tick(at: number, unitId: string, text: string, token: string): void {
    const row = this.a.tickRow(unitId);
    const hold = T.tick;
    this.tween(at, hold + 350, (_p, ms) =>
      this.a.fx("over", (f) => {
        const b = f.box(this.a.bannerOf(unitId)?.id ?? unitId);
        if (!b) return;
        const ms0 = ms / this.k;
        const a = ms0 < hold ? 1 : 1 - (ms0 - hold) / 350;
        const rise = this.reduced ? 0 : (1 - Math.min(1, ms0 / 140)) * 6;
        const c = f.ctx;
        c.save();
        c.font = `${f.fs}px ${f.font}`;
        c.textBaseline = "middle";
        const x = b.x1 + 6;
        const y = b.y0 + f.chh / 2 + row * f.chh + rise;
        const w = c.measureText(text).width + 8;
        c.fillStyle = mix(f.color("--ia-banner-bg", "#0c0f0c"), 0.85 * a);
        c.fillRect(x - 3, y - f.chh / 2, w, f.chh);
        c.fillStyle = mix(f.color(token, "#d7e4d7"), a);
        c.fillText(text, x + 1, y + 1);
        c.restore();
      }),
    );
  }

  /** A filled chip over a unit's sign, held then faded. */
  private chip(at: number, unitId: string, text: string, token: string, hold: number): void {
    this.tween(at, hold + 300, (_p, ms) =>
      this.a.fx("over", (f) => {
        const b = f.box(this.a.bannerOf(unitId)?.id ?? unitId);
        if (!b) return;
        const ms0 = ms / this.k;
        const a = ms0 < hold ? 1 : 1 - (ms0 - hold) / 300;
        const c = f.ctx;
        c.save();
        c.font = `${f.fs}px ${f.font}`;
        c.textBaseline = "middle";
        const w = c.measureText(text).width + 10;
        const x = (b.x0 + b.x1) / 2 - w / 2;
        const y = b.y0 - f.chh * 0.9;
        c.fillStyle = mix(f.color(token, "#d8c26a"), a);
        c.fillRect(x, y - f.chh / 2, w, f.chh);
        c.fillStyle = mix(f.color("--ia-banner-ink", "#0c0f0c"), a);
        c.fillText(text, x + 5, y + 1);
        c.restore();
      }),
    );
  }
}

/** `−5 CT`, `−8 LT·CT ✶CRIT`. */
function damageText(damage: number, locations: readonly string[], crit: boolean): string {
  const locs = locations.map(locName).join("·");
  return `−${damage}${locs ? ` ${locs}` : ""}${crit ? ` ✶${t("anim.crit")}` : ""}`;
}

function line(
  f: FxContext,
  a: readonly [number, number],
  b: readonly [number, number],
  color: string,
  width: number,
  alpha: number,
  dashed: boolean,
): void {
  const c = f.ctx;
  c.save();
  c.globalAlpha = Math.max(0, Math.min(1, alpha));
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineCap = "round";
  if (dashed) c.setLineDash([5, 5]);
  c.beginPath();
  c.moveTo(a[0], a[1]);
  c.lineTo(b[0], b[1]);
  c.stroke();
  c.restore();
}

function spark(f: FxContext, [x, y]: readonly [number, number], p: number): void {
  const c = f.ctx;
  c.save();
  c.strokeStyle = mix(f.color("--ia-select", "#ffffff"), 1 - p);
  c.lineWidth = 2;
  for (let j = 0; j < 6; j++) {
    const a = (j * Math.PI) / 3 + 0.3;
    const r0 = 3 + p * 6;
    const r1 = 6 + p * 12;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0 * 0.6);
    c.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1 * 0.6);
    c.stroke();
  }
  c.restore();
}

export { SPEED_K };
