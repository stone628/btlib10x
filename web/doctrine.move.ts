/**
 * Movement scoring for the doctrine player (GDD §9.1, movement): every
 * reachable landing (hex, facing, mode) gets the weighted terms below, and the
 * best one becomes `mode <m>` / `place <col> <row> <facing>` / `done`.
 *
 * Rules used: attacker movement modifier by declared mode (TW p. 106), target
 * movement modifier by hexes entered, +1 for a jump (TW p. 107), movement heat
 * walk 1 / run 2 / jump max(3, hexes) (TW p. 159).
 *
 * Physical-biased doctrines (melee "seeks" / "first") also score charge and
 * DFA landings: a walk / run / jump path that ends in the target's hex stops
 * the unit in the hex before it and declares the attack (TW pp. 148–150). A
 * charging unit makes no weapon attacks that turn, so the landing trades its
 * firepower for the charge's expected damage, less the damage the unit
 * expects to take itself (charge / DFA recoil, the fall after a missed DFA).
 */
import {
  attackerMovementModifier,
  type BattleState,
  cellAt,
  classifyFiringArc,
  computePhysicalToHit,
  DFA_MISS_LEVELS_FALLEN,
  destroyedLegs,
  effectiveMoveBudget,
  effectiveMovement,
  type Facing,
  facingToward,
  fallingDamageTotal,
  type HexCoord,
  hexDistance,
  hitProbability,
  isTsmActive,
  isUnitRemoved,
  losClear,
  type MoveMode,
  mechDefFor,
  meleeDeclarationProblem,
  meleeRecoilDamage,
  movementHeat,
  physicalDamage,
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
  type RangeProfile,
  round1,
  type TraceCandidate,
  type TraceTerm,
  threatsTo,
  type UsableWeapon,
  usableWeapons,
} from "./doctrine.common";
import { type Doctrine, isMeleeBiased, MELEE_FACTOR } from "./doctrine.data";

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

/**
 * Same reachability options the `mode` command builds (`reachablesInfo`),
 * standing units only. With `meleeTarget`, walk / run / jump paths may also
 * end in that enemy's hex (charge / DFA), when the engine would accept the
 * declaration.
 */
