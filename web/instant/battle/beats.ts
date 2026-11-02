/**
 * Map animation beats: what one committed step (a move, or the attack phase's
 * resolution) shows on the map, read from the step's game events and the move
 * the controller committed. DOM-free and pure; `map/anim.ts` turns the beats
 * into tweens. Animation is presentation only: the engine has already applied
 * every beat by the time it plays.
 */
import {
  type Facing,
  type GameEvent,
  type HexCoord,
  type MoveMode,
  type MoveStep,
  type PhysicalAttackType,
  rotateFacing,
  type UnitDamageState,
  weaponDefFor,
} from "btlib10x";

/** Animations setting: Full, Fast (half the time) or Off (no clips). */
export type AnimSpeed = "full" | "fast" | "off";
export const ANIM_SPEEDS: readonly AnimSpeed[] = ["full", "fast", "off"];

/** Time factor of a speed. */
export const SPEED_K: Record<Exclude<AnimSpeed, "off">, number> = { full: 1, fast: 0.5 };

/** One leg of a replayed ground move: entering a hex, or a 60° turn in place. */
export type Leg =
  | { readonly kind: "enter"; readonly from: HexCoord; readonly to: HexCoord }
  | { readonly kind: "turn"; readonly from: Facing; readonly to: Facing };

/** How a shot looks in flight. */
export type ShotLook = "beam" | "shell" | "missile";

export interface Shot {
  readonly weapon: string;
  readonly look: ShotLook;
  readonly hit: boolean;
  /** Damage that reached the target (0 on a miss). */
  readonly damage: number;
  /** Locations struck, in order, deduplicated. */
  readonly locations: readonly string[];
  readonly crit: boolean;
  readonly jammed: boolean;
  /** The target's damage after this shot. */
  readonly after: UnitDamageState;
}

export type Beat =
  | {
      readonly kind: "move";
      readonly unitId: string;
      readonly mode: MoveMode;
      readonly legs: readonly Leg[];
    }
  | {
      readonly kind: "jump";
      readonly unitId: string;
      readonly from: HexCoord;
      readonly to: HexCoord;
      readonly fromFacing: Facing;
      readonly facing: Facing;
      readonly hexes: number;
    }
  | {
      readonly kind: "volley";
      readonly attackerId: string;
      readonly targetId: string;
      readonly shots: readonly Shot[];
      /** The target's damage after the volley. */
      readonly after: UnitDamageState;
    }
  | {
      readonly kind: "physical";
      readonly attackerId: string;
      readonly targetId: string;
      readonly attack: PhysicalAttackType;
      readonly hit: boolean;
      readonly damage: number;
      readonly locations: readonly string[];
      readonly crit: boolean;
      readonly selfDamage: number;
      readonly after: UnitDamageState | null;
      readonly attackerAfter: UnitDamageState | null;
    }
  | { readonly kind: "ams"; readonly unitId: string; readonly attackerId: string }
  | {
      readonly kind: "psr";
      readonly unitId: string;
      readonly target: number;
      readonly roll: number | null;
      readonly success: boolean;
    }
  | {
      readonly kind: "fall";
      readonly unitId: string;
      readonly facing: Facing;
      readonly damage: number;
    }
  | { readonly kind: "pilot"; readonly unitId: string; readonly hits: number }
  | { readonly kind: "ko"; readonly unitId: string }
  | { readonly kind: "explode"; readonly unitId: string; readonly damage: number }
  | { readonly kind: "shutdown"; readonly unitId: string }
  | { readonly kind: "removed"; readonly unitId: string; readonly hull: boolean };

/** The move a step committed, as the controller replayed it into engine steps. */
export interface CommittedMove {
  readonly unitId: string;
  readonly mode: MoveMode;
  readonly from: HexCoord;
  readonly facing: Facing;
  readonly steps: readonly MoveStep[];
  readonly finalFacing: Facing | null;
}

const same = (a: HexCoord, b: HexCoord) => a.col === b.col && a.row === b.row;

function shotLook(weapon: string): ShotLook {
  try {
    const c = weaponDefFor({ weapon }).category;
    return c === "ENERGY" ? "beam" : c === "MISSILE" ? "missile" : "shell";
  } catch {
    return "shell";
  }
}

