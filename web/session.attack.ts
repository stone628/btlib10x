import {
  type AmmoPolicy,
  type Arc,
  type ArmLocation,
  type AttackResolution,
  type BattleState,
  type ClubKind,
  type ClubPickupDecl,
  type CriticalEffect,
  type CriticalResolution,
  type DamageApplication,
  type DamageTransferStep,
  declareAttacks,
  type FireBlockerReason,
  type FireSuggestion,
  type FireWeapon,
  type GameEvent,
  type HitGroup,
  hexDistance,
  isAdjacent,
  isArm,
  isLimb,
  isTorso,
  isUnitDestroyed,
  isUnitImmobile,
  isUnitRemoved,
  type LegLocation,
  type Location,
  type LocationValue,
  mechDefFor,
  type PhysicalAttackDecl,
  type PhysicalAttackType,
  type PhysicalResolution,
  type PhysicalWeaponName,
  type PilotingRollResult,
  type RangeBracket,
  requireUnit,
  resolveStrikeArm,
  resolveStrikeMount,
  shoulderOf,
  strikeMounts,
  suggestFireTargets,
  type TorsoLocationValue,
  validateAttacks,
  validatePhysicalAttack,
  validatePickup,
  type AttackDecl as WeaponAttackDecl,
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
 *  the phase exits or a new actor becomes current. Carries `fireDecls`
 *  (weapon volley, single target) plus `physicalDecls` (punch, kick, push,
 *  club, strike — TW p.144 one-type-per-turn rule, two-arm punch excepted),
 *  `pickupDecl` (exclusive club acquisition, TW p.146), `dropClub` (first act
 *  of a declaration, frees hands for the rest), `torsoTwist` (UI declaration,
 *  resets to `"front"` on allocation), `fireHintShownFor`, `fireCandidate`. */
export interface AttackContext {
  actorId: string;
  weaponDecls: WeaponAttackDecl[];
  physicalDecls: PhysicalAttackDecl[];
  pickupDecl: ClubPickupDecl | null;
  dropClub: boolean;
  /** Acting unit's torso twist (TW pp.105-106) for the current attack-phase
   *  declaration: starts at `"front"` on context allocation (new actor or
   *  phase entry). Locked once any weapon attack is queued, or once a punch,
   *  club, or strike is queued (twist governs their arcs, TW pp. 98–99) —
   *  kick and push are feet-based and never lock it (see {@link setTorsoTwist}).
   *  Session-owned because it is a UI declaration, not persistent battle
   *  state. */
  torsoTwist: Arc;
  fireCandidate: FireSuggestion | null;
}

/** Allocate a fresh attack context for `actorId`. `torsoTwist` starts at
 *  `"front"`; fire declarations and suggestion cache empty. */
export function initAttackContext(s: Session, actorId: string): AttackContext {
  const newContext: AttackContext = {
    actorId,
    weaponDecls: [],
    physicalDecls: [],
    pickupDecl: null,
    dropClub: false,
    torsoTwist: "front",
    fireCandidate: null,
  };
  s.attack = newContext;
  return newContext;
}

export function attackContextInvalid(s: Session, actorId: string): boolean {
  return s.attack === null || s.attack.actorId !== actorId;
}

/** Mutator-side accessor for the active attack context. Throws if not in
 *  the weapon-attack phase. */
function requireBattleAndContext(s: Session): {
  battle: BattleState;
  context: AttackContext;
} {
  const battle = requireBattle(s);
  if (!s.attack || battle.phase !== "attack") {
    throw new Error(i18n("err.wrongPhase", { phase: "attack" }));
  }
  return { battle, context: s.attack };
}

export function requireAttackActor(s: Session) {
  const battle = requireBattle(s);
  if (!s.attack || battle.phase !== "attack") {
    throw new Error(i18n("err.wrongPhase", { phase: "attack" }));
  }
  return requireUnit(battle, s.attack.actorId);
}

function clearContext(s: Session) {
  s.attack = null;
}

export function queueWeaponAttacks(s: Session, targetId: string, weapons: number[]): string[] {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);
  if (targetId === unit.id) throw new Error(i18n("err.selfTarget"));
  const target = battle.units[targetId];
  if (!target) throw new Error(i18n("err.unknownUnitId", { id: targetId }));
  if (target.team === unit.team) throw new Error(i18n("err.selfTarget"));
  if (isUnitRemoved(target)) throw new Error(i18n("err.targetRemoved", { id: target.id }));
  // Pickup is exclusive with everything (TW p.146): no weapon or physical
  // attacks allowed on the pickup turn.
  if (context.pickupDecl !== null) throw new Error(i18n("err.pickup.exclusive"));
  const pending = context.weaponDecls[0]?.targetId;
  if (pending !== undefined && pending !== targetId) {
    throw new Error(i18n("err.oneTarget", { target: pending }));
  }
  const def = mechDefFor(unit);
  const warnings: string[] = [];
  const decls: WeaponAttackDecl[] = [];
  for (const weaponIndex of weapons) {
    const mount = def.weapons[weaponIndex];
    if (!mount) {
      throw new Error(i18n("err.weaponIndex", { unit: unit.id, index: String(weaponIndex) }));
    }
    const weapon = weaponDefFor(mount);
    const dist = hexDistance(unit.position, target.position);
    if (dist > weapon.long) {
      throw new Error(
        i18n("err.overRange", {
          weapon: mount.weapon,
          dist: String(dist),
          max: String(weapon.long),
        }),
      );
    }
    if (weapon.minRange !== undefined && dist <= weapon.minRange) {
      warnings.push(
        i18n("err.minRange", {
          weapon: mount.weapon,
          dist: String(dist),
          min: String(weapon.minRange),
          penalty: String(weapon.minRange - dist + 1),
        }),
      );
    }
    if (context.weaponDecls.some((d) => d.weaponIndex === weaponIndex)) {
      throw new Error(i18n("err.weaponRepeated", { weapon: weaponIndex }));
    }
    decls.push({ targetId, weaponIndex });
  }
  // Physical-attack interaction (TW pp. 145–147): a punching or striking
  // arm or kicking leg cannot fire its mounted weapons; a pushing /
  // clubbing 'Mech fires no arm-mounted weapons at all.
  const punchedArms: ReadonlySet<Location> = new Set(
    context.physicalDecls.flatMap((d) =>
      d.type === "punch" && d.limb !== undefined ? [d.limb] : [],
    ),
  );
  const struckArms: ReadonlySet<Location> = new Set(
    context.physicalDecls.flatMap((d) => {
      if (d.type !== "strike" || d.weapon === undefined) return [];
      const arm = resolveStrikeArm(def, d.weapon, d.limb);
      return arm !== null ? [arm] : [];
    }),
  );
  const kickedLegs: ReadonlySet<Location> = new Set(
    context.physicalDecls.flatMap((d) =>
      d.type === "kick" && d.limb !== undefined ? [d.limb] : [],
    ),
  );
  const noArmWeapons = context.physicalDecls.some((d) => d.type === "push" || d.type === "club");
  for (const decl of decls) {
    const loc = def.weapons[decl.weaponIndex]?.location;
    if (loc === undefined) continue;
    if (punchedArms.has(loc)) {
      throw new Error(i18n("err.physical.armConflict", { limb: loc }));
    }
    if (struckArms.has(loc)) {
      throw new Error(i18n("err.physical.strikeConflict", { limb: loc }));
    }
    if (kickedLegs.has(loc)) {
      throw new Error(i18n("err.physical.legConflict", { limb: loc }));
    }
    if (noArmWeapons && isArm(loc)) {
      throw new Error(i18n("err.physical.noArmWeapons"));
    }
  }
  validateAttacks(battle, unit.id, [...context.weaponDecls, ...decls], context.physicalDecls, {
    twist: context.torsoTwist,
  });
  context.weaponDecls.push(...decls);
  context.fireCandidate = null;
  return warnings;
}

