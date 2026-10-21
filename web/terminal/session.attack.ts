import {
  type Arc,
  type ArmLocation,
  type AttackResolution,
  type BattleState,
  type ClubKind,
  type ClubPickupDecl,
  type CriticalEffect,
  type CriticalResolution,
  computePhysicalToHit,
  type DamageApplication,
  type DamageTransferStep,
  declareAttacks,
  declarePickup,
  type FireSuggestion,
  type FireTarget,
  type FireWeapon,
  type GameEvent,
  type HitGroup,
  hexDistance,
  hitProbability,
  isAdjacent,
  isArm,
  isLimb,
  isTargetableBy,
  isTorso,
  isUnitDestroyed,
  isUnitImmobile,
  isUnitOnBoard,
  type LegLocation,
  type Location,
  type LocationValue,
  mechDefFor,
  msgHex,
  type PhysicalAttackDecl,
  type PhysicalAttackType,
  type PhysicalResolution,
  type PhysicalWeaponName,
  passAttack,
  physicalDamage,
  physicalToHitTotal,
  requireUnit,
  resolveStrikeArm,
  resolveStrikeMount,
  shoulderOf,
  strikeMounts,
  suggestFireTargets,
  type TorsoLocationValue,
  type Twist,
  toHitTotal,
  validateAttacks,
  validatePhysicalAttack,
  validatePickup,
  type AttackDecl as WeaponAttackDecl,
  weaponDefFor,
} from "btlib10x";
import { buildLinesChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import { i18n, type MessageKey } from "./i18n";
import { SHORT_LOC } from "./misc";
import { recordAttack } from "./replay";
import { commitAtomic, drive, requireBattle, type Session, type SessionGameEvent } from "./session";
import { actorOrderLines } from "./session.common";

/** Eagerly allocated by `drive()` on weapon-attack-phase entry, nulled when
 *  the phase exits or a new actor becomes current. Carries `fireDecls`
 *  (weapon volley, single target) plus `physicalDecls` (punch, kick,
 *  club, strike — TW p.144 one-type-per-turn rule, two-arm punch excepted),
 *  `pickup` (exclusive club acquisition, TW p.146), `dropClub` (first act
 *  of a declaration, frees hands for the rest), `torsoTwist` (UI declaration,
 *  resets to `"front"` on allocation), `fireHintShownFor`, `fireCandidate`. */
export interface AttackContext {
  actorId: string;
  weaponDecls: WeaponAttackDecl[];
  physicalDecls: PhysicalAttackDecl[];
  pickup: QueuedPickup | null;
  dropClub: boolean;
  /** Acting unit's torso twist (TW pp.105-106) for the current attack-phase
   *  declaration: starts at `"front"` on context allocation (new actor or
   *  phase entry). Locked once any weapon attack is queued, or once a punch,
   *  club, or strike is queued (twist governs their arcs, TW pp. 98–99) —
   *  kick is feet-based and never locks it (see {@link setTorsoTwist}).
   *  Session-owned because it is a UI declaration, not persistent battle
   *  state. */
  torsoTwist: Twist;
  fireCandidate: FireSuggestion | null;
}

/** A queued club pickup: the arguments `queuePickup` was called with,
 *  replayed through `declarePickup` at commit, and the source they resolved
 *  to when queued (for display). */
export interface QueuedPickup {
  readonly args: ClubPickupDecl;
  readonly source: ClubKind;
}

/** Allocate a fresh attack context for `actorId`. `torsoTwist` starts at
 *  `"front"`; fire declarations and suggestion cache empty. */
export function initAttackContext(s: Session, actorId: string): AttackContext {
  const newContext: AttackContext = {
    actorId,
    weaponDecls: [],
    physicalDecls: [],
    pickup: null,
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
  const target = Object.hasOwn(battle.units, targetId) ? battle.units[targetId] : undefined;
  if (!target) throw new Error(i18n("err.unknownUnitId", { id: targetId }));
  if (!isTargetableBy(unit, target)) throw new Error(i18n("err.selfTarget"));
  if (!isUnitOnBoard(target)) throw new Error(i18n("err.targetRemoved", { id: target.id }));
  // Pickup is exclusive with everything (TW p.146): no weapon or physical
  // attacks allowed on the pickup turn.
  if (context.pickup !== null) throw new Error(i18n("err.pickup.exclusive"));
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
  // arm or kicking leg cannot fire its mounted weapons; a clubbing
  // 'Mech fires no arm-mounted weapons at all.
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
  const noArmWeapons = context.physicalDecls.some((d) => d.type === "club");
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
    dropClub: context.dropClub,
  });
  context.weaponDecls.push(...decls);
  context.fireCandidate = null;
  return warnings;
}