const uniq = (xs: readonly string[]) => [...new Set(xs)];
const lastAfter = (apps: readonly { after: UnitDamageState }[]) =>
  apps.length ? apps[apps.length - 1]!.after : null;

/**
 * The legs of a ground move, ending where the engine actually left the unit:
 * a move cut short (a fall on the way) stops at that hex.
 */
export function moveLegs(m: CommittedMove, end: HexCoord | null): Leg[] {
  const legs: Leg[] = [];
  let hex = m.from;
  let facing = m.facing;
  for (const st of m.steps) {
    if (st.kind === "turn") {
      const to = rotateFacing(facing, st.facings);
      legs.push({ kind: "turn", from: facing, to });
      facing = to;
    } else {
      legs.push({ kind: "enter", from: hex, to: st.to });
      hex = st.to;
    }
  }
  if (end === null || same(hex, end)) return legs;
  // the unit stopped early (a fall on the way): cut after its last entry of the end hex
  for (let i = legs.length - 1; i >= 0; i--) {
    const l = legs[i]!;
    if (l.kind === "enter" && same(l.to, end)) return legs.slice(0, i + 1);
  }
  return [];
}

/**
 * Beats for one committed step, in event order. `move` is the committed
 * move (null for anything else); `events` every game event of the step.
 */
