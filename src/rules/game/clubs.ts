import { roll2D6 } from "../../core/dice";
import { cellAt } from "../../core/terrain";
import { hexKey, isWoodsTerrain, type LimbLocation, type Rng } from "../../core/types";
import { mechDefFor } from "../../data/index";
import { clubHandsFunctional } from "../actuators";
import { type CriticalResolution, critSeveredLimbs, isSlotDestroyed } from "../critical";
import { isPilotUnconscious } from "../pilot";
import { GIRDER_SEARCH_TARGET } from "./constants";
import { isShutdown, isUnitRemoved, requireUnit } from "./queries";
import { requireCurrentActor } from "./turnOrder";
import type {
  BattleState,
  ClubGroundToken,
  ClubKind,
  ClubPickupDecl,
  DeclaredPickup,
  GameEvent,
  PickupChoice,
  UnitState,
} from "./types";

/**
 * Record severed limbs on `unit` (`blownOffLimbs`) and leave one ground token
 * per limb in the unit's current hex (TW p.146: a blown-off arm or leg stays
 * where it was lost). Each severing has exactly one report: a damage
 * application's `blownOffLimbs` (an arm lost with its side torso) or a crit
 * row (`critSeveredLimbs`), and both only sever a limb that still stands, so
 * a repeat is a bug.
 */
export function recordSeveredLimbs(
  state: BattleState,
  unit: UnitState,
  limbs: readonly LimbLocation[],
): void {
  for (const limb of limbs) {
    if (unit.blownOffLimbs.some((l) => l.limb === limb)) {
      throw new Error(`${unit.id}: ${limb} severed twice`);
    }
    unit.blownOffLimbs.push({ limb, salvageable: true });
    const key = hexKey(unit.position);
    state.clubs[key] = [
      ...(state.clubs[key] ?? []),
      { kind: "limb", limb, model: unit.model, ownerId: unit.id },
    ];
  }
}

/**
 * Record every limb the crit resolutions severed (`critSeveredLimbs`).
 * Leaves the matching ground tokens in the victim's hex.
 */
export function recordCritSeveredLimbs(
  state: BattleState,
  unit: UnitState,
  crits: readonly CriticalResolution[],
): void {
  for (const crit of crits) {
    recordSeveredLimbs(state, unit, critSeveredLimbs(crit));
  }
}

/** Club tokens lying in `unit`'s hex (all kinds), in deposit order. */
export function clubTokensInHex(state: BattleState, unit: UnitState): readonly ClubGroundToken[] {
  return state.clubs[hexKey(unit.position)] ?? [];
}

export function describeToken(token: ClubGroundToken): string {
  return token.kind === "limb"
    ? `limb ${token.limb} of ${token.ownerId ?? token.model}`
    : token.kind;
}

export function sameToken(a: ClubGroundToken, b: ClubGroundToken): boolean {
  if (a.kind !== b.kind) return false;
  return (
    a.kind !== "limb" ||
    (b.kind === "limb" && a.limb === b.limb && a.model === b.model && a.ownerId === b.ownerId)
  );
}

/**
 * Resolve which club `unit` would pick up in its current hex (TW p.146).
 * Tokens (severed limbs, dropped trees/girders) come first; with exactly one
 * matching token it is taken, with several the caller must pick one by
 * `tokenIndex` (index into the hex's token list) or the pick is an error.
 * With no matching token the terrain fallback applies: a tree in a wooded
 * hex, else a girder in eligible rubble (or the explicitly requested one).
 */
export function choosePickup(
  state: BattleState,
  unit: UnitState,
  decl: ClubPickupDecl,
): PickupChoice {
  const tokens = clubTokensInHex(state, unit);
  const matching = tokens
    .map((token, index) => ({ token, index }))
    .filter((t) => decl.source === undefined || t.token.kind === decl.source);
  if (decl.tokenIndex !== undefined) {
    const picked = tokens[decl.tokenIndex - 1];
    if (picked === undefined || (decl.source !== undefined && picked.kind !== decl.source)) {
      return { ok: false, reason: `no club token ${decl.tokenIndex} in this hex` };
    }
    return { ok: true, source: picked.kind, token: picked };
  }
  if (matching.length > 1) {
    const list = matching.map((t) => `${t.index + 1}: ${describeToken(t.token)}`).join(", ");
    return { ok: false, reason: `several clubs lie in this hex (${list}); choose one by number` };
  }
  const only = matching[0];
  if (only !== undefined) return { ok: true, source: only.token.kind, token: only.token };

  const cell = cellAt(state, unit.position);
  const hasTree = isWoodsTerrain(cell.terrain);
  const origin = state.rubbleOrigin[hexKey(unit.position)];
  const hasGirder =
    cell.terrain === "rubble" && origin !== undefined && GIRDER_SEARCH_TARGET[origin] !== undefined;
  if (decl.source === "limb") return { ok: false, reason: "no limb club available in this hex" };
  if ((decl.source === undefined || decl.source === "tree") && hasTree) {
    return { ok: true, source: "tree" };
  }
  if ((decl.source === undefined || decl.source === "girder") && hasGirder) {
    return { ok: true, source: "girder" };
  }
  return decl.source !== undefined
    ? { ok: false, reason: `no ${decl.source} club available in this hex` }
    : { ok: false, reason: "no club available in this hex (no limb, woods, or girder rubble)" };
}