export function cancelAttack(s: Session): void {
  const { context } = requireBattleAndContext(s);
  context.weaponDecls = [];
  context.physicalDecls = [];
  context.pickup = null;
  context.dropClub = false;
  context.fireCandidate = null;
}

export function commitAttack(s: Session): SessionGameEvent[] {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const unitId = actor.id;
  const events: SessionGameEvent[] = [];
  if (
    context.weaponDecls.length === 0 &&
    context.physicalDecls.length === 0 &&
    context.pickup === null &&
    !context.dropClub
  ) {
    commitAtomic(s, () => {
      recordAttack(s, context, unitId);
      passAttack(battle, unitId);
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
      recordAttack(s, context, unitId);
      const collected: GameEvent[] = [];
      if (context.pickup !== null) {
        declarePickup(battle, unitId, context.pickup.args, collected);
      } else {
        declareAttacks(
          battle,
          unitId,
          context.weaponDecls,
          context.physicalDecls,
          collected,
          s.rng,
          { twist: context.torsoTwist, dropClub: context.dropClub },
        );
      }
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
// Physical attacks (punch, kick, club, strike)
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
  const target = Object.hasOwn(battle.units, targetId) ? battle.units[targetId] : undefined;
  if (!target) throw new Error(i18n("err.unknownUnitId", { id: targetId }));
  if (!isTargetableBy(unit, target)) throw new Error(i18n("err.selfTarget"));
  if (!isUnitOnBoard(target)) throw new Error(i18n("err.targetRemoved", { id: target.id }));
  const def = mechDefFor(unit);

  // Pickup is exclusive with everything (TW p.146).
  if (context.pickup !== null) throw new Error(i18n("err.pickup.exclusive"));

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

  const result = validatePhysicalAttack(
    battle,
    unit.id,
    decl,
    context.torsoTwist,
    context.dropClub,
  );
  if (!result.ok) {
    throw new Error(i18n("err.physical.invalid", { reason: result.reason ?? "invalid" }));
  }

  // Weapon interaction, mirrored against already-queued weapons: the arm /
  // leg used physically cannot fire, and club bars all arm weapons.
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
  if (type === "club" && [...queuedLocs].some((loc) => isArm(loc))) {
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
  if (type === "club") {
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
    context.pickup !== null
  ) {
    throw new Error(i18n("err.pickup.exclusive"));
  }
  if (context.dropClub) throw new Error(i18n("err.pickup.exclusive"));
  if (unit.club !== null)
    throw new Error(i18n("err.pickup.invalid", { reason: "already holds a club" }));

  // Validate the source against the engine (checks hex environment, etc.)
  const args: ClubPickupDecl = {
    ...(source !== undefined ? { source } : {}),
    ...(tokenIndex !== undefined ? { tokenIndex } : {}),
  };
  const result = validatePickup(battle, unit.id, args);
  if (!result.ok) throw new Error(i18n("err.pickup.invalid", { reason: result.reason }));

  context.pickup = { args, source: result.source };
  context.fireCandidate = null;
  return [i18n("ok.pickup.queued", { source: result.source })];
}

/** Queue a club drop at the start of this declaration. Hands are freed
 *  for the rest of the declaration (arm weapons, punch, strike).
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
    if (target.id === unit.id || !isUnitOnBoard(target) || !isTargetableBy(unit, target)) continue;
    if (!isAdjacent(unit.position, target.position)) continue;

    // Check each attack type
    for (const type of ["punch", "kick", "club"] as const) {
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
  readonly type: "punch" | "kick" | "club" | "strike";
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
  const reasonFollows =
    r.missReason === "attackerDown" ||
    r.missReason === "targetDown" ||
    r.missReason === "dfaAborted" ||
    r.missReason === "advanced" ||
    r.missReason?.startsWith("voided:") === true;
  if (r.roll !== null) {
    lines.push(i18n("res.physical.toHit", { total: r.toHit, roll: r.roll, verdict }));
  } else if (!reasonFollows) {
    // No roll was made: the verdict alone, not a fake target number.
    lines.push(`  ${verdict}`);
  }

  if (r.hit && r.damageToTarget.length > 0) {
    const dmgStr = r.damageToTarget.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" ");
    lines.push(i18n("res.physical.targetDamage", { groups: dmgStr }));
    const detail = applicationsDetail(r.applications);
    if (detail) lines.push(`  ${detail}`);
  }

  if (r.damageToAttacker.length > 0) {
    const dmgStr = r.damageToAttacker.map((g) => `${SHORT_LOC[g.location]}(${g.damage})`).join(" ");
    lines.push(i18n("res.physical.attackerDamage", { groups: dmgStr }));
    const detail = applicationsDetail(r.attackerApplications);
    if (detail) lines.push(`  ${detail}`);
  }

  for (const crit of r.crits) {
    for (const line of critLines(crit)) lines.push(`  ${line}`);
  }
  if (r.dfaMissFall === true) {
    lines.push(i18n("res.physical.dfaMissFall", { attacker: r.attackerId }));
  }

  if (r.missReason === "attackerDown") {
    lines.push(i18n("res.physical.attackerDown", { attacker: r.attackerId }));
  } else if (r.missReason === "targetDown") {
    lines.push(i18n("res.physical.targetDown", { target: r.targetId }));
  } else if (r.missReason === "advanced" && r.advancedTo !== undefined) {
    lines.push(
      i18n("res.physical.advanced", {
        attacker: r.attackerId,
        target: r.targetId,
        pos: msgHex(r.advancedTo),
      }),
    );
  } else if (r.missReason?.startsWith("voided:")) {
    const why = r.missReason.slice("voided:".length);
    lines.push(
      i18n("res.physical.voided", {
        attacker: r.attackerId,
        reason: i18n(
          why === "hexTaken" ? "res.physical.voided.hexTaken" : "res.physical.voided.attackerDown",
        ),
      }),
    );
  } else if (r.missReason === "dfaAborted") {
    lines.push(i18n("res.physical.dfaAborted", { attacker: r.attackerId }));
  } else if (r.missReason?.startsWith("invalid:")) {
    lines.push(
      i18n("res.physical.noLongerLegal", {
        reason: r.missReason.slice("invalid:".length),
      }),
    );
  }

  return lines;
}

const TWIST: Readonly<Record<string, Twist>> = {
  front: "front",
  left: "leftSide",
  right: "rightSide",
};

export function parseTorsoTwist(direction: string): Twist {
  const twist = TWIST[direction.toLowerCase()];
  if (twist === undefined) {
    throw new Error(i18n("err.twist.badDirection"));
  }
  return twist;
}

/**
 * Set the acting unit's torso twist (TW pp.105-106) for its current attack-phase
 * declaration. Locked once any weapon attack is queued, or once a punch,
 * club, or strike is queued (the twist governs their attacker-side arcs,
 * TW pp. 98–99) — kick is feet-based (TW pp. 147–149) and never
 * locks it. The user must `cancel` first — and resets to `"front"` on phase
 * entry or new actor.
 */
export function setTorsoTwist(s: Session, twist: Twist): Twist {
  const { battle, context } = requireBattleAndContext(s);
  if (isTwistLocked(context)) {
    throw new Error(i18n("err.twist.locked"));
  }
  const prev = context.torsoTwist;
  if (prev !== twist) {
    context.torsoTwist = twist;
    ensureFireCandidate(battle, context, true);
  }
  return prev;
}

const ARC_LABEL: Readonly<Record<Arc, MessageKey>> = {
  front: "fireSuggestion.arc.front",
  rear: "fireSuggestion.arc.rear",
  leftSide: "fireSuggestion.arc.leftSide",
  rightSide: "fireSuggestion.arc.rightSide",
};

/** Player-facing torso twist word (front/left/right) for an arc. */
export function twistLabel(twist: Arc): string {
  return i18n(TWIST_LABEL[twist]);
}

const TWIST_LABEL: Readonly<Record<Arc, MessageKey>> = {
  front: "fireSuggestion.twist.front",
  leftSide: "fireSuggestion.twist.left",
  rightSide: "fireSuggestion.twist.right",
  rear: "fireSuggestion.twist.front",
};

/** `torso <word>` command argument for each twist. */
const TWIST_COMMAND: Readonly<Record<Arc, string>> = {
  front: "torso front",
  leftSide: "torso left",
  rightSide: "torso right",
  rear: "torso front",
};

const TWIST_OPTIONS: readonly Twist[] = ["front", "leftSide", "rightSide"];

/** A twist is locked once a weapon, punch, club or strike is queued (kick
 *  is feet-based and never locks it). */
function isTwistLocked(context: AttackContext): boolean {
  return (
    context.weaponDecls.length > 0 ||
    context.physicalDecls.some(
      (d) => d.type === "punch" || d.type === "club" || d.type === "strike",
    )
  );
}

function ensureFireCandidate(
  battle: BattleState,
  context: AttackContext,
  force: boolean = false,
): FireSuggestion {
  if (context.fireCandidate === null || force) {
    context.fireCandidate = suggestFireTargets(
      battle,
      context.actorId,
      context.torsoTwist,
      context.dropClub,
    );
  }
  return context.fireCandidate;
}

/** `, by "a" and "b"`: the trailing command list on a candidate line. */
function byCommands(commands: readonly string[]): string {
  const quoted = commands.map((c) => `"${c}"`);
  const list =
    quoted.length <= 1
      ? (quoted[0] ?? "")
      : `${quoted.slice(0, -1).join(", ")}${i18n("fireSuggestion.and")}${quoted[quoted.length - 1]}`;
  return i18n("fireSuggestion.by", { cmds: list });
}

/** `TN n (p%)`, with the 2D6 chance of rolling n or higher. */
function tnText(tn: number, minPenalty?: number): string {
  const pct = String(Math.round(hitProbability(tn) * 100));
  return minPenalty !== undefined
    ? i18n("fireSuggestion.tnMin", { tn, pct, min: minPenalty })
    : i18n("fireSuggestion.tnPct", { tn, pct });
}

/** A listing line: plain text, or columns aligned with the rest of its group. */
type ListingLine = string | { indent: string; cols: string[]; tail: string };

/** Pad the column rows of a group to common widths (three-space gutters). */
function renderListing(lines: readonly ListingLine[]): string[] {
  const rows = lines.filter((l): l is Exclude<ListingLine, string> => typeof l !== "string");
  const widths: number[] = [];
  for (const { cols } of rows) {
    cols.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return lines.map((l) =>
    typeof l === "string"
      ? l
      : `${l.indent}${l.cols
          .map((cell, i) => (i < l.cols.length - 1 ? cell.padEnd(widths[i]!) : cell))
          .join(" ")}${l.tail}`,
  );
}

/** One line per fireable weapon. */
function weaponLines(
  targetId: string,
  weapons: readonly FireWeapon[],
  indent: string,
): ListingLine[] {
  const lines: ListingLine[] = weapons.map((w) => ({
    indent,
    cols: [
      `#${w.weaponIndex} ${w.weapon}`,
      tnText(w.tn, w.minRangePenalty),
      i18n("fireSuggestion.dmg", {
        dmg:
          w.cluster !== undefined
            ? `${w.cluster.perMissile}×${w.cluster.shots}`
            : String(w.expectedDamage),
      }),
      i18n("fireSuggestion.heat", { heat: w.heat }),
    ],
    tail: byCommands([`fire ${targetId} ${w.weaponIndex}`]),
  }));
  return lines;
}

/** True when the two prop-side weapon sets differ (prone attacker). */
function propSplit(target: FireTarget): boolean {
  return (
    target.weaponsIfPropLeft.length !== target.weaponsIfPropRight.length ||
    target.weaponsIfPropLeft.some(
      (w, i) => w.weaponIndex !== target.weaponsIfPropRight[i]?.weaponIndex,
    )
  );
}

/** Engine check of everything already queued plus `weapons`/`physical` at
 *  `twist` (TW pp. 144-147: one target, one physical type, arm and leg
 *  conflicts between fire and physical attacks, club hands). */
function legalWithQueued(
  battle: BattleState,
  context: AttackContext,
  twist: Twist,
  weapons: readonly WeaponAttackDecl[],
  physical: readonly PhysicalAttackDecl[],
): boolean {
  try {
    validateAttacks(
      battle,
      context.actorId,
      [...context.weaponDecls, ...weapons],
      [...context.physicalDecls, ...physical],
      { twist, dropClub: context.dropClub },
    );
    return true;
  } catch {
    return false;
  }
}

/** Weapon part: one group per reachable twist, one block per target. The
 *  twist command sits on the group heading; weapon lines carry the fire
 *  command alone. */
function weaponCandidateLines(battle: BattleState, context: AttackContext): string[] {
  const actor = requireUnit(battle, context.actorId);
  const locked = isTwistLocked(context);
  // A prone 'Mech cannot twist (TW p.106); a locked twist cannot change.
  const twists = actor.prone || locked ? [context.torsoTwist] : TWIST_OPTIONS;
  // Weapon fire is one target per unit: once a fire is queued only its
  // target remains, without the weapons already queued.
  const pendingTarget = context.weaponDecls[0]?.targetId;
  const queued = new Set(context.weaponDecls.map((d) => d.weaponIndex));
  const out = [`[${i18n("fireSuggestion.weaponHeader")}]`];
  // A held club occupies both hands: arm weapons fire only after a drop.
  if (actor.club !== null && !context.dropClub) out.push(`  ${i18n("fireSuggestion.clubHeld")}`);
  for (const twist of twists) {
    const current = twist === context.torsoTwist;
    const changeable = !actor.prone && !locked;
    const group: ListingLine[] = [];
    const sugg = suggestFireTargets(battle, context.actorId, twist, context.dropClub);
    // Each weapon must also fit with what is already queued (a punching or
    // striking arm cannot fire, a held club bars arm weapons).
    const usable = (targetId: string, list: readonly FireWeapon[]): FireWeapon[] =>
      list.filter(
        (w) =>
          !queued.has(w.weaponIndex) &&
          legalWithQueued(battle, context, twist, [{ targetId, weaponIndex: w.weaponIndex }], []),
      );
    for (const target of sugg.targets) {
      if (pendingTarget !== undefined && target.targetId !== pendingTarget) continue;
      const head = `    ${i18n("fireSuggestion.target", {
        id: target.targetId,
        distance: String(target.distance),
        arc: target.arc !== null ? i18n(ARC_LABEL[target.arc]) : "—",
      })}`;
      if (propSplit(target)) {
        const left = usable(target.targetId, target.weaponsIfPropLeft);
        const right = usable(target.targetId, target.weaponsIfPropRight);
        if (left.length === 0 && right.length === 0) continue;
        group.push(head);
        if (left.length > 0) {
          group.push(`      ${i18n("fireSuggestion.propLeft")}`);
          group.push(...weaponLines(target.targetId, left, "        "));
        }
        if (right.length > 0) {
          group.push(`      ${i18n("fireSuggestion.propRight")}`);
          group.push(...weaponLines(target.targetId, right, "        "));
        }
        continue;
      }
      const weapons = usable(target.targetId, target.weapons);
      if (weapons.length === 0) continue;
      group.push(head, ...weaponLines(target.targetId, weapons, "      "));
    }
    const groupHeader = `  ${i18n("fireSuggestion.twistGroup", { dir: twistLabel(twist) })}${
      changeable ? byCommands([TWIST_COMMAND[twist]]) : ""
    }${current ? i18n("fireSuggestion.current") : ""}`;
    if (group.length === 0) {
      group.push(`${groupHeader}: ${i18n("fireSuggestion.groupNone")}`);
    } else {
      out.push(groupHeader, ...renderListing(group));
    }
  }
  return out;
}

type Limb = "leftArm" | "rightArm" | "leftLeg" | "rightLeg";

const LIMB_WORD: Readonly<Record<Limb, string>> = {
  leftArm: "left",
  rightArm: "right",
  leftLeg: "left",
  rightLeg: "right",
};

const PHYSICAL_LABEL: Readonly<Record<Limb, { punch: MessageKey; kick: MessageKey }>> = {
  leftArm: { punch: "physicalSuggestion.punch.left", kick: "physicalSuggestion.kick.left" },
  rightArm: { punch: "physicalSuggestion.punch.right", kick: "physicalSuggestion.kick.right" },
  leftLeg: { punch: "physicalSuggestion.punch.left", kick: "physicalSuggestion.kick.left" },
  rightLeg: { punch: "physicalSuggestion.punch.right", kick: "physicalSuggestion.kick.right" },
};

/** Physical part: one block per adjacent enemy, or nothing when none is adjacent. */
function physicalCandidateLines(battle: BattleState, context: AttackContext): string[] {
  const actor = requireUnit(battle, context.actorId);
  const locked = isTwistLocked(context);
  // Current twist first, so a legal attack needs no twist command when it can.
  const twists =
    actor.prone || locked
      ? [context.torsoTwist]
      : [context.torsoTwist, ...TWIST_OPTIONS.filter((t) => t !== context.torsoTwist)];
  /** First twist under which `decls` are all legal, or null. */
  const twistFor = (decls: readonly PhysicalAttackDecl[]): Arc | null => {
    for (const twist of twists) {
      if (legalWithQueued(battle, context, twist, [], decls)) return twist;
    }
    return null;
  };
  const prefixFor = (twist: Arc): string[] =>
    twist === context.torsoTwist ? [] : [TWIST_COMMAND[twist]];
  const lines: string[] = [];
  let usesArm = false;
  for (const target of Object.values(battle.units)) {
    if (target.id === actor.id || !isUnitOnBoard(target) || !isTargetableBy(actor, target))
      continue;
    if (!isAdjacent(actor.position, target.position)) continue;
    const id = target.id;
    const rows: { cols: string[]; commands: string[] }[] = [];
    const add = (
      label: string,
      decl: PhysicalAttackDecl,
      command: string,
      limb: Limb | undefined,
    ): Arc | null => {
      // The current twist is tried first, and a kick ignores the twist.
      const twist = twistFor([decl]);
      if (twist === null) return null;
      const tn = physicalToHitTotal(
        computePhysicalToHit(battle, actor, target, decl.type, limb, decl.weapon),
      );
      rows.push({
        cols: [
          label,
          tnText(tn),
          i18n("fireSuggestion.dmg", {
            dmg: String(physicalDamage(decl.type, actor, limb, decl.weapon)),
          }),
        ],
        commands: [...prefixFor(twist), command],
      });
      if (decl.type !== "kick") usesArm = true;
      return twist;
    };
    const punches: { limb: Limb; decl: PhysicalAttackDecl; tn: number; dmg: number }[] = [];
    for (const limb of ["leftArm", "rightArm"] as const) {
      const decl: PhysicalAttackDecl = { type: "punch", targetId: id, limb };
      if (add(i18n(PHYSICAL_LABEL[limb].punch), decl, `punch ${id} ${LIMB_WORD[limb]}`, limb)) {
        punches.push({
          limb,
          decl,
          tn: physicalToHitTotal(computePhysicalToHit(battle, actor, target, "punch", limb)),
          dmg: physicalDamage("punch", actor, limb),
        });
      }
    }
    if (punches.length === 2) {
      // Both arms may punch the same target, each rolled separately (TW p.145).
      const twist = twistFor(punches.map((p) => p.decl));
      if (twist !== null) {
        const [l, r] = punches as [(typeof punches)[0], (typeof punches)[0]];
        rows.push({
          cols: [
            i18n("physicalSuggestion.both"),
            l.tn === r.tn
              ? `${tnText(l.tn)}${i18n("physicalSuggestion.each")}`
              : `${tnText(l.tn)} / ${tnText(r.tn)}`,
            i18n("fireSuggestion.dmg", {
              dmg:
                l.dmg === r.dmg
                  ? `${l.dmg}${i18n("physicalSuggestion.each")}`
                  : `${l.dmg} + ${r.dmg}`,
            }),
          ],
          commands: [...prefixFor(twist), `punch ${id} left`, `punch ${id} right`],
        });
      }
    }
    for (const limb of ["leftLeg", "rightLeg"] as const) {
      add(
        i18n(PHYSICAL_LABEL[limb].kick),
        { type: "kick", targetId: id, limb },
        `kick ${id} ${LIMB_WORD[limb]}`,
        limb,
      );
    }
    add(i18n("physicalSuggestion.club"), { type: "club", targetId: id }, `club ${id}`, undefined);
    for (const { arm, weapon } of strikeMounts(mechDefFor(actor))) {
      add(
        i18n("physicalSuggestion.strike", { weapon: weapon.toLowerCase(), limb: LIMB_WORD[arm] }),
        { type: "strike", targetId: id, limb: arm, weapon },
        `strike ${id} ${LIMB_WORD[arm]}`,
        arm,
      );
    }
    lines.push(
      `  ${i18n("physicalSuggestion.target", {
        id,
        distance: String(hexDistance(actor.position, target.position)),
      })}`,
    );
    if (rows.length === 0) {
      lines.push(`    ${i18n("physicalSuggestion.adjacentNone")}`);
      continue;
    }
    lines.push(
      ...renderListing(
        rows.map((r) => ({ indent: "    ", cols: r.cols, tail: byCommands(r.commands) })),
      ),
    );
  }
  if (lines.length === 0) return [];
  if (usesArm) lines.push(`  ${i18n("physicalSuggestion.armNote")}`);
  return [i18n("physicalSuggestion.header"), ...lines];
}

/**
 * The attack-phase candidate listing, command first: a weapon part with
 * one group per torso twist and one block per target (fireable weapons
 * only, each with TN, 2D6 hit chance, damage, heat and its command), then a
 * physical part per adjacent enemy (left out when none is adjacent).
 */
export function fireSuggestionChunks(s: Session): Chunk[] {
  const { battle, context } = requireBattleAndContext(s);
  const lines: string[] = [i18n("fireSuggestion.header", { id: context.actorId })];
  // A pickup is the unit's whole attack (TW p. 146).
  if (context.pickup !== null) {
    lines.push(i18n("fireSuggestion.pickupQueued"));
  } else {
    // Anything queued narrows the candidates; `cancel` clears the whole queue.
    const narrowed =
      context.weaponDecls.length > 0 || context.physicalDecls.length > 0 || context.dropClub;
    if (narrowed) lines.push(`  (${i18n("fireSuggestion.queuedNote")}`);
    lines.push(
      ...weaponCandidateLines(battle, context).map((l) => `  ${l}`),
      ...physicalCandidateLines(battle, context).map((l) => `  ${l}`),
    );
  }
  return [buildLinesChunkWith("hint", ...lines)];
}

export function attackStatusChunk(s: Session): Chunk {
  const { battle, context } = requireBattleAndContext(s);
  const actor = requireUnit(battle, context.actorId);
  const lines: string[] = [];
  lines.push(...actorOrderLines(s), i18n("attackStatus.header"));
  const decls = context.weaponDecls ?? [];
  const physical = context.physicalDecls ?? [];
  if (decls.length === 0 && physical.length === 0 && context.pickup === null && !context.dropClub) {
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
    if (context.pickup !== null) {
      lines.push(i18n("attackStatus.pickup", { source: context.pickup.source }));
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
  if (b.tcMod) parts.push(`${i18n("res.gator.targetingComputer")} ${b.tcMod}`);
  const total = b.automatic === "hit" ? i18n("res.needAuto") : String(toHitTotal(b));
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
  const heat = r.inflictedHeat;
  if (heat !== undefined) {
    lines.push(
      "  " +
        (heat.source === "asHeat"
          ? i18n("res.heatAsHeat", { heat: heat.heat })
          : i18n("res.heatExtra", { heat: heat.heat, dice: (heat.dice ?? []).join("+") })),
    );
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
  return applicationsDetail(r.applications);
}

/** One line for a run of group applications, each rendered by `blastDetail`. */
function applicationsDetail(apps: readonly DamageApplication[]): string | null {
  const parts = apps.map(blastDetail).filter((d): d is string => d !== null);
  return parts.length > 0 ? parts.join(", ") : null;
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
  if (app.mechDestroyed && !wasDestroyed) text += i18n("res.mechDestroyed");
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
        name: eff.label ?? eff.name,
      });
    case "engineDestroyed":
      return i18n("res.critEngineDestroyed", {
        loc: SHORT_LOC[eff.location],
        slot: String(eff.slotIndex),
      });
    case "noEffect":
      return i18n("res.critNoEffect", { loc: "" });
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