export function buildBeats(events: readonly GameEvent[], move: CommittedMove | null): Beat[] {
  const out: Beat[] = [];
  let volley: {
    attackerId: string;
    targetId: string;
    shots: Shot[];
    after: UnitDamageState;
  } | null = null;
  /** AMS beats seen inside a volley, shown once it is out. */
  let ams: Beat[] = [];
  const flush = () => {
    if (volley) out.push({ kind: "volley", ...volley });
    volley = null;
    out.push(...ams);
    ams = [];
  };
  for (const e of events) {
    if (e.kind !== "attackResolved" && e.kind !== "amsEngaged") flush();
    switch (e.kind) {
      case "moved": {
        if (!move || move.unitId !== e.unitId) break;
        if (e.mode === "jump") {
          const hexes = move.steps.filter((s) => s.kind === "enter").length;
          if (hexes > 0 || e.facing !== move.facing)
            out.push({
              kind: "jump",
              unitId: e.unitId,
              from: move.from,
              to: e.position,
              fromFacing: move.facing,
              facing: e.facing,
              hexes,
            });
          break;
        }
        const legs = moveLegs(move, e.position);
        // a stand-up's free facing pick, or a final facing the steps did not reach
        const lastFacing = legs.reduce<Facing>(
          (f, l) => (l.kind === "turn" ? l.to : f),
          move.facing,
        );
        if (lastFacing !== e.facing) legs.push({ kind: "turn", from: lastFacing, to: e.facing });
        if (legs.length) out.push({ kind: "move", unitId: e.unitId, mode: e.mode, legs });
        break;
      }
      case "attackResolved": {
        const r = e.resolution;
        if (volley && (volley.attackerId !== e.unitId || volley.targetId !== e.targetId)) flush();
        if (!volley)
          volley = {
            attackerId: e.unitId,
            targetId: e.targetId,
            shots: [],
            after: r.targetDamageAfter,
          };
        const damage = r.groups.reduce((n, g) => n + g.damage, 0);
        volley.shots.push({
          weapon: r.weapon,
          look: shotLook(r.weapon),
          hit: r.hit && damage > 0,
          damage,
          locations: uniq(r.groups.map((g) => g.location)),
          crit: r.crits.some((c) => c.rows.length > 0),
          jammed: r.jammed,
          after: r.targetDamageAfter,
        });
        volley.after = r.targetDamageAfter;
        break;
      }
      case "amsEngaged":
        ams.push({ kind: "ams", unitId: e.unitId, attackerId: e.attackerId });
        break;
      case "physicalAttackResolved": {
        const r = e.resolution;
        const damage = r.damageToTarget.reduce((n, g) => n + g.damage, 0);
        out.push({
          kind: "physical",
          attackerId: e.unitId,
          targetId: e.targetId,
          attack: r.type,
          hit: r.hit,
          damage,
          locations: uniq(r.damageToTarget.map((g) => g.location)),
          crit: r.crits.some((c) => c.rows.length > 0),
          selfDamage: r.damageToAttacker.reduce((n, g) => n + g.damage, 0),
          after: lastAfter(r.applications),
          attackerAfter: lastAfter(r.attackerApplications),
        });
        break;
      }
      case "pilotingCheck":
        out.push({
          kind: "psr",
          unitId: e.unitId,
          target: e.basePiloting + e.triggerModifier + e.preexistingModifier,
          roll: e.roll,
          success: e.success,
        });
        break;
      case "unitFell":
        if (e.cause.kind === "voluntaryDrop") break;
        out.push({
          kind: "fall",
          unitId: e.unitId,
          facing: e.facingAfter,
          damage: e.groups.reduce((n, g) => n + g.damage, 0),
        });
        break;
      case "pilotDamaged":
        out.push({ kind: "pilot", unitId: e.unitId, hits: e.hits });
        break;
      case "consciousnessCheck":
        if (!e.success && e.cause !== "recovery") out.push({ kind: "ko", unitId: e.unitId });
        break;
      case "ammoExplosionCheck":
        if (!e.avoided) out.push({ kind: "explode", unitId: e.unitId, damage: e.damage });
        break;
      case "shutdownCheck":
        if (e.result === "shutdown" || e.result === "unconscious")
          out.push({ kind: "shutdown", unitId: e.unitId });
        break;
      case "unitRemoved":
        out.push({ kind: "removed", unitId: e.unitId, hull: e.reason !== "destroyed" });
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/** True when the beats hold an attack outcome (the reel), not just a move. */
export function isReel(beats: readonly Beat[]): boolean {
  return beats.some((b) => b.kind === "volley" || b.kind === "physical");
}

// ------------------------------------------------------------ timing (ms at Full)

export const T = {
  walkHex: 160,
  runHex: 110,
  turn: 90,
  moveCap: 1600,
  jumpBase: 300,
  jumpHex: 60,
  gap: 80,
  volleyLead: 200,
  shotGap: 110,
  flight: 220,
  volleyTail: 380,
  volleyCap: 1500,
  volleySpace: 150,
  lunge: 220,
  psr: 600,
  fall: 380,
  tick: 1300,
  ping: 450,
  explode: 900,
  chip: 800,
} as const;

/** Time per move leg at Full, compressed so the whole move fits `T.moveCap`. */
export function legTimes(legs: readonly Leg[], mode: MoveMode): number[] {
  const per = mode === "run" ? T.runHex : T.walkHex;
  const raw = legs.map((l) => (l.kind === "turn" ? T.turn : per));
  const total = raw.reduce((a, b) => a + b, 0);
  const k = total > T.moveCap ? T.moveCap / total : 1;
  return raw.map((x) => x * k);
}

/** Gap between shots of a volley at Full, shrunk so the volley fits `T.volleyCap`. */
export function shotGap(shots: number): number {
  if (shots <= 1) return T.shotGap;
  const room = T.volleyCap - T.volleyLead - T.flight - T.volleyTail;
  return Math.max(30, Math.min(T.shotGap, room / (shots - 1)));
}

/** Length of a beat at Full (what follows starts after it). */
export function beatTime(b: Beat): number {
  switch (b.kind) {
    case "move":
      return legTimes(b.legs, b.mode).reduce((a, x) => a + x, 0) + T.gap;
    case "jump":
      return T.jumpBase + T.jumpHex * b.hexes + T.gap + 40;
    case "volley":
      return (
        T.volleyLead + (b.shots.length - 1) * shotGap(b.shots.length) + T.flight + T.volleyTail
      );
    case "physical":
      return T.lunge + T.flight + T.volleyTail;
    case "psr":
      return b.success ? T.psr : 450;
    case "fall":
      return T.fall + 300;
    case "explode":
      return T.explode;
    case "ams":
      return 0;
    case "pilot":
    case "ko":
    case "shutdown":
    case "removed":
      return 300;
  }
}