export function cancelAttack(s: Session): void {
  const { context } = requireBattleAndContext(s);
  context.weaponDecls = [];
  context.physicalDecls = [];
}

export function commitAttack(s: Session): SessionGameEvent[] {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const unitId = actor.id;
  const events: SessionGameEvent[] = [];
  if (context.weaponDecls.length === 0 && context.physicalDecls.length === 0) {
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
      declareAttacks(battle, unitId, context.weaponDecls, context.physicalDecls, collected, s.rng, {
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

// ---------------------------------------------------------------------------
// Physical attacks (punch, kick, push, club, strike)
// ---------------------------------------------------------------------------

/** Queue a physical attack declaration. Validates and appends to the
 *  attack context's physical list (kept separate from the weapon volley so
 *  physical targets stay independent of the single-target weapon rule).
 *  For strikes the limb selects the mount: omitted resolves to the sole
 *  mounted physical weapon, and an explicitly named empty arm (or a unit
 *  with no mounts, or mounts in both arms and no selection) is rejected. */
export function queuePhysicalAttack(
  s: Session,
  type: PhysicalAttackType,
  targetId: string,
  limb?: ArmLocation | LegLocation,
): string[] {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);
  if (targetId === unit.id) throw new Error(i18n("err.selfTarget"));
  const target = battle.units[targetId];
  if (!target) throw new Error(i18n("err.unknownUnitId", { id: targetId }));
  if (target.team === unit.team) throw new Error(i18n("err.selfTarget"));
  if (isUnitRemoved(target)) throw new Error(i18n("err.targetRemoved", { id: target.id }));
  const def = mechDefFor(unit);

  // Pickup is exclusive with everything (TW p.146).
  if (context.pickupDecl !== null) throw new Error(i18n("err.pickup.exclusive"));

  // Default limb: right arm for punches, right leg for kicks (TW lets the
  // attacker pick; the CLI default keeps single-command declarations
  // deterministic, and actuator damage is usually symmetric early).
  // Strikes resolve the striking arm and weapon from the mounts: an
  // omitted arm means the sole mount, and anything else is an error.
  let resolvedLimb =
    limb ?? (type === "punch" ? "rightArm" : type === "kick" ? "rightLeg" : undefined);
  let strikeWeapon: PhysicalWeaponName | undefined;
  if (type === "strike") {
    // A non-arm limb can never select a mount; anything else resolves
    // through the mounted pairs (sole mount, named arm, or an error).
    const arm = limb === "leftArm" || limb === "rightArm" ? limb : undefined;
    if (limb !== undefined && arm === undefined) {
      throw new Error(i18n("err.physical.noWeaponInArm", { limb }));
    }
    const mounted = resolveStrikeMount(def, arm);
    if (!mounted.ok) {
      throw new Error(
        mounted.reason === "ambiguous"
          ? i18n("err.physical.pickArm")
          : arm !== undefined
            ? i18n("err.physical.noWeaponInArm", { limb: arm })
            : i18n("err.physical.noWeapon"),
      );
    }
    resolvedLimb = mounted.arm;
    strikeWeapon = mounted.weapon;
  }
  const decl: PhysicalAttackDecl = {
    type,
    targetId,
    ...(resolvedLimb !== undefined ? { limb: resolvedLimb } : {}),
    ...(strikeWeapon !== undefined ? { weapon: strikeWeapon } : {}),
  };

  // One type of physical attack per turn (TW p. 144); two-arm punches are
  // the exception (one punch per arm, resolved as separate rolls).
  const queuedTypes = new Set(context.physicalDecls.map((d) => d.type));
  if (queuedTypes.size > 0 && !queuedTypes.has(type)) {
    throw new Error(i18n("err.physical.oneType"));
  }
  if (type === "punch") {
    const queuedLimbs = context.physicalDecls.filter((d) => d.type === "punch").map((d) => d.limb);
    if (queuedLimbs.includes(resolvedLimb)) {
      throw new Error(i18n("err.physical.duplicate", { type }));
    }
    if (queuedLimbs.length >= 2) {
      throw new Error(i18n("err.physical.duplicate", { type }));
    }
  } else if (context.physicalDecls.length > 0) {
    throw new Error(i18n("err.physical.duplicate", { type }));
  }

  const result = validatePhysicalAttack(battle, unit.id, decl, context.torsoTwist);
  if (!result.ok) {
    throw new Error(i18n("err.physical.invalid", { reason: result.reason ?? "invalid" }));
  }

  // Weapon interaction, mirrored against already-queued weapons: the arm /
  // leg used physically cannot fire, and push / club bars all arm weapons.
  const queuedLocs = new Set(
    context.weaponDecls.flatMap((d) => {
      const loc = def.weapons[d.weaponIndex]?.location;
      return loc !== undefined ? [loc] : [];
    }),
  );
  if (type === "punch" && resolvedLimb !== undefined && queuedLocs.has(resolvedLimb)) {
    throw new Error(i18n("err.physical.armConflict", { limb: resolvedLimb }));
  }
  if (type === "strike" && resolvedLimb !== undefined && queuedLocs.has(resolvedLimb)) {
    throw new Error(i18n("err.physical.strikeConflict", { limb: resolvedLimb }));
  }
  if (type === "kick" && resolvedLimb !== undefined && queuedLocs.has(resolvedLimb)) {
    throw new Error(i18n("err.physical.legConflict", { limb: resolvedLimb }));
  }
  if ((type === "push" || type === "club") && [...queuedLocs].some((loc) => isArm(loc))) {
    throw new Error(i18n("err.physical.noArmWeapons"));
  }

  // Combined backstop: re-validate the full stacked context (weapons +
  // physicals + twist) through the engine so queue order cannot smuggle an
  // illegal combination past the per-command checks above.
  validateAttacks(battle, unit.id, context.weaponDecls, [...context.physicalDecls, decl], {
    twist: context.torsoTwist,
    dropClub: context.dropClub,
  });

  const warnings: string[] = [];
  if (type === "punch" && resolvedLimb !== undefined) {
    warnings.push(i18n("warn.physical.armWeapons", { limb: resolvedLimb }));
  }
  if (type === "strike" && resolvedLimb !== undefined) {
    warnings.push(i18n("warn.physical.strikeArmWeapons", { limb: resolvedLimb }));
  }
  if (type === "kick" && resolvedLimb !== undefined) {
    warnings.push(i18n("warn.physical.legWeapons", { limb: resolvedLimb }));
  }
  if (type === "push" || type === "club") {
    warnings.push(i18n("warn.physical.noArmWeapons"));
  }

  context.physicalDecls.push(decl);
  context.fireCandidate = null;
  return warnings;
}

/** Queue a club pickup declaration (TW p.146). Exclusive with all weapon
 *  and physical declarations — the pickup turn allows no attacks at all. */
export function queuePickup(s: Session, source?: ClubKind, tokenIndex?: number): string[] {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);
  const _def = mechDefFor(unit);

  // Pickup is exclusive with everything (TW p.146).
  if (
    context.weaponDecls.length > 0 ||
    context.physicalDecls.length > 0 ||
    context.pickupDecl !== null
  ) {
    throw new Error(i18n("err.pickup.exclusive"));
  }
  if (context.dropClub) throw new Error(i18n("err.pickup.exclusive"));
  if (unit.club !== null)
    throw new Error(i18n("err.pickup.invalid", { reason: "already holds a club" }));

  // Validate the source against the engine (checks hex environment, etc.)
  const result = validatePickup(battle, unit.id, {
    ...(source !== undefined ? { source } : {}),
    ...(tokenIndex !== undefined ? { tokenIndex } : {}),
  });
  if (!result.ok) throw new Error(i18n("err.pickup.invalid", { reason: result.reason }));

  context.pickupDecl =
    result.token === undefined
      ? { source: result.source }
      : { source: result.source, token: result.token };
  context.fireCandidate = null;
  return [i18n("ok.pickup.queued", { source: result.source })];
}

/** Queue a club drop at the start of this declaration. Hands are freed
 *  for the rest of the declaration (arm weapons, punch, strike, push).
 *  The dropped club stays intact in the hex. */
export function queueDrop(s: Session): string[] {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);

  if (unit.club === null) throw new Error(i18n("err.drop.noClub"));
  if (context.dropClub) throw new Error(i18n("err.drop.duplicate"));
  // A drop with nothing else is a pass turn that just drops the club;
  // if combined with attacks, hands are freed for them.
  context.dropClub = true;
  context.fireCandidate = null;
  return [i18n("ok.drop.queued", { kind: unit.club.kind })];
}

/** Get physical attack suggestions for the current actor. */
export function physicalAttackSuggestions(s: Session): PhysicalAttackSuggestion[] {
  const { battle, context } = requireBattleAndContext(s);
  const unit = requireUnit(battle, context.actorId);
  const suggestions: PhysicalAttackSuggestion[] = [];

  for (const [targetId, target] of Object.entries(battle.units)) {
    if (target.team === unit.team) continue;
    if (isUnitRemoved(target)) continue;
    if (!isAdjacent(unit.position, target.position)) continue;

    // Check each attack type
    for (const type of ["punch", "kick", "push", "club"] as const) {
      const decl: PhysicalAttackDecl = { type, targetId };
      const result = validatePhysicalAttack(battle, unit.id, decl, context.torsoTwist);
      if (result.ok) {
        suggestions.push({ type, targetId, attackDirection: result.attackDirection });
      }
    }
    // Strikes: one entry per mounted physical weapon and mounting arm.
    const def = mechDefFor(unit);
    for (const { arm, weapon } of strikeMounts(def)) {
      const decl: PhysicalAttackDecl = { type: "strike", targetId, limb: arm, weapon };
      const result = validatePhysicalAttack(battle, unit.id, decl, context.torsoTwist);
      if (result.ok) {
        suggestions.push({
          type: "strike",
          targetId,
          attackDirection: result.attackDirection,
          limb: arm,
          weapon,
        });
      }
    }
  }

  return suggestions;
}

export interface PhysicalAttackSuggestion {
  readonly type: "punch" | "kick" | "push" | "club" | "strike";
  readonly targetId: string;
  readonly attackDirection: Arc | undefined;
  readonly limb?: ArmLocation | LegLocation;
  readonly weapon?: PhysicalWeaponName;
}

/** Format physical attack resolution for display. */
export function physicalResolutionLines(r: PhysicalResolution): string[] {
  const lines: string[] = [];
  const verdict = r.autoHit
    ? i18n("res.autoHit")
    : r.autoMiss
      ? i18n("res.autoMiss")
      : r.hit
        ? i18n("res.hit")
        : i18n("res.miss");

  const label =
    r.type === "strike" && r.weapon !== undefined ? `strike (${r.weapon.toLowerCase()})` : r.type;
  lines.push(
    i18n("res.physical.header", {
      type: label,
      attacker: r.attackerId,
      target: r.targetId,
    }),
  );
  lines.push(
    i18n("res.physical.toHit", {
      total: r.toHit,
      roll: r.roll === null ? "—" : r.roll,
      verdict,
    }),
  );

  if (r.hit && r.damageToTarget.length > 0) {
    const dmgStr = r.damageToTarget.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" ");
    lines.push(i18n("res.physical.targetDamage", { groups: dmgStr }));
  }

  if (r.damageToAttacker.length > 0) {
    const dmgStr = r.damageToAttacker.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" ");
    lines.push(i18n("res.physical.attackerDamage", { groups: dmgStr }));
  }

  if (r.targetDisplacedTo) {
    lines.push(
      i18n("res.physical.targetDisplaced", {
        col: r.targetDisplacedTo.col,
        row: r.targetDisplacedTo.row,
      }),
    );
  }
  if (r.attackerDisplacedTo) {
    lines.push(
      i18n("res.physical.attackerDisplaced", {
        col: r.attackerDisplacedTo.col,
        row: r.attackerDisplacedTo.row,
      }),
    );
  }

  if (r.redirectedFrom !== undefined) {
    lines.push(
      i18n("res.physical.redirected", {
        from: r.redirectedFrom,
        target: r.targetId,
      }),
    );
  }
  if (r.missReason === "displaced") {
    lines.push(i18n("res.physical.displacedMiss", { target: r.targetId }));
  } else if (r.missReason === "attackerDown") {
    lines.push(i18n("res.physical.attackerDown", { attacker: r.attackerId }));
  } else if (r.missReason === "targetDown") {
    lines.push(i18n("res.physical.targetDown", { target: r.targetId }));
  } else if (r.missReason?.startsWith("invalid:")) {
    lines.push(
      i18n("res.physical.noLongerLegal", {
        reason: r.missReason.slice("invalid:".length),
      }),
    );
  }

  if (r.targetPsr) {
    lines.push(i18n("res.physical.targetPsr", { outcome: physicalPsrOutcome(r.targetPsr) }));
  }
  if (r.attackerPsr) {
    lines.push(i18n("res.physical.attackerPsr", { outcome: physicalPsrOutcome(r.attackerPsr) }));
  }

  return lines;
}

