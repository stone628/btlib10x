import {
  type AmmoPolicy,
  type Arc,
  type AttackDecl,
  type AttackResolution,
  type BattleState,
  type CriticalEffect,
  type CriticalResolution,
  type DamageTransferStep,
  declareAttacks,
  type FireBlockerReason,
  type FireSuggestion,
  type FireWeapon,
  type GameEvent,
  isArm,
  isTorso,
  isUnitDestroyed,
  isUnitImmobile,
  isUnitRemoved,
  type Location,
  type LocationValue,
  mechDefFor,
  parseAmmoPolicy,
  type RangeBracket,
  requireUnit,
  shoulderOf,
  suggestFireTargets,
  type TorsoLocationValue,
  validateAttacks,
  weaponDefFor,
} from "btlib10x";
import {
  buildCollapsibleChunk,
  buildHeaderTableChunkFromRows,
  buildLinesChunk,
  buildLinesChunkWith,
  type Chunk,
} from "./chunk";
import { i18n, type MessageKey } from "./i18n";
import { SHORT_LOC } from "./misc";
import { commitAtomic, drive, requireBattle, type Session, type SessionGameEvent } from "./session";
import { actorOrderLines } from "./session.common";

/** Eagerly allocated by `drive()` on weapon-attack-phase entry, nulled when
 *  the phase exits or a new actor becomes current. Carries `fireDecls`,
 *  `torsoTwist` (UI declaration, resets to `"front"` on allocation),
 *  `fireHintShownFor`, `fireCandidate`. */
export interface WeaponAttackContext {
  actorId: string;
  fireDecls: AttackDecl[];
  /** Acting unit's torso twist (TW pp.105-106) for the current attack-phase
   *  declaration: starts at `"front"` on context allocation (new actor or
   *  phase entry). Locked once any fire command is queued (see
   *  {@link setTorsoTwist}). Session-owned because it is a UI declaration,
   *  not persistent battle state. */
  torsoTwist: Arc;
  /** Actor (turn-qualified) whose fire suggestion was last auto-shown. */
  fireHintShownFor: string | null;
  fireCandidate: FireSuggestion | null;
}

/** Allocate a fresh attack context for `actorId`. `torsoTwist` starts at
 *  `"front"`; fire declarations and suggestion cache empty. */
export function initWeaponAttackContext(s: Session, actorId: string): WeaponAttackContext {
  const newContext: WeaponAttackContext = {
    actorId,
    fireDecls: [],
    torsoTwist: "front",
    fireHintShownFor: null,
    fireCandidate: null,
  };
  s.attack = newContext;
  return newContext;
}

export function weaponAttackContextInvalid(s: Session, actorId: string): boolean {
  return s.attack === null || s.attack.actorId !== actorId;
}

/** Mutator-side accessor for the active attack context. Throws if not in
 *  the weapon-attack phase. */
function requireBattleAndContext(s: Session): {
  battle: BattleState;
  context: WeaponAttackContext;
} {
  const battle = requireBattle(s);
  if (!s.attack || battle.phase !== "weaponAttack") {
    throw new Error(i18n("err.wrongPhase", { phase: "weaponAttack" }));
  }
  return { battle, context: s.attack };
}

export function requireWeaponAttackActor(s: Session) {
  const battle = requireBattle(s);
  if (!s.attack || battle.phase !== "weaponAttack") {
    throw new Error(i18n("err.wrongPhase", { phase: "weaponAttack" }));
  }
  return requireUnit(battle, s.attack.actorId);
}

function clearContext(s: Session) {
  s.attack = null;
}

export function queueWeaponFire(s: Session, decl: AttackDecl): void {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);
  if (decl.targetId === unit.id) throw new Error(i18n("err.selfTarget"));
  const target = battle.units[decl.targetId];
  if (!target) throw new Error(i18n("err.unknownUnitId", { id: decl.targetId }));
  if (target.team === unit.team) throw new Error(i18n("err.selfTarget"));
  if (isUnitRemoved(target)) throw new Error(i18n("err.targetRemoved", { id: target.id }));
  const pending = context.fireDecls[0]?.targetId;
  if (pending !== undefined && pending !== decl.targetId) {
    throw new Error(i18n("err.oneTarget", { target: pending }));
  }
  if (context.fireDecls.some((d) => d.weaponIndex === decl.weaponIndex)) {
    throw new Error(i18n("err.weaponRepeated", { weapon: decl.weaponIndex }));
  }
  validateAttacks(battle, unit.id, [...context.fireDecls, decl], { twist: context.torsoTwist });
  context.fireDecls.push(decl);
}