/**
 * Resolve which club source `unit` would pick up in its current hex (TW
 * p.146); see `choosePickup`. Returns null when the hex offers nothing or
 * the choice is ambiguous.
 */
export function pickupSourceInHex(state: BattleState, unit: UnitState): ClubKind | null {
  const choice = choosePickup(state, unit, {});
  return choice.ok ? choice.source : null;
}

/**
 * Validate a club pickup declaration (TW p.146). Checks unit status (no
 * prior declaration of any kind this turn — pickup is exclusive with every
 * weapon and physical attack), empty hands, and that the unit's hex offers
 * the requested source (or any source when omitted, by precedence).
 * Pure: no state change, no RNG. Returns the resolved source.
 */
export function validatePickup(
  state: BattleState,
  unitId: string,
  decl: ClubPickupDecl = {},
): ({ ok: true } & DeclaredPickup) | { ok: false; reason: string } {
  const unit = requireUnit(state, unitId);
  if (isUnitRemoved(unit)) return { ok: false, reason: `${unitId} is removed from play` };
  if (isShutdown(unit)) return { ok: false, reason: `${unitId} is shut down and cannot pick up` };
  if (isPilotUnconscious(unit))
    return { ok: false, reason: `${unitId} is unconscious and cannot pick up` };
  if (
    unit.declaredWeaponAttacks.length > 0 ||
    unit.declaredPhysicalAttacks.length > 0 ||
    unit.declaredPickup !== null
  ) {
    return { ok: false, reason: `${unitId} already declared attacks this turn` };
  }
  if (unit.club !== null) {
    return { ok: false, reason: `${unitId} already holds a club (drop it first)` };
  }
  if (!clubHandsFunctional(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed)) {
    return { ok: false, reason: `${unitId} needs two working hands to pick up a club` };
  }
  const choice = choosePickup(state, unit, decl);
  if (!choice.ok) return choice;
  return choice.token === undefined
    ? { ok: true, source: choice.source }
    : { ok: true, source: choice.source, token: choice.token };
}

/**
 * Declare a club pickup for the current attack-phase actor (TW p.146).
 * Exclusive with every weapon and physical declaration: the pickup turn
 * allows no attacks at all. The environment is checked now; acquisition
 * itself resolves in the physical sub-pass of `resolveAllAttacks`.
 * Emits `pickupDeclared` and marks the actor done for the phase.
 */
export function declarePickup(
  state: BattleState,
  unitId: string,
  decl: ClubPickupDecl,
  sink: GameEvent[],
): void {
  requireCurrentActor(state, unitId, "attack");
  const result = validatePickup(state, unitId, decl);
  if (!result.ok) throw new Error(result.reason);
  const unit = requireUnit(state, unitId);
  unit.declaredPickup =
    result.token === undefined
      ? { source: result.source }
      : { source: result.source, token: result.token };
  sink.push({ kind: "pickupDeclared", unitId, source: result.source });
  if (!state.actedThisPhase.includes(unitId)) state.actedThisPhase.push(unitId);
}

/**
 * Resolve one declared pickup in the physical sub-pass (TW p.146). The
 * declaration-time environment is re-checked against the unit's current
 * hex: falls or kills since declaration can void it. Limb
 * and tree acquisition are automatic; girders need 2D6 against 7+/6+/5+
 * by rubble origin. Emits `clubPickedUp` in all cases.
 */