/** Render one physical-attack PSR outcome, always showing the target number. */
function physicalPsrOutcome(psr: PilotingRollResult): string {
  if (psr.roll === null) {
    return i18n(psr.success ? "res.physical.autoStand" : "res.physical.autoFall", {
      target: psr.target,
    });
  }
  return i18n(psr.success ? "res.physical.stands" : "res.physical.falls", {
    target: psr.target,
    roll: psr.roll,
  });
}

const TWIST: Readonly<Record<string, Arc>> = {
  front: "front",
  left: "leftSide",
  right: "rightSide",
};

export function parseTorsoTwist(direction: string): Arc {
  const arc = TWIST[direction.toLowerCase()];
  if (arc === undefined) {
    throw new Error(i18n("err.twist.badDirection"));
  }
  return arc;
}

/**
 * Set the acting unit's torso twist (TW pp.105-106) for its current attack-phase
 * declaration. Locked once any weapon attack is queued, or once a punch,
 * club, or strike is queued (the twist governs their attacker-side arcs,
 * TW pp. 98–99) — kick and push are feet-based (TW pp. 147–149) and never
 * lock it. The user must `cancel` first — and resets to `"front"` on phase
 * entry or new actor.
 */
export function setTorsoTwist(s: Session, arc: Arc): Arc {
  const { battle, context } = requireBattleAndContext(s);
  const twistLocked =
    context.weaponDecls.length > 0 ||
    context.physicalDecls.some(
      (d) => d.type === "punch" || d.type === "club" || d.type === "strike",
    );
  if (twistLocked) {
    throw new Error(i18n("err.twist.locked"));
  }
  const prev = context.torsoTwist;
  if (prev !== arc) {
    context.torsoTwist = arc;
    ensureFireCandidate(battle, context, true);
  }
  return prev;
}