export function cancelWeaponFire(s: Session): void {
  const { context } = requireBattleAndContext(s);
  context.fireDecls = [];
}

export function commitWeaponFire(s: Session): SessionGameEvent[] {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const unitId = actor.id;
  const events: SessionGameEvent[] = [];
  if (context.fireDecls.length === 0) {
    commitAtomic(s, () => {
      actor.passedAttacks = true;
      clearContext(s);
      events.push(
        {
          kind: "sessionAttackActorDone",
          actorId: unitId,
          pass: true,
        },
        ...drive(s),
      );
    });
  } else {
    commitAtomic(s, () => {
      const collected: GameEvent[] = [];
      declareAttacks(battle, unitId, context.fireDecls, collected, s.rng, {
        twist: context.torsoTwist,
      });
      clearContext(s);
      events.push(
        ...collected,
        {
          kind: "sessionAttackActorDone",
          actorId: unitId,
          pass: false,
        },
        ...drive(s),
      );
    });
  }
  return events;
}

/**
 * Set the acting unit's torso twist (TW pp.105-106) for its current attack-phase
 * declaration. Locked once any fire command is queued — the user must
 * `cancel` first — and resets to `"front"` on phase entry or new actor.
 */
export function setTorsoTwist(s: Session, direction: string): void {
  const { context } = requireBattleAndContext(s);
  const allowed: Readonly<Record<string, Arc>> = {
    front: "front",
    left: "leftSide",
    right: "rightSide",
  };
  const arc = allowed[direction.toLowerCase()];
  if (arc === undefined) {
    throw new Error(i18n("err.twist.badDirection"));
  }
  if (context.fireDecls.length > 0) {
    throw new Error(i18n("err.twist.locked"));
  }
  if (context.torsoTwist === arc) return;
  context.torsoTwist = arc;
  context.fireCandidate = null;
  context.fireHintShownFor = null;
}

/**
 * Set the acting unit's ammo-depletion policy. Affects the order its ammo
 * bins are drained by future shots (and which bin explodes on a crit).
 */
export function setAmmoPolicy(s: Session, word: string): void {
  const unit = requireWeaponAttackActor(s);
  const policy: AmmoPolicy | null = parseAmmoPolicy(word);
  if (policy === null) throw new Error(i18n("err.badAmmoPolicy"));
  unit.ammoPolicy = policy;
}

const BRACKET_LABEL: Readonly<Record<RangeBracket, string>> = {
  short: "S",
  medium: "M",
  long: "L",
};

const BLOCKER_LABEL: Readonly<Record<FireBlockerReason, MessageKey>> = {
  jammed: "fireSuggestion.reason.jammed",
  destroyed: "fireSuggestion.reason.destroyed",
  outOfRange: "fireSuggestion.reason.outOfRange",
  outOfArc: "fireSuggestion.reason.outOfArc",
  noLos: "fireSuggestion.reason.noLos",
  outOfAmmo: "fireSuggestion.reason.outOfAmmo",
  autoMiss: "fireSuggestion.reason.autoMiss",
  prone: "fireSuggestion.reason.prone",
  noSensor: "fireSuggestion.reason.noSensor",
};

const ARC_LABEL: Readonly<Record<Arc, MessageKey>> = {
  front: "fireSuggestion.arc.front",
  rear: "fireSuggestion.arc.rear",
  leftSide: "fireSuggestion.arc.leftSide",
  rightSide: "fireSuggestion.arc.rightSide",
};

const TWIST_LABEL: Readonly<Record<Arc, MessageKey>> = {
  front: "fireSuggestion.twist.front",
  leftSide: "fireSuggestion.twist.left",
  rightSide: "fireSuggestion.twist.right",
  rear: "fireSuggestion.twist.front",
};

