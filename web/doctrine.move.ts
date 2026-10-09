/**
 * Movement scoring for the doctrine player (GDD §9.1, movement): every
 * reachable landing (hex, facing, mode) gets the weighted terms below, and the
 * best one becomes `mode <m>` / `place <col> <row> <facing>` / `done`.
 *
 * Rules used: attacker movement modifier by declared mode (TW p. 106), target
 * movement modifier by hexes entered, +1 for a jump (TW p. 107), movement heat
 * walk 1 / run 2 / jump max(3, hexes) (TW p. 159).
 */
import {
  attackerMovementModifier,
  type BattleState,
  cellAt,
  classifyFiringArc,
  destroyedLegs,
  effectiveMoveBudget,
  effectiveMovement,
  type Facing,
  type HexCoord,
  hexDistance,
  isTsmActive,
  isUnitRemoved,
  losClear,
  type MoveMode,
  mechDefFor,
  movementHeat,
  neighbor,
  type RevealedLanding,
  reachableLandings,
  rotateFacing,
  targetMovementModifier,
  toHitHeatModifier,
  type UnitState,
  waterDepth,
  weaponCanFireIntoArc,
  wreckAt,
} from "btlib10x";
import {
  dissipationOf,
  expectedDamageAt,
  exposureAt,
  hexDefenseMod,
  offMap,
  type RangeProfile,
  round1,
  type TraceCandidate,
  type TraceTerm,
  threatsTo,
  type UsableWeapon,
  usableWeapons,
} from "./doctrine.common";
import type { Doctrine } from "./doctrine.data";

/** Weight on each hex away from the preferred distance inside the range term. */
const RANGE_DRIFT_PER_HEX = 0.5;
/** Flank term for ending in the target's side arc (rear arc scores 1). */
const FLANK_SIDE = 0.3;
/** Melee term for ending two hexes away (one step from contact). */
const MELEE_NEAR = 0.3;
/** Showmanship range for the Gladiator's crowd term. */
const CROWD_RANGE = 3;

interface Budgets {
  readonly walking: number;
  readonly running: number;
  readonly jumping: number;
}

function budgetsOf(battle: BattleState, unit: UnitState): Budgets {
  const def = mechDefFor(unit);
  const eff = effectiveMovement(
    def,
    unit.damage,
    unit.critSlotsDestroyed,
    isTsmActive(def, unit.heat),
    waterDepth(cellAt(battle, unit.position).terrain),
  );
  return {
    walking: effectiveMoveBudget("walk", eff, unit.heat),
    running: effectiveMoveBudget("run", eff, unit.heat),
    jumping: effectiveMoveBudget("jump", eff, unit.heat),
  };
}

/** Same reachability options the `mode` command builds (`reachablesInfo`), standing units only. */
function landingsFor(
  battle: BattleState,
  unit: UnitState,
  mode: MoveMode,
  b: Budgets,
): RevealedLanding[] {
  return reachableLandings({ ...unit.position }, unit.facing, {
    mode,
    walking: b.walking,
    running: b.running,
    jumping: b.jumping,
    prone: false,
    grid: battle,
    team: unit.team,
    wreckAt: (hex: HexCoord): boolean => wreckAt(battle, hex) !== undefined,
    occupantTeam: (hex: HexCoord): number | undefined => {
      for (const u of Object.values(battle.units)) {
        if (isUnitRemoved(u)) continue;
        if (u.position.col === hex.col && u.position.row === hex.row) return u.team;
      }
      return undefined;
    },
  });
}

/** Modes the doctrine considers this turn. */
function modesFor(unit: UnitState, doctrine: Doctrine, b: Budgets): MoveMode[] {
  const modes: MoveMode[] = ["standStill"];
  if (b.walking > 0) modes.push("walk");
  // One-leg 'Mechs may not run (TW p. 50).
  if (destroyedLegs(unit.damage) === 0 && b.running > b.walking) modes.push("run");
  if (doctrine.jump !== "none" && b.jumping > 0) modes.push("jump");
  return modes;
}

/** Hexes entered along a path (turn fragments enter none). */
function hexesEntered(landing: RevealedLanding): number {
  return landing.path.filter((p) => p.fragment !== "L" && p.fragment !== "R").length;
}

/** Expected damage from `hex` facing `facing`, best over the three torso twists. */
function firepowerFrom(
  battle: BattleState,
  weapons: readonly UsableWeapon[],
  hex: HexCoord,
  facing: Facing,
  target: UnitState,
  tnBase: number,
  canTwist: boolean,
): number {
  if (!losClear(battle, hex, target.position, battle.wrecks)) return 0;
  const d = Math.max(1, hexDistance(hex, target.position));
  let best = 0;
  for (const turn of canTwist ? [0, -1, 1] : [0]) {
    const arc = classifyFiringArc(hex, target.position, rotateFacing(facing, turn));
    if (arc === null) continue;
    const bearing = weapons.filter((w) =>
      weaponCanFireIntoArc(w.mount.location, w.mount.rearFacing === true, arc),
    );
    best = Math.max(best, expectedDamageAt(bearing, d, tnBase));
  }
  return best;
}