/**
 * Set the acting unit's ammo-depletion policy. Affects the order its ammo
 * bins are drained by future shots (and which bin explodes on a crit).
 */
export function setAmmoPolicy(s: Session, policy: AmmoPolicy): void {
  const unit = requireAttackActor(s);
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

function ensureFireCandidate(
  battle: BattleState,
  context: AttackContext,
  force: boolean = false,
): FireSuggestion {
  if (context.fireCandidate === null || force) {
    context.fireCandidate = suggestFireTargets(battle, context.actorId, context.torsoTwist);
  }
  return context.fireCandidate;
}

// export function fireSuggestionChunks(sugg: FireSuggestion, twist: Arc | null = null): Chunk[] {
export function fireSuggestionChunks(s: Session): Chunk[] {
  const { battle, context } = requireBattleAndContext(s);
  const sugg = ensureFireCandidate(battle, context);
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
  // Physical attacks (TW pp. 144-147) only matter at adjacency: list them
  // after the weapon tables so most turns show no extra noise.
  const actor = requireUnit(battle, context.actorId);
  const physical: string[] = [];
  for (const [targetId, target] of Object.entries(battle.units)) {
    if (target.team === actor.team || isUnitRemoved(target)) continue;
    if (!isAdjacent(actor.position, target.position)) continue;
    for (const type of ["punch", "kick", "push", "club"] as const) {
      const decl: PhysicalAttackDecl = { type, targetId };
      if (validatePhysicalAttack(battle, actor.id, decl, context.torsoTwist).ok) {
        physical.push(
          i18n("physicalSuggestion.line", {
            type,
            target: targetId,
          }),
        );
      }
    }
    const actorDef = mechDefFor(actor);
    for (const { arm, weapon } of strikeMounts(actorDef)) {
      const decl: PhysicalAttackDecl = { type: "strike", targetId, limb: arm, weapon };
      if (validatePhysicalAttack(battle, actor.id, decl, context.torsoTwist).ok) {
        physical.push(
          i18n("physicalSuggestion.strikeLine", {
            weapon: weapon.toLowerCase(),
            target: targetId,
            limb: arm === "leftArm" ? "left" : "right",
          }),
        );
      }
    }
  }
  chunks.push(buildLinesChunkWith("hint", i18n("physicalSuggestion.header")));
  if (physical.length === 0) {
    chunks.push(buildLinesChunkWith("hint", i18n("physicalSuggestion.none")));
  } else {
    chunks.push(buildLinesChunkWith("hint", ...physical));
  }
  return chunks;
}

export function attackStatusChunk(s: Session): Chunk {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const lines: string[] = [];
  lines.push(...actorOrderLines(s), i18n("attackStatus.header"));
  const decls = context.weaponDecls ?? [];
  const physical = context.physicalDecls ?? [];
  if (decls.length === 0 && physical.length === 0) {
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
    for (const decl of physical) {
      if (decl.type === "strike") {
        lines.push(
          i18n("attackStatus.physicalStrike", {
            weapon: (decl.weapon ?? "strike").toLowerCase(),
            limb: decl.limb ?? "—",
            targetId: decl.targetId,
          }),
        );
      } else {
        lines.push(
          i18n("attackStatus.physical", {
            type: decl.type,
            limb: decl.limb ?? "—",
            targetId: decl.targetId,
          }),
        );
      }
    }
    // Pickup / drop display
    if (context.pickupDecl !== null) {
      lines.push(i18n("attackStatus.pickup", { source: context.pickupDecl.source ?? "auto" }));
    }
    if (context.dropClub) {
      lines.push(i18n("attackStatus.drop"));
    }
  }
  return buildLinesChunk(...lines);
}

/** Labeled GATOR breakdown with partial cover split out (TW p.102). */
function gatorText(r: AttackResolution): string {
  if (r.breakdown.outOfRange) return i18n("res.outOfRange");
  const b = r.breakdown;
  const parts = [`${i18n("res.gator.gunnery")} ${b.gunnery}`];
  if (b.attackerMod) parts.push(`${i18n("res.gator.move")} ${b.attackerMod}`);
  if (b.targetMod) parts.push(`${i18n("res.gator.target")} ${b.targetMod}`);
  if (b.terrainMod) parts.push(`${i18n("res.gator.terrain")} ${b.terrainMod}`);
  if (b.coverMod) parts.push(`${i18n("res.gator.cover")} ${b.coverMod}`);
  if (b.rangeMod) parts.push(`${i18n("res.gator.range")} ${b.rangeMod}`);
  if (b.minRangeMod) parts.push(`${i18n("res.gator.min")} ${b.minRangeMod}`);
  if (b.weaponMod) parts.push(`${i18n("res.gator.weapon")} ${b.weaponMod}`);
  if (b.heatMod) parts.push(`${i18n("res.gator.heat")} ${b.heatMod}`);
  if (b.sensorMod) parts.push(`${i18n("res.gator.sensors")} ${b.sensorMod}`);
  if (b.actuatorMod) parts.push(`${i18n("res.gator.actuators")} ${b.actuatorMod}`);
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
  if (r.ammoExhausted === true) lines.push(`  ${i18n("res.outOfAmmo", { weapon: r.weapon })}`);
  if (r.clusterRoll !== null) lines.push(`  ${i18n("res.clusterRoll", { roll: r.clusterRoll })}`);
  if (r.clusterMod !== null && r.clusterMod !== 0)
    lines.push(
      "  " +
        i18n("res.clusterMod", { mod: r.clusterMod > 0 ? `+${r.clusterMod}` : `${r.clusterMod}` }),
    );
  if (r.hit && r.groups.length > 0) {
    lines.push(
      "  " +
        i18n("res.hits", {
          groups: r.groups.map((g) => formatHitGroup(g)).join(" "),
          arc: i18n(ARC_LABEL[r.arc]),
        }),
    );
    const detail = transferDetail(r);
    if (detail) lines.push(`    ${detail}`);
  }
  for (const crit of r.crits) {
    for (const line of critLines(crit)) lines.push(`    ${line}`);
  }
  return lines;
}

/** One damage group label, tagged when the hit location rolled a through-armor 2. */
function formatHitGroup(g: HitGroup): string {
  // const base = `${SHORT_LOC[g.location]}(${g.damage})`;
  // return g.throughArmor === true ? `${base} [${i18n("res.throughArmorTag")}]` : base;
  return g.throughArmor === true
    ? `>>${SHORT_LOC[g.location]}<<(${g.damage})`
    : `${SHORT_LOC[g.location]}(${g.damage})`;
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
      loc: `${SHORT_LOC[c.source.location]}${c.throughArmor ? ` ${i18n("res.throughArmorTag")}` : ""}`,
      roll: String(c.determiningRoll),
      count: i18n(headerKey),
    }),
  ];
  for (const eff of c.rows) {
    lines.push(`  ${formatCritEffect(eff)}`);
    // Ammo / weapon-explosion blasts carry their own damage application
    // (TW p.125: straight to IS, overflow inward): render its location
    // chain like a weapon hit's, so the blast path is never invisible.
    const blast =
      eff.kind === "ammoExplosion"
        ? eff.application
        : eff.kind === "weaponDestroyed"
          ? eff.explosion?.application
          : undefined;
    if (blast !== undefined) {
      const detail = blastDetail(blast);
      if (detail) lines.push(`    ${detail}`);
    }
  }
  return lines;
}