export function resolveClubPickup(
  state: BattleState,
  unit: UnitState,
  decl: DeclaredPickup,
  rng: Rng,
  sink: GameEvent[],
): void {
  const fail = (reason: string): void => {
    sink.push({ kind: "clubPickedUp", unitId: unit.id, success: false, reason });
  };
  if (isUnitRemoved(unit) || isPilotUnconscious(unit) || isShutdown(unit)) {
    fail("attackerDown");
    return;
  }
  if (!clubHandsFunctional(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed)) {
    fail("noHands");
    return;
  }
  const tokens = clubTokensInHex(state, unit);
  // A declared token must still lie here (another unit may have taken it);
  // otherwise re-resolve from the hex as declared.
  let token: ClubGroundToken | undefined;
  const declared = decl.token;
  if (declared !== undefined) {
    token = tokens.find((t) => sameToken(t, declared));
    if (token === undefined) {
      fail("noSource");
      return;
    }
  }
  const choice =
    token !== undefined
      ? { ok: true as const, source: token.kind, token }
      : choosePickup(state, unit, { source: decl.source });
  if (!choice.ok) {
    fail("noSource");
    return;
  }
  const key = hexKey(unit.position);
  if (choice.token !== undefined) {
    const picked = choice.token;
    const at = tokens.findIndex((t) => sameToken(t, picked));
    state.clubs[key] = tokens.filter((_, i) => i !== at);
    if (picked.kind === "limb") {
      unit.club = { kind: "limb", limb: picked.limb, model: picked.model, ownerId: picked.ownerId };
      voidLimbSalvage(state, picked);
    } else {
      unit.club = { kind: picked.kind };
    }
    sink.push({ kind: "clubPickedUp", unitId: unit.id, success: true, clubKind: picked.kind });
    return;
  }
  if (choice.source === "tree") {
    unit.club = { kind: "tree" };
    sink.push({ kind: "clubPickedUp", unitId: unit.id, success: true, clubKind: "tree" });
    return;
  }
  const origin = state.rubbleOrigin[key];
  const required = (origin !== undefined ? GIRDER_SEARCH_TARGET[origin] : undefined) ?? null;
  if (required === null) {
    fail("noSource");
    return;
  }
  const roll = roll2D6(rng);
  if (roll >= required) {
    unit.club = { kind: "girder" };
    sink.push({
      kind: "clubPickedUp",
      unitId: unit.id,
      success: true,
      clubKind: "girder",
      roll,
      required,
    });
  } else {
    sink.push({
      kind: "clubPickedUp",
      unitId: unit.id,
      success: false,
      clubKind: "girder",
      roll,
      required,
      reason: "searchFailed",
    });
  }
}

/** Mark a picked-up severed limb as no longer salvageable (house rule). */
export function voidLimbSalvage(
  state: BattleState,
  token: ClubGroundToken & { kind: "limb" },
): void {
  if (token.ownerId === null) return;
  const owner = state.units[token.ownerId];
  if (owner === undefined) return;
  for (const entry of owner.blownOffLimbs) if (entry.limb === token.limb) entry.salvageable = false;
}

/**
 * Severed limbs of `unitId` still worth salvaging: never picked up (the
 * `salvageable` flag in `blownOffLimbs`) and holding at
 * least one weapon crit slot that survived. A slot counts as destroyed
 * when its flag is set OR its location is destroyed — plain-damage
 * destruction leaves slot flags unset by design, but blow-off preserves them.
 * Blow-off itself does not destroy the limb's contents (TW p.145).
 */
export function salvageableSeveredLimbs(state: BattleState, unitId: string): LimbLocation[] {
  const unit = requireUnit(state, unitId);
  const def = mechDefFor(unit);
  const out: LimbLocation[] = [];
  for (const { limb, salvageable } of unit.blownOffLimbs) {
    if (!salvageable) continue;
    const slots = def.critSlots[limb];
    if (
      slots.some(
        (slot, i) => slot.kind === "weapon" && !isSlotDestroyed(unit.critSlotsDestroyed, limb, i),
      )
    )
      out.push(limb);
  }
  return out;
}

/**
 * Apply a club drop: clear the held club, leave it intact as a token in the
 * hex (any kind; a later pickup of a token is automatic), and emit
 * `clubDropped`. Caller guarantees `unit.club !== null`. `cause` marks
 * involuntary drops (a fall, or the holder leaving play).
 */
export function applyClubDrop(
  state: BattleState,
  unit: UnitState,
  sink: GameEvent[],
  cause?: "fall" | "removed" | "hands",
): void {
  const held = unit.club;
  if (held === null) throw new Error(`${unit.id} holds no club to drop`);
  unit.club = null;
  const key = hexKey(unit.position);
  const token: ClubGroundToken =
    held.kind === "limb"
      ? { kind: "limb", limb: held.limb, model: held.model, ownerId: held.ownerId }
      : { kind: held.kind };
  state.clubs[key] = [...(state.clubs[key] ?? []), token];
  sink.push({
    kind: "clubDropped",
    unitId: unit.id,
    clubKind: held.kind,
    col: unit.position.col,
    row: unit.position.row,
    returned: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Involuntary release (TW silent): a unit that falls, drops prone, or
 *  leaves play lets go of its club in the hex where it ends up. */
export function releaseClub(
  state: BattleState,
  unit: UnitState,
  cause: "fall" | "removed" | "hands",
  sink: GameEvent[],
): void {
  if (unit.club !== null) applyClubDrop(state, unit, sink, cause);
}

/**
 * Forced drop (TW p.146): a unit whose arms or hand actuators no longer let
 * it hold a club (see `clubHandsFunctional`) lets go of it in its hex. A
 * shoulder hit alone keeps the club; it only blocks the swing.
 */
export function enforceClubHands(state: BattleState, unit: UnitState, sink: GameEvent[]): void {
  if (unit.club === null) return;
  if (!clubHandsFunctional(mechDefFor(unit), unit.damage, unit.critSlotsDestroyed)) {
    applyClubDrop(state, unit, sink, "hands");
  }
}

export function enforceClubHandsAll(state: BattleState, sink: GameEvent[]): void {
  for (const unit of Object.values(state.units)) enforceClubHands(state, unit, sink);
}
