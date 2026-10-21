/**
 * Attack scoring for the persona player (GDD §9.1, attack): for each torso
 * twist, pick a weapon set against the committed target under the persona's
 * heat ceiling and ammo discipline, then weigh every legal physical plan
 * (punch with one or both arms, kick, physical-weapon strike, club swing,
 * dropping a held club, picking one up) against the weapons it gives up.
 *
 * Rules used: one target per turn; one type of physical attack per turn,
 * except one punch per arm (TW p. 144); a limb that punches, kicks or
 * strikes cannot fire its weapons, a club bars every arm weapon, and a held
 * club occupies both hands until dropped (TW pp. 144–146); a pickup is the
 * unit's whole attack (TW p. 146). Every plan is checked by the engine's
 * `validateAttacks` before it is scored; to-hit and damage come straight
 * from the engine (`computePhysicalToHit`, `physicalDamage`, TW pp. 145–147).
 * Charge and DFA are declared by movement (`persona.move.ts`).
 */
import {
  type Arc,
  type BattleState,
  computePhysicalToHit,
  designTotalsByWeaponName,
  type FireTarget,
  type FireWeapon,
  hexDistance,
  hitProbability,
  isArm,
  type Location,
  mechDefFor,
  type PhysicalAttackDecl,
  type PhysicalWeaponName,
  physicalDamage,
  physicalToHitTotal,
  strikeMounts,
  suggestFireTargets,
  type Twist,
  type UnitState,
  validateAttacks,
  validatePickup,
  weaponDefFor,
} from "btlib10x";
import {
  dissipationOf,
  expectedHitDamage,
  round1,
  type TraceCandidate,
  type TraceNote,
  type TraceTerm,
} from "./persona.common";
import { isMeleeBiased, MELEE_FACTOR, type Persona } from "./persona.data";

/** Kicks risk a fall on a miss (TW p. 147): Opportunistic personas skip worse TNs
 *  (Never personas do not reach physical options at all). */
const CAUTIOUS_KICK_MAX_TN = 8;
/** A picked-up club pays off on later turns: one future swing, discounted. */
const PICKUP_DISCOUNT = 0.5;

const TWIST_WORD: Readonly<Record<string, string>> = {
  leftSide: "left",
  rightSide: "right",
};

type Limb = "leftArm" | "rightArm" | "leftLeg" | "rightLeg";

const LIMB_WORD: Readonly<Record<Limb, string>> = {
  leftArm: "left",
  rightArm: "right",
  leftLeg: "left",
  rightLeg: "right",
};

/** One physical attack plan for a turn: what it declares and what it costs. */
interface PhysicalPlan {
  readonly decls: readonly PhysicalAttackDecl[];
  /** Drop the held club first (frees both hands for this plan). */
  readonly drop: boolean;
  /** Weapon locations the plan keeps from firing. */
  readonly blocks: (loc: Location) => boolean;
}