export function transferDetail(r: AttackResolution): string | null {
  const app = r.application;
  if (!app) return null;
  return blastDetail(app);
}

/** Render one damage application's location chain (`LTI 20->0*, …`).
 *  Shared by weapon hits (`transferDetail`) and crit-blast rows, which
 *  both carry a `DamageApplication` with per-pool `steps`. */
export function blastDetail(app: DamageApplication): string | null {
  if (app.steps.length === 0) return null;
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
  for (const limb of app.blownOffLimbs) {
    const cause = shoulderOf(limb);
    text += i18n("res.limbBlownOff", { cause: SHORT_LOC[cause], limb: SHORT_LOC[limb] });
  }
  const otherDestroyed = app.newlyDestroyed.filter(
    (loc) => !isLimb(loc) || !app.blownOffLimbs.includes(loc),
  );
  if (otherDestroyed.length > 0) {
    text += i18n("res.destroyedTail", {
      locs: otherDestroyed.map((l) => SHORT_LOC[l]).join(", "),
    });
  }
  if (isUnitImmobile(app.after) && !wasImmobile) text += i18n("res.immobilized");
  if (app.killed && !wasDestroyed) text += i18n("res.killed");
  return text;
}

export function formatCritEffect(eff: CriticalEffect): string {
  switch (eff.kind) {
    case "headBlownOff":
      return i18n("res.critHeadBlownOff");
    case "limbBlownOff":
      return isArm(eff.limb)
        ? i18n("res.critArmBlownOff", { arm: SHORT_LOC[eff.limb] })
        : i18n("res.critLegBlownOff", { leg: SHORT_LOC[eff.limb] });
    case "weaponDestroyed":
      if (eff.explosion !== undefined) {
        return i18n("res.critWeaponExplosion", {
          loc: SHORT_LOC[eff.location],
          slot: String(eff.slotIndex),
          weapon: eff.weaponName,
          damage: String(eff.explosion.damage),
        });
      }
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
  ensureFireCandidate(battle, context);
  sink.push({ kind: "sessionAttackActor", actorId: context.actorId });
}