export interface MoveScoringInput {
  readonly battle: BattleState;
  readonly actor: UnitState;
  readonly target: UnitState;
  readonly doctrine: Doctrine;
  readonly profile: RangeProfile;
  readonly heatCeiling: number;
}

/** Every landing scored, best first. */
export function scoreMoves(input: MoveScoringInput): TraceCandidate[] {
  const { battle, actor, target, doctrine, profile, heatCeiling } = input;
  const w = doctrine.weights;
  const budgets = budgetsOf(battle, actor);
  const weapons = usableWeapons(actor);
  const threats = threatsTo(battle, actor);
  const targetTmm = targetMovementModifier(target.hexesMovedThisTurn, target.jumpedThisTurn);
  const targetDefense = targetTmm + hexDefenseMod(battle, target.position);
  const heatNow = actor.heat + actor.heatPending - dissipationOf(actor);
  const canTwist = !actor.prone;

  const out: TraceCandidate[] = [];
  const seen = new Set<string>();
  for (const mode of modesFor(actor, doctrine, budgets)) {
    const landings: RevealedLanding[] =
      mode === "standStill"
        ? [{ hex: { ...actor.position }, facing: actor.facing, path: [] }]
        : landingsFor(battle, actor, mode, budgets).filter((l) => l.path.length > 0);
    for (const landing of landings) {
      const key = `${mode}|${landing.hex.col},${landing.hex.row}|${landing.facing}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hexes = hexesEntered(landing);
      const mp = landing.path.at(-1)?.totalMp ?? 0;
      const d = hexDistance(landing.hex, target.position);
      const myTmm = targetMovementModifier(hexes, mode === "jump");

      const tnBase =
        actor.gunnery +
        attackerMovementModifier(mode) +
        targetDefense +
        toHitHeatModifier(actor.heat);
      const firepower = firepowerFrom(
        battle,
        weapons,
        landing.hex,
        landing.facing,
        target,
        tnBase,
        canTwist,
      );
      const range = firepower - RANGE_DRIFT_PER_HEX * Math.abs(d - profile.preferred);

      const cover = hexDefenseMod(battle, landing.hex);

      const arcFromTarget = classifyFiringArc(target.position, landing.hex, target.facing);
      const flank =
        d <= profile.maxLong
          ? arcFromTarget === "rear"
            ? 1
            : arcFromTarget === "leftSide" || arcFromTarget === "rightSide"
              ? FLANK_SIDE
              : 0
          : 0;

      const melee = d <= 1 ? 1 : d === 2 ? MELEE_NEAR : 0;

      // Ring-out: adjacent and facing the target, which stands with the map edge behind it.
      const facingTarget =
        d === 1 &&
        neighbor(landing.hex, landing.facing).col === target.position.col &&
        neighbor(landing.hex, landing.facing).row === target.position.row;
      const edge =
        doctrine.ringOut &&
        facingTarget &&
        offMap(battle, neighbor(target.position, landing.facing))
          ? 1
          : 0;

      const exposed = exposureAt(battle, threats, landing.hex, myTmm);
      const heatOver = Math.max(0, heatNow + movementHeat(mode, mp) - heatCeiling);
      const crowd = d <= CROWD_RANGE && arcFromTarget === "front" ? 1 : 0;

      const terms: TraceTerm[] = [
        { id: "range", value: w.range * range },
        { id: "cover", value: w.cover * cover },
        { id: "tmm", value: w.tmm * myTmm },
        { id: "flank", value: w.flank * flank },
        { id: "melee", value: w.melee * melee },
        { id: "edge", value: w.edge * edge },
        { id: "exposed", value: -w.exposed * exposed },
        { id: "heat", value: -w.heat * heatOver },
        { id: "crowd", value: w.crowd * crowd },
      ].filter((t) => t.value !== 0) as TraceTerm[];
      const score = round1(terms.reduce((a, t) => a + t.value, 0));
      const word = mode === "standStill" ? "standstill" : mode;
      const commands =
        mode === "standStill"
          ? ["mode standstill", "done"]
          : [
              `mode ${word}`,
              `place ${landing.hex.col} ${landing.hex.row} ${landing.facing}`,
              "done",
            ];
      out.push({
        label: `${word} (${landing.hex.col},${landing.hex.row}) ${landing.facing}`,
        score,
        terms: terms.map((t) => ({ id: t.id, value: round1(t.value) })),
        commands,
      });
    }
  }
  return out;
}
