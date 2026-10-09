/**
 * Attack scoring for the doctrine player (GDD §9.1, attack): for each torso
 * twist, pick a weapon set against the committed target under the doctrine's
 * heat ceiling and ammo discipline, then weigh physical options (punch, kick,
 * push) against the weapons those limbs give up.
 *
 * Rules used: one target per turn; a limb that fires a weapon cannot punch or
 * kick with it (TW p. 144, enforced again by `validatePhysicalAttack`);
 * punch/kick/push to-hit and damage come straight from the engine
 * (`computePhysicalToHit`, `physicalDamage`, TW pp. 145–148).
 */
import {
  type Arc,
  type BattleState,
  computePhysicalToHit,
  type FireTarget,
  type FireWeapon,
  hexDistance,
  hitProbability,
  type Location,
  loadAmmoBins,
  mechDefFor,
  neighbor,
  type PhysicalAttackType,
  physicalDamage,
  pooledTotalsByWeaponName,
  suggestFireTargets,
  type UnitState,
  validatePhysicalAttack,
  weaponDefFor,
} from "btlib10x";
import {
  dissipationOf,
  expectedHitDamage,
  offMap,
  round1,
  type TraceCandidate,
  type TraceNote,
  type TraceTerm,
} from "./doctrine.common";
import type { Doctrine, MeleePreference } from "./doctrine.data";

/** Kicks risk a fall on a miss (TW p. 147): Opportunistic doctrines skip worse TNs
 *  (Never doctrines do not reach physical options at all). */
const CAUTIOUS_KICK_MAX_TN = 8;
/** Value of a push that throws the target out of the arena (wins the bout, GDD §8.3). */
const RING_OUT_VALUE = 50;
const MELEE_FACTOR: Readonly<Record<MeleePreference, number>> = {
  never: 0,
  opportunistic: 1,
  seeks: 1.2,
  first: 1.5,
};

const TWIST_WORD: Readonly<Record<string, string>> = {
  leftSide: "left",
  rightSide: "right",
};

type Limb = "leftArm" | "rightArm" | "leftLeg" | "rightLeg";

interface PhysicalOption {
  readonly type: PhysicalAttackType;
  readonly limb?: Limb;
  /** Weapon locations this option keeps from firing. */
  readonly blocks: readonly Location[];
}

const PHYSICAL_OPTIONS: readonly PhysicalOption[] = [
  { type: "punch", limb: "leftArm", blocks: ["leftArm"] },
  { type: "punch", limb: "rightArm", blocks: ["rightArm"] },
  { type: "kick", limb: "leftLeg", blocks: ["leftLeg"] },
  { type: "kick", limb: "rightLeg", blocks: ["rightLeg"] },
  { type: "push", blocks: ["leftArm", "rightArm"] },
];

const LIMB_WORD: Readonly<Record<Limb, string>> = {
  leftArm: "left",
  rightArm: "right",
  leftLeg: "left",
  rightLeg: "right",
};

export interface AttackScoringInput {
  readonly battle: BattleState;
  readonly actor: UnitState;
  readonly targetId: string;
  readonly doctrine: Doctrine;
  readonly heatCeiling: number;
}

export interface AttackScoring {
  readonly candidates: TraceCandidate[];
  readonly notes: TraceNote[];
}

function weaponEv(w: FireWeapon): number {
  return hitProbability(w.tn) * expectedHitDamage(weaponDefFor(w), w.rangeBracket);
}

/** The prone prop variant with more expected damage (both are equal when standing). */
function weaponsOf(t: FireTarget): readonly FireWeapon[] {
  const sum = (l: readonly FireWeapon[]) => l.reduce((a, w) => a + weaponEv(w), 0);
  return sum(t.weaponsIfPropLeft) >= sum(t.weaponsIfPropRight)
    ? t.weaponsIfPropLeft
    : t.weaponsIfPropRight;
}

interface Volley {
  readonly weapons: FireWeapon[];
  readonly ev: number;
  readonly heat: number;
  readonly shots: number;
}

/**
 * Greedy weapon set: best expected damage per heat first, stopping at the
 * heat ceiling; ammo weapons only within the doctrine's TN limit and above
 * its reserve.
 */
function pickVolley(
  pool: readonly FireWeapon[],
  input: AttackScoringInput,
  startShots: Readonly<Record<string, number>>,
  notes: TraceNote[] | null,
): Volley {
  const { actor, doctrine, heatCeiling } = input;
  const ammo = doctrine.ammo;
  const allowed = pool.filter((w) => {
    if (w.shots === null) return true;
    if (w.tn > ammo.maxTn) {
      notes?.push({
        key: "dp.note.ammoTn",
        params: { weapon: w.weapon, tn: w.tn, max: ammo.maxTn },
      });
      return false;
    }
    const reserve = Math.ceil((startShots[w.weapon] ?? 0) * ammo.reserve);
    if (w.shots - 1 < reserve) {
      notes?.push({
        key: "dp.note.ammoReserve",
        params: { weapon: w.weapon, shots: w.shots, reserve },
      });
      return false;
    }
    return true;
  });
  const ranked = [...allowed].sort((a, b) => {
    if (ammo.energyFirst && (a.shots === null) !== (b.shots === null)) {
      return a.shots === null ? -1 : 1;
    }
    return weaponEv(b) / (b.heat + 1) - weaponEv(a) / (a.heat + 1);
  });
  const base = actor.heat + actor.heatPending - dissipationOf(actor);
  const weapons: FireWeapon[] = [];
  let heat = 0;
  let ev = 0;
  let shots = 0;
  for (const w of ranked) {
    const value = weaponEv(w);
    if (value <= 0) continue;
    if (base + heat + w.heat > heatCeiling) {
      notes?.push({ key: "dp.note.heatSkip", params: { weapon: w.weapon, heat: w.heat } });
      continue;
    }
    weapons.push(w);
    heat += w.heat;
    ev += value;
    if (w.shots !== null) shots++;
  }
  weapons.sort((a, b) => a.weaponIndex - b.weaponIndex);
  return { weapons, ev, heat, shots };
}