function landingsFor(
  battle: BattleState,
  unit: UnitState,
  mode: MoveMode,
  b: Budgets,
  meleeTarget: UnitState | null,
): RevealedLanding[] {
  return reachableLandings(unit.position, unit.facing, {
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
      // A declared charge / DFA reserves its target hex for the attacker.
      for (const u of Object.values(battle.units)) {
        if (isUnitRemoved(u) || u.id === unit.id) continue;
        if (u.meleeCharge?.hex.col === hex.col && u.meleeCharge.hex.row === hex.row) {
          return u.team;
        }
      }
      return undefined;
    },
    ...(meleeTarget !== null
      ? {
          meleeOk: (stop: HexCoord, targetHex: HexCoord, kind: "charge" | "dfa"): boolean =>
            targetHex.col === meleeTarget.position.col &&
            targetHex.row === meleeTarget.position.row &&
            meleeDeclarationProblem(battle, unit.id, stop, meleeTarget.id, kind, b.jumping) ===
              null,
        }
      : {}),
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

/**
 * Hexes a charge / DFA path moves before its stop: the last step only aims
 * at the target's hex, and target movement counts only the hexes since the
 * last reversal of direction (TW p. 107, as `executeMove` counts them).
 */
function meleeHexesMoved(landing: RevealedLanding): number {
  const dirs = landing.path
    .slice(0, -1)
    .filter((p) => p.fragment !== "L" && p.fragment !== "R")
    .map((p) => (p.fragment === "B" ? "B" : "F"));
  let since = dirs.length;
  while (since > 0 && dirs[since - 1] === dirs[dirs.length - 1]) since -= 1;
  return dirs.length - since;
}

interface MeleeValue {
  /** Melee factor × P(hit) × damage to the target. */
  readonly damage: number;
  /** Damage the unit expects to take itself: recoil on a hit, the fall after a missed DFA. */
  readonly self: number;
}

/** Expected outcome of a charge / DFA declared by `landing` (TW pp. 148–150). */
function meleeValue(
  battle: BattleState,
  actor: UnitState,
  target: UnitState,
  landing: RevealedLanding,
  mode: MoveMode,
  doctrine: Doctrine,
): MeleeValue {
  const kind = landing.melee!.kind;
  const stop = landing.melee!.stopsAt;
  // The attacker as it will stand at its stop hex after the move.
  const moved: UnitState = {
    ...actor,
    position: stop,
    facing: facingToward(stop, target.position) ?? landing.facing,
    moveMode: mode,
    hexesMovedThisTurn: meleeHexesMoved(landing),
    jumpedThisTurn: kind === "dfa",
  };
  const p = hitProbability(computePhysicalToHit(battle, moved, target, kind, undefined).total);
  const damage = MELEE_FACTOR[doctrine.melee] * p * physicalDamage(kind, moved, undefined);
  const recoil = p * meleeRecoilDamage(kind, moved, target);
  const fall =
    kind === "dfa"
      ? (1 - p) * fallingDamageTotal(mechDefFor(actor).tonnage, DFA_MISS_LEVELS_FALLEN)
      : 0;
  return { damage, self: recoil + fall };
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
  const meleeTarget = isMeleeBiased(doctrine) ? target : null;

  const out: TraceCandidate[] = [];
  const seen = new Set<string>();
  for (const mode of modesFor(actor, doctrine, budgets)) {
    const landings: RevealedLanding[] =
      mode === "standStill"
        ? [{ hex: actor.position, facing: actor.facing, path: [] }]
        : landingsFor(battle, actor, mode, budgets, meleeTarget).filter((l) => l.path.length > 0);
    for (const landing of landings) {
      const key = `${mode}|${landing.hex.col},${landing.hex.row}|${landing.facing}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const melee = landing.melee;
      // A charge / DFA stops in the hex before the target's and fires no weapons.
      const at = melee?.stopsAt ?? landing.hex;
      const facing =
        melee !== undefined
          ? (facingToward(at, target.position) ?? landing.facing)
          : landing.facing;
      const hexes = melee !== undefined ? meleeHexesMoved(landing) : hexesEntered(landing);
      const mp = landing.path.at(-1)?.totalMp ?? 0;
      const d = hexDistance(at, target.position);
      const myTmm = targetMovementModifier(hexes, mode === "jump");

      const tnBase =
        actor.gunnery +
        attackerMovementModifier(mode) +
        targetDefense +
        toHitHeatModifier(actor.heat);
      const firepower =
        melee !== undefined
          ? 0
          : firepowerFrom(battle, weapons, at, facing, target, tnBase, canTwist);
      const range = firepower - RANGE_DRIFT_PER_HEX * Math.abs(d - profile.preferred);

      const cover = hexDefenseMod(battle, at);

      const arcFromTarget = classifyFiringArc(target.position, at, target.facing);
      const flank =
        d <= profile.maxLong
          ? arcFromTarget === "rear"
            ? 1
            : arcFromTarget === "leftSide" || arcFromTarget === "rightSide"
              ? FLANK_SIDE
              : 0
          : 0;

      const contact = d <= 1 ? 1 : d === 2 ? MELEE_NEAR : 0;
      const charge =
        melee !== undefined ? meleeValue(battle, actor, target, landing, mode, doctrine) : null;

      const exposed = exposureAt(battle, threats, at, myTmm);
      const heatOver = Math.max(0, heatNow + movementHeat(mode, mp) - heatCeiling);
      const crowd = d <= CROWD_RANGE && arcFromTarget === "front" ? 1 : 0;

      const terms: TraceTerm[] = [
        { id: "range", value: w.range * range },
        { id: "cover", value: w.cover * cover },
        { id: "tmm", value: w.tmm * myTmm },
        { id: "flank", value: w.flank * flank },
        { id: "melee", value: w.melee * contact },
        { id: "charge", value: charge?.damage ?? 0 },
        { id: "recoil", value: -w.exposed * (charge?.self ?? 0) },
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
      const label =
        melee !== undefined
          ? `${word} ${melee.kind} ${target.id} from (${at.col},${at.row})`
          : `${word} (${landing.hex.col},${landing.hex.row}) ${landing.facing}`;
      out.push({
        label,
        score,
        terms: terms.map((t) => ({ id: t.id, value: round1(t.value) })),
        commands,
      });
    }
  }
  return out;
}