export interface AttackScoringInput {
  readonly battle: BattleState;
  readonly actor: UnitState;
  readonly targetId: string;
  readonly persona: Persona;
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
 * heat ceiling; ammo weapons only within the persona's TN limit and above
 * its reserve.
 */
function pickVolley(
  pool: readonly FireWeapon[],
  input: AttackScoringInput,
  startShots: Readonly<Record<string, number>>,
  notes: TraceNote[] | null,
): Volley {
  const { actor, persona, heatCeiling } = input;
  const ammo = persona.ammo;
  const allowed = pool.filter((w) => {
    if (w.shots === null) return true;
    if (w.tn > ammo.maxTn) {
      notes?.push({
        key: "pp.note.ammoTn",
        params: { weapon: w.weapon, tn: w.tn, max: ammo.maxTn },
      });
      return false;
    }
    const reserve = Math.ceil((startShots[w.weapon] ?? 0) * ammo.reserve);
    if (w.shots - 1 < reserve) {
      notes?.push({
        key: "pp.note.ammoReserve",
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
      notes?.push({ key: "pp.note.heatSkip", params: { weapon: w.weapon, heat: w.heat } });
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

const only =
  (...locs: Location[]) =>
  (loc: Location): boolean =>
    locs.includes(loc);

/**
 * Every physical plan worth checking this turn (before engine validation):
 * single and double punches, kicks (front twist only: a kick ignores the
 * twist), one strike per mounted physical weapon, and the club swing. While
 * a club is held, punches and strikes only come with a drop.
 */
function physicalPlans(actor: UnitState, targetId: string, twist: Arc): PhysicalPlan[] {
  const holding = actor.club !== null;
  const plans: PhysicalPlan[] = [];
  const punch = (limb: "leftArm" | "rightArm"): PhysicalAttackDecl => ({
    type: "punch",
    targetId,
    limb,
  });
  plans.push(
    { decls: [punch("leftArm")], drop: holding, blocks: only("leftArm") },
    { decls: [punch("rightArm")], drop: holding, blocks: only("rightArm") },
    {
      decls: [punch("leftArm"), punch("rightArm")],
      drop: holding,
      blocks: only("leftArm", "rightArm"),
    },
  );
  if (twist === "front") {
    for (const limb of ["leftLeg", "rightLeg"] as const) {
      plans.push({ decls: [{ type: "kick", targetId, limb }], drop: false, blocks: only(limb) });
    }
  }
  for (const { arm, weapon } of strikeMounts(mechDefFor(actor))) {
    plans.push({
      decls: [{ type: "strike", targetId, limb: arm, weapon }],
      drop: holding,
      blocks: only(arm),
    });
  }
  if (holding) plans.push({ decls: [{ type: "club", targetId }], drop: false, blocks: isArm });
  return plans;
}

function physicalWord(d: PhysicalAttackDecl): string {
  if (d.type === "club") return "club";
  const limb = d.limb !== undefined ? LIMB_WORD[d.limb] : "";
  if (d.type === "strike") return `strike ${limb} (${(d.weapon ?? "").toLowerCase()})`;
  return `${d.type} ${limb}`;
}

function physicalCommand(d: PhysicalAttackDecl): string {
  if (d.type === "club") return `club ${d.targetId}`;
  const limb = d.limb !== undefined ? ` ${LIMB_WORD[d.limb]}` : "";
  return `${d.type} ${d.targetId}${limb}`;
}

/** Engine check of one whole declaration (weapons + physical + twist + drop). */
function legal(
  battle: BattleState,
  actor: UnitState,
  targetId: string,
  weapons: readonly FireWeapon[],
  decls: readonly PhysicalAttackDecl[],
  twist: Twist,
  drop: boolean,
): boolean {
  try {
    validateAttacks(
      battle,
      actor.id,
      weapons.map((w) => ({ targetId, weaponIndex: w.weaponIndex })),
      decls,
      { twist, dropClub: drop },
    );
    return true;
  } catch {
    return false;
  }
}

/** Every attack option scored, best first, plus notes on skipped choices. */
export function scoreAttacks(input: AttackScoringInput): AttackScoring {
  const { battle, actor, targetId, persona } = input;
  const w = persona.weights;
  const target = battle.units[targetId];
  const def = mechDefFor(actor);
  const startShots = designTotalsByWeaponName(def);
  const notes: TraceNote[] = [];
  const candidates: TraceCandidate[] = [];
  const twists: Twist[] = actor.prone ? ["front"] : ["front", "leftSide", "rightSide"];
  const factor = MELEE_FACTOR[persona.melee];
  const holding = actor.club !== null;

  const build = (
    twist: Arc,
    volley: Volley,
    plan: { decls: readonly PhysicalAttackDecl[]; drop: boolean; value: number } | null,
  ): TraceCandidate => {
    const twistWord = TWIST_WORD[twist];
    const commands: string[] = [];
    const parts: string[] = [];
    if (twistWord !== undefined) {
      commands.push(`torso ${twistWord}`);
      parts.push(`torso ${twistWord}`);
    }
    if (plan?.drop === true) {
      commands.push("drop");
      parts.push("drop club");
    }
    if (volley.weapons.length > 0) {
      const idx = volley.weapons.map((x) => x.weaponIndex);
      commands.push(`fire ${targetId} ${idx.join(" ")}`);
      parts.push(`fire ${idx.join(",")}`);
    }
    for (const d of plan?.decls ?? []) {
      commands.push(physicalCommand(d));
      parts.push(physicalWord(d));
    }
    commands.push("done");
    const heatOver = Math.max(
      0,
      actor.heat + actor.heatPending - dissipationOf(actor) + volley.heat - input.heatCeiling,
    );
    const terms: TraceTerm[] = [
      { id: "ev", value: round1(volley.ev) },
      { id: "melee", value: round1(plan?.value ?? 0) },
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

  /** Expected physical damage of one declaration, or null when the persona skips it. */
  const physicalValue = (d: PhysicalAttackDecl): number | null => {
    const limb = d.limb as Limb | undefined;
    const weapon = d.weapon as PhysicalWeaponName | undefined;
    const tn = physicalToHitTotal(
      computePhysicalToHit(battle, actor, target, d.type, limb, weapon),
    );
    if (d.type === "kick" && persona.melee === "opportunistic" && tn > CAUTIOUS_KICK_MAX_TN) {
      notes.push({ key: "pp.note.kickRisk", params: { tn } });
      return null;
    }
    return factor * hitProbability(tn) * physicalDamage(d.type, actor, limb, weapon);
  };

  const adjacent = hexDistance(actor.position, target.position) <= 1;
  for (const twist of twists) {
    let sugg: ReturnType<typeof suggestFireTargets>;
    try {
      sugg = suggestFireTargets(battle, actor.id, twist);
    } catch {
      continue;
    }
    const t = sugg.targets.find((x) => x.targetId === targetId);
    const pool = t !== undefined ? weaponsOf(t) : [];
    // A held club occupies both hands: arm weapons fire only after a drop.
    const handsFree = holding ? pool.filter((x) => !isArm(x.location)) : pool;
    const volley = pickVolley(handsFree, input, startShots, twist === "front" ? notes : null);
    if (
      volley.weapons.length > 0 &&
      legal(battle, actor, targetId, volley.weapons, [], twist, false)
    ) {
      candidates.push(build(twist, volley, null));
    }
    if (holding) {
      const dropped = pickVolley(pool, input, startShots, null);
      if (
        dropped.weapons.length > 0 &&
        legal(battle, actor, targetId, dropped.weapons, [], twist, true)
      ) {
        candidates.push(build(twist, dropped, { decls: [], drop: true, value: 0 }));
      }
    }

    if (persona.melee === "never" || !adjacent) continue;
    for (const plan of physicalPlans(actor, targetId, twist)) {
      if (!legal(battle, actor, targetId, [], plan.decls, twist, plan.drop)) continue;
      const values = plan.decls.map(physicalValue);
      if (values.some((v) => v === null)) continue;
      const value = values.reduce((a: number, v) => a + (v ?? 0), 0);
      const free = (plan.drop ? pool : handsFree).filter((x) => !plan.blocks(x.location));
      let sideVolley = pickVolley(free, input, startShots, null);
      if (!legal(battle, actor, targetId, sideVolley.weapons, plan.decls, twist, plan.drop)) {
        sideVolley = { weapons: [], ev: 0, heat: 0, shots: 0 };
      }
      candidates.push(build(twist, sideVolley, { decls: plan.decls, drop: plan.drop, value }));
    }
  }

  // Club pickup (physical-biased personas): the whole attack phase for one
  // future swing at the target, worth only what the swing adds over the
  // unit's best bare-handed attack (a kick, or both punches) and less the arm
  // weapons the club will bar.
  if (isMeleeBiased(persona) && !holding) {
    const pickup = validatePickup(battle, actor.id);
    if (pickup.ok) {
      const expected = (d: PhysicalAttackDecl): number => {
        const limb = d.limb as Limb | undefined;
        const tn = physicalToHitTotal(computePhysicalToHit(battle, actor, target, d.type, limb));
        return factor * hitProbability(tn) * physicalDamage(d.type, actor, limb);
      };
      const swing = expected({ type: "club", targetId });
      const bare = Math.max(
        expected({ type: "kick", targetId, limb: "leftLeg" }),
        expected({ type: "kick", targetId, limb: "rightLeg" }),
        expected({ type: "punch", targetId, limb: "leftArm" }) +
          expected({ type: "punch", targetId, limb: "rightArm" }),
      );
      let armEv = 0;
      try {
        const t = suggestFireTargets(battle, actor.id, "front").targets.find(
          (x) => x.targetId === targetId,
        );
        armEv = (t !== undefined ? weaponsOf(t) : [])
          .filter((x) => isArm(x.location))
          .reduce((a, x) => a + weaponEv(x), 0);
      } catch {
        // No fire suggestion: no arm weapons to give up.
      }
      const value = round1(PICKUP_DISCOUNT * (swing - bare - armEv));
      if (value > 0) {
        candidates.push({
          label: `pickup ${pickup.source}`,
          score: value,
          terms: [{ id: "melee", value }],
          commands: [`pickup ${pickup.source}`, "done"],
        });
      }
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