function pushRingsOut(battle: BattleState, actor: UnitState, target: UnitState): boolean {
  const ahead = neighbor(actor.position, actor.facing);
  if (ahead.col !== target.position.col || ahead.row !== target.position.row) return false;
  return offMap(battle, neighbor(target.position, actor.facing));
}

/** Every attack option scored, best first, plus notes on skipped choices. */
export function scoreAttacks(input: AttackScoringInput): AttackScoring {
  const { battle, actor, targetId, doctrine } = input;
  const w = doctrine.weights;
  const target = battle.units[targetId];
  const def = mechDefFor(actor);
  const startShots = pooledTotalsByWeaponName(def, loadAmmoBins(def));
  const notes: TraceNote[] = [];
  const candidates: TraceCandidate[] = [];
  const twists: Arc[] = actor.prone ? ["front"] : ["front", "leftSide", "rightSide"];

  const build = (
    twist: Arc,
    volley: Volley,
    physical: { option: PhysicalOption; value: number } | null,
  ): TraceCandidate => {
    const twistWord = TWIST_WORD[twist];
    const commands: string[] = [];
    const parts: string[] = [];
    if (twistWord !== undefined) {
      commands.push(`torso ${twistWord}`);
      parts.push(`torso ${twistWord}`);
    }
    if (volley.weapons.length > 0) {
      const idx = volley.weapons.map((x) => x.weaponIndex);
      commands.push(`fire ${targetId} ${idx.join(" ")}`);
      parts.push(`fire ${idx.join(",")}`);
    }
    if (physical !== null) {
      const { type, limb } = physical.option;
      const limbWord = limb !== undefined ? ` ${LIMB_WORD[limb]}` : "";
      commands.push(`${type} ${targetId}${limbWord}`);
      parts.push(`${type}${limbWord}`);
    }
    commands.push("done");
    const heatOver = Math.max(
      0,
      actor.heat + actor.heatPending - dissipationOf(actor) + volley.heat - input.heatCeiling,
    );
    const terms: TraceTerm[] = [
      { id: "ev", value: round1(volley.ev) },
      { id: "melee", value: round1(physical?.value ?? 0) },
      { id: "ammo", value: round1(-w.ammo * volley.shots) },
      { id: "heat", value: round1(-w.heat * heatOver) },
    ].filter((t) => t.value !== 0) as TraceTerm[];
    return {
      label: parts.length > 0 ? parts.join(" · ") : "hold fire",
      score: round1(terms.reduce((a, t) => a + t.value, 0)),
      terms,
      commands,
    };
  };

  candidates.push({ label: "hold fire", score: 0, terms: [], commands: ["done"] });
  if (target === undefined) return { candidates, notes };

  for (const twist of twists) {
    let sugg: ReturnType<typeof suggestFireTargets>;
    try {
      sugg = suggestFireTargets(battle, actor.id, twist);
    } catch {
      continue;
    }
    const t = sugg.targets.find((x) => x.targetId === targetId);
    const pool = t !== undefined ? weaponsOf(t) : [];
    const volley = pickVolley(pool, input, startShots, twist === "front" ? notes : null);
    if (volley.weapons.length > 0) candidates.push(build(twist, volley, null));

    if (doctrine.melee === "never" || hexDistance(actor.position, target.position) > 1) continue;
    for (const option of PHYSICAL_OPTIONS) {
      // Kick and push are feet/body attacks: the twist does not change them.
      if (option.type !== "punch" && twist !== "front") continue;
      const decl = {
        type: option.type,
        targetId,
        ...(option.limb !== undefined ? { limb: option.limb } : {}),
        twist,
      };
      if (!validatePhysicalAttack(battle, actor.id, decl, twist).ok) continue;
      const mods = computePhysicalToHit(battle, actor, target, option.type, option.limb);
      const p = hitProbability(mods.total);
      let value: number;
      if (option.type === "push") {
        if (!doctrine.ringOut || !pushRingsOut(battle, actor, target)) continue;
        value = RING_OUT_VALUE * p;
        notes.push({ key: "dp.note.ringOut", params: { target: targetId, tn: mods.total } });
      } else {
        if (
          option.type === "kick" &&
          doctrine.melee === "opportunistic" &&
          mods.total > CAUTIOUS_KICK_MAX_TN
        ) {
          notes.push({ key: "dp.note.kickRisk", params: { tn: mods.total } });
          continue;
        }
        value = MELEE_FACTOR[doctrine.melee] * p * physicalDamage(option.type, actor, option.limb);
      }
      const free = pool.filter((x) => !option.blocks.includes(x.location));
      candidates.push(build(twist, pickVolley(free, input, startShots, null), { option, value }));
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, notes: dedupeNotes(notes) };
}

function dedupeNotes(notes: readonly TraceNote[]): TraceNote[] {
  const seen = new Set<string>();
  return notes.filter((n) => {
    const k = `${n.key}|${JSON.stringify(n.params ?? {})}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