function fireWeaponTable(weapons: readonly FireWeapon[]): Chunk {
  const header = [
    i18n("fireSuggestion.colIndex"),
    i18n("fireSuggestion.colWeapon"),
    i18n("fireSuggestion.colLoc"),
    i18n("fireSuggestion.colBracket"),
    i18n("fireSuggestion.colTn"),
    i18n("fireSuggestion.colHeat"),
    i18n("fireSuggestion.colDmg"),
    i18n("fireSuggestion.colShots"),
  ];
  const rows = weapons.map((w) => [
    `#${w.weaponIndex}`,
    w.weapon,
    SHORT_LOC[w.location],
    w.minRangePenalty !== undefined
      ? `[${BRACKET_LABEL[w.rangeBracket]}!]`
      : `[${BRACKET_LABEL[w.rangeBracket]}]`,
    w.minRangePenalty !== undefined
      ? `${w.tn - w.minRangePenalty}+${w.minRangePenalty}`
      : String(w.tn),
    String(w.heat),
    w.cluster !== undefined
      ? `${w.expectedDamage} (${i18n("fireSuggestion.cluster", {
          shots: String(w.cluster.shots),
          per: String(w.cluster.perMissile),
        })})`
      : String(w.expectedDamage),
    w.shots !== null ? `${w.shots}` : "",
  ]);
  return buildHeaderTableChunkFromRows(header, rows);
}

function blockedLines(
  list: readonly { weaponIndex: number; weapon: string; reason: FireBlockerReason }[],
): string[] {
  return list.map(
    (b) =>
      `${i18n("fireSuggestion.blocked")}: #${b.weaponIndex} ${b.weapon} — ${i18n(BLOCKER_LABEL[b.reason])}`,
  );
}

function blockedChunks(list: ReturnType<typeof blockedLines>): Chunk[] {
  if (list.length === 0) return [];
  if (list.length > 3) {
    return [
      buildCollapsibleChunk(i18n("fireSuggestion.blockedSummary", { num: list.length }), [
        buildLinesChunkWith("hint", ...list),
      ]),
    ];
  }
  return [buildLinesChunkWith("hint", ...list)];
}

// export function fireSuggestionChunks(sugg: FireSuggestion, twist: Arc | null = null): Chunk[] {
export function fireSuggestionChunks(s: Session): Chunk[] {
  const { context } = requireBattleAndContext(s);
  const sugg = context.fireCandidate!;
  const twist = context.torsoTwist;
  const chunks: Chunk[] = [
    buildLinesChunkWith("hint", i18n("fireSuggestion.header", { id: sugg.targetId })),
  ];
  if (twist !== null) {
    chunks.push(
      buildLinesChunkWith("hint", i18n("fireSuggestion.twist", { dir: i18n(TWIST_LABEL[twist]) })),
    );
  }
  if (sugg.targets.length === 0) {
    chunks.push(buildLinesChunkWith("hint", i18n("fireSuggestion.noTargets")));
    return chunks;
  }
  for (const target of sugg.targets) {
    chunks.push(
      buildLinesChunkWith(
        "hint",
        i18n("fireSuggestion.target", {
          id: target.targetId,
          distance: String(target.distance),
          arc: target.arc !== null ? i18n(ARC_LABEL[target.arc]) : "—",
        }),
      ),
    );
    const split =
      target.weaponsIfPropLeft.length !== target.weaponsIfPropRight.length ||
      target.weaponsIfPropLeft.some(
        (w, i) => w.weaponIndex !== target.weaponsIfPropRight[i]?.weaponIndex,
      ) ||
      target.blockedIfPropLeft.length !== target.blockedIfPropRight.length;
    if (split) {
      chunks.push(
        buildLinesChunkWith(
          "hint",
          i18n("fireSuggestion.propLeft", { num: target.weaponsIfPropLeft.length }),
        ),
      );
      if (target.weaponsIfPropLeft.length > 0) {
        chunks.push(fireWeaponTable(target.weaponsIfPropLeft));
      }
      chunks.push(...blockedChunks(blockedLines(target.blockedIfPropLeft)));
      chunks.push(
        buildLinesChunkWith(
          "hint",
          i18n("fireSuggestion.propRight", { num: target.weaponsIfPropRight.length }),
        ),
      );
      if (target.weaponsIfPropRight.length > 0) {
        chunks.push(fireWeaponTable(target.weaponsIfPropRight));
      }
      chunks.push(...blockedChunks(blockedLines(target.blockedIfPropRight)));
      continue;
    }
    if (target.weapons.length > 0) {
      chunks.push(fireWeaponTable(target.weapons));
    }
    chunks.push(...blockedChunks(blockedLines(target.blocked)));
  }
  return chunks;
}

export function attackStatusChunk(s: Session): Chunk {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const lines: string[] = [];
  lines.push(...actorOrderLines(s), i18n("attackStatus.header"));
  const decls = context.fireDecls ?? [];
  if (decls.length === 0) {
    lines.push(i18n("attackStatus.none"));
  } else {
    // Engine guarantee: `actor.model` was validated by `createBattle`.
    const def = mechDefFor(actor);
    for (const decl of decls) {
      const mount = def.weapons[decl.weaponIndex];
      const name = mount ? mount.weapon : `#${decl.weaponIndex}`;
      const rapid = mount ? weaponDefFor(mount).rapidFireShots : undefined;
      const suffix = decl.rapidFire && rapid !== undefined ? ` (rapid-fire x${rapid})` : "";
      lines.push(
        i18n("attackStatus.weapon", {
          weaponIndex: decl.weaponIndex,
          weaponName: name,
          targetId: decl.targetId,
          suffix,
        }),
      );
    }
  }
  return buildLinesChunk(...lines);
}

/** Labeled GATOR breakdown: "gunnery 4 + move 1 + terrain 1 + range 2". */
function gatorText(r: AttackResolution): string {
  if (r.breakdown.outOfRange) return i18n("res.outOfRange");
  const b = r.breakdown;
  const parts = [`gunnery ${b.gunnery}`];
  if (b.attackerMod) parts.push(`move ${b.attackerMod}`);
  if (b.targetMod) parts.push(`target ${b.targetMod}`);
  if (b.terrainMod) parts.push(`terrain ${b.terrainMod}`);
  if (b.rangeMod) parts.push(`range ${b.rangeMod}`);
  if (b.minRangeMod) parts.push(`min ${b.minRangeMod}`);
  if (b.pulseMod) parts.push(`pulse ${b.pulseMod}`);
  if (b.heatMod) parts.push(`heat ${b.heatMod}`);
  if (b.sensorMod) parts.push(`sensors ${b.sensorMod}`);
  const total = b.automatic === "hit" ? i18n("res.needAuto") : String(b.total);
  return `${i18n("res.need", { total })} (${parts.join(" + ")})`;
}

export function resolutionLines(r: AttackResolution): string[] {
  if (r.breakdown.outOfRange) {
    return [i18n("res.outOfRangeLine", { weapon: r.weapon, distance: r.distance })];
  }
  const verdict =
    r.breakdown.automatic === "hit"
      ? i18n("res.autoHit")
      : r.hit
        ? i18n("res.hit")
        : i18n("res.miss");
  const lines = [
    i18n("res.line", {
      weapon: r.weapon,
      gator: gatorText(r),
      roll: r.toHitRoll === null ? "—" : String(r.toHitRoll),
      verdict,
      jam: r.jammed ? i18n("res.jamSuffix") : "",
    }),
  ];
  if (r.ammoExhausted === true) lines.push(i18n("res.outOfAmmo", { weapon: r.weapon }));
  if (r.clusterRoll !== null) lines.push(i18n("res.clusterRoll", { roll: r.clusterRoll }));
  if (r.hit && r.groups.length > 0) {
    lines.push(
      i18n("res.hits", {
        groups: r.groups.map((g) => formatHitGroup(g)).join(" "),
        arc: i18n(ARC_LABEL[r.arc]),
      }),
    );
    const detail = transferDetail(r);
    if (detail) lines.push(`  ${detail}`);
  }
  for (const crit of r.crits) {
    for (const line of critLines(crit)) lines.push(`  ${line}`);
  }
  return lines;
}

/** One damage group label, tagged when the hit location rolled a through-armor 2. */
function formatHitGroup(g: { location: Location; damage: number; throughArmor?: boolean }): string {
  const base = `${SHORT_LOC[g.location]}(${g.damage})`;
  return g.throughArmor === true ? `${base} [${i18n("res.throughArmorTag")}]` : base;
}

/** Pretty-print one CriticalResolution into one or more terminal lines. */
export function critLines(c: CriticalResolution): string[] {
  const headerKey =
    c.determiningRoll <= 7
      ? "res.critNone"
      : c.determiningRoll <= 9
        ? "res.critOne"
        : c.determiningRoll <= 11
          ? "res.critTwo"
          : "res.critThree";
  const lines: string[] = [
    i18n("res.critHeader", {
      roll: String(c.determiningRoll),
      count: `${i18n(headerKey)}${c.throughArmor ? ` [${i18n("res.throughArmorTag")}]` : ""}`,
    }),
  ];
  for (const eff of c.rows) lines.push(`  ${formatCritEffect(eff)}`);
  return lines;
}

export function transferDetail(r: AttackResolution): string | null {
  const app = r.application;
  if (!app || app.steps.length === 0) return null;
  const wasImmobile = isUnitImmobile(app.before);
  const wasDestroyed = isUnitDestroyed(app.before);
  const run = {
    armor: { ...app.before.armor },
    armorRear: { ...app.before.armorRear } as TorsoLocationValue,
    structure: { ...app.before.internalStructure },
  };
  const bits: string[] = [];
  for (const step of app.steps) {
    const before = poolValue(step, run);
    const after = before - step.damageApplied;
    setPoolValue(step, after, run);
    bits.push(
      `${SHORT_LOC[step.location]}${stepLabel(step)} ${before}->${after}${step.depleted ? "*" : ""}`,
    );
  }
  let text = bits.join(", ");
  for (const arm of app.blownOffArms) {
    if (!isArm(arm)) continue;
    const cause = shoulderOf(arm);
    text += i18n("res.armBlownOff", { cause: SHORT_LOC[cause], arm: SHORT_LOC[arm] });
  }
  const otherDestroyed = app.newlyDestroyed.filter((loc) => !app.blownOffArms.includes(loc));
  if (otherDestroyed.length > 0) {
    text += i18n("res.destroyedTail", {
      locs: otherDestroyed.map((l) => SHORT_LOC[l]).join(", "),
    });
  }
  if (isUnitImmobile(app.after) && !wasImmobile) text += i18n("res.immobilized");
  if (app.killed && !wasDestroyed) text += i18n("res.killed");
  return text;
}

function formatCritEffect(eff: CriticalEffect): string {
  switch (eff.kind) {
    case "headBlownOff":
      return i18n("res.critHeadBlownOff");
    case "armBlownOff":
      return i18n("res.critArmBlownOff", { arm: SHORT_LOC[eff.arm] });
    case "legBlownOff":
      return i18n("res.critLegBlownOff", { leg: SHORT_LOC[eff.leg] });
    case "weaponDestroyed":
      return i18n("res.critWeaponDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        weapon: eff.weaponName,
      });
    case "ammoExplosion":
      return i18n("res.critAmmoExplosion", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        weapon: eff.weaponName,
        damage: String(eff.damage),
      });
    case "cockpitDestroyed":
      return i18n("res.critCockpitDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
      });
    case "componentDestroyed":
      return i18n("res.critComponentDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
        name: eff.name,
      });
    case "engineDestroyed":
      return i18n("res.critEngineDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
      });
    case "noEffect":
      return i18n("res.critNoEffect", { loc: "reroll" });
  }
  return "";
}

function poolValue(
  step: DamageTransferStep,
  run: {
    armor: LocationValue;
    armorRear: TorsoLocationValue;
    structure: LocationValue;
  },
): number {
  switch (step.pool) {
    case "armor":
      return run.armor[step.location] ?? 0;
    case "armorRear":
      return isTorso(step.location) ? (run.armorRear[step.location] ?? 0) : 0;
  }
  return run.structure[step.location] ?? 0;
}

function setPoolValue(
  step: DamageTransferStep,
  value: number,
  run: {
    armor: LocationValue;
    armorRear: TorsoLocationValue;
    structure: LocationValue;
  },
): void {
  switch (step.pool) {
    case "armor":
      run.armor[step.location] = value;
      break;
    case "armorRear":
      if (isTorso(step.location)) run.armorRear[step.location] = value;
      break;
    default:
      run.structure[step.location] = value;
      break;
  }
}

/**
 * Per-pool, per-location running totals over `app.steps`. Start from `app.before`
 * so each step's decrement reads the value present *before that step ran*,
 * which is the value visible to the player in the per-step `before→after`
 * label. The engine provides `app.before` directly (snapshot taken at
 * `applyDamage` entry), so no reconstruction from `after` is needed.
 */
function stepLabel(step: DamageTransferStep): string {
  if (step.pool === "armor") {
    // A location carrying a defined rear pool stores its active value as
    // front armor (F); one without a rear pool holds plain armor (A).
    return isTorso(step.location) ? "F" : "A";
  }
  return step.pool === "armorRear" ? "R" : "I";
}

export function onEnterWeaponAttack(s: Session, sink: SessionGameEvent[]) {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  context.fireCandidate = suggestFireTargets(battle, actor.id, context.torsoTwist);
  sink.push({ kind: "sessionAttackActor", actorId: actor.id });
}
