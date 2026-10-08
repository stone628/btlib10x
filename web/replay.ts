/**
 * Replay recording for the web session (format: `docs/REPLAY.md`).
 *
 * The session keeps a {@link ReplayLog} that the commit paths append to while
 * a battle is played; when the battle ends it is shown as a collapsible
 * block. Everything here is a pure encoder over session/engine data except the
 * small hooks (`startReplay`, `recordMove`, `recordAttack`,
 * `finishReplay`) that push finished records into `session.replay`.
 *
 * Only types are imported from `./session`, so `session.ts` can import this
 * module without a runtime cycle.
 */

import {
  type Arc,
  type AttackDecl,
  type ClubPickupDecl,
  FACINGS,
  type Facing,
  isShutdown,
  loadAmmoBins,
  type MoveStep,
  mechDefFor,
  type PhysicalAttackDecl,
  type PhysicalWeaponName,
  type UnitInit,
  type UnitState,
  VERSION,
} from "btlib10x";
import { buildCollapsibleChunk, buildLinesChunk, type Chunk } from "./chunk";
import { i18n } from "./i18n";
import { createRng } from "./rng";
import type { AttackContext, MovementContext, Session, SessionVictoryResult } from "./session";

export interface ReplayLog {
  /** Finished records in order: `V B S U… M A … W E…`. */
  lines: string[];
  /** Unit ids in registration order; the position is the unit index. */
  units: string[];
  /** The match cannot be expressed or reproduced: record nothing, show nothing. */
  disabled: boolean;
}

// ----------------------------------------------------------- alphabets ----

type Loc =
  | "head"
  | "centerTorso"
  | "rightTorso"
  | "leftTorso"
  | "rightArm"
  | "leftArm"
  | "rightLeg"
  | "leftLeg";

/** Location letters, in canonical order. Mirrors `LOC_CODES` in
 *  `src/data/mech.codec.ts` (module-private there). */
const LOC_ORDER: ReadonlyArray<readonly [Loc, string]> = [
  ["head", "h"],
  ["centerTorso", "C"],
  ["rightTorso", "R"],
  ["leftTorso", "L"],
  ["rightArm", "a"],
  ["leftArm", "A"],
  ["rightLeg", "g"],
  ["leftLeg", "G"],
];
const isTorsoLoc = (loc: Loc): boolean =>
  loc === "centerTorso" || loc === "rightTorso" || loc === "leftTorso";

/** Crit slot numbers (1-based) as one char. */
const SLOT_CHARS = "123456789abc";
/** Weapon numbers (1-based) as one char. */
const WPN_CHARS = "123456789abcdefghijklmnopqrstuvwxyz";
/** Most units / weapons / pilot hits one char can name. */
const MAX_UNITS = 36;

function slotChar(n: number): string {
  const c = SLOT_CHARS[n - 1];
  if (c === undefined) throw new Error(`replay: crit slot ${n} is out of range`);
  return c;
}

function wpnChar(n: number): string {
  const c = WPN_CHARS[n - 1];
  if (c === undefined) throw new Error(`replay: weapon number ${n} is out of range`);
  return c;
}

function hexText(col: number, row: number): string {
  return `${String(col).padStart(2, "0")}${String(row).padStart(2, "0")}`;
}

function facingDigit(f: Facing): string {
  return String(FACINGS.indexOf(f));
}

// --------------------------------------------------------- move entries ----

const LOCOMOTION_CHAR: Readonly<Record<string, string>> = {
  standStill: "s",
  walk: "w",
  run: "r",
  jump: "j",
};

function stepsText(steps: readonly MoveStep[]): string {
  return steps
    .map((st) =>
      st.kind === "enter"
        ? hexText(st.to.col, st.to.row)
        : `${st.facings < 0 ? "-" : "+"}${Math.abs(st.facings)}`,
    )
    .join("");
}

/** The declaration part of a movement context that a record needs. */
export type MoveDecl = Pick<
  MovementContext,
  "moveMode" | "postureMove" | "moveSteps" | "moveFinalFacing"
>;

/**
 * `<idx><op>[steps][>dir]` for one movement activation. `downed` is true when
 * the actor is shut down or unconscious *before* the commit: the session then
 * passes whatever mode was declared (`passMovement`).
 */
export function encodeMoveEntry(idx: string, decl: MoveDecl, downed: boolean): string {
  const tail = (): string =>
    stepsText(decl.moveSteps) +
    (decl.moveFinalFacing !== null ? `>${facingDigit(decl.moveFinalFacing)}` : "");
  switch (decl.moveMode) {
    case "shutdown":
      return `${idx}X`;
    case "startup":
      return `${idx}O`;
    case "eject":
      return `${idx}E`;
  }
  if (downed) return `${idx}.`;
  switch (decl.moveMode) {
    case "standup":
      return `${idx}U${LOCOMOTION_CHAR[decl.postureMove ?? "walk"] ?? "w"}${tail()}`;
    case "prone":
      return `${idx}D${tail()}`;
    case "turn":
      return `${idx}w${stepsText(decl.moveSteps)}`;
    case "pronestill":
      return `${idx}s`;
    default:
      return `${idx}${LOCOMOTION_CHAR[decl.moveMode ?? "standStill"] ?? "s"}${tail()}`;
  }
}

// -------------------------------------------------------- attack entries ----

const TWIST_CHAR: Readonly<Record<Arc, string>> = {
  front: "F",
  leftSide: "L",
  rightSide: "R",
  rear: "F",
};

const STRIKE_WEAPON_CHAR: Readonly<Record<PhysicalWeaponName, string>> = {
  Hatchet: "h",
  Sword: "s",
  "Retractable Blade": "b",
};

const PICKUP_SOURCE_CHAR: Readonly<Record<string, string>> = { limb: "l", tree: "t", girder: "g" };

/** Weapon numbers in declaration order; runs of 4+ ascending numbers become `a~b`. */
export function weaponListText(
  decls: readonly Pick<AttackDecl, "weaponIndex" | "rapidFire">[],
): string {
  let out = "";
  let i = 0;
  while (i < decls.length) {
    let j = i;
    while (
      j + 1 < decls.length &&
      decls[j + 1]!.weaponIndex === decls[j]!.weaponIndex + 1 &&
      decls[j + 1]!.rapidFire !== true &&
      decls[j]!.rapidFire !== true
    ) {
      j++;
    }
    if (j - i + 1 >= 4) {
      out += `${wpnChar(decls[i]!.weaponIndex)}~${wpnChar(decls[j]!.weaponIndex)}`;
      i = j + 1;
    } else {
      out += wpnChar(decls[i]!.weaponIndex) + (decls[i]!.rapidFire === true ? "!" : "");
      i++;
    }
  }
  return out;
}

function physicalText(decl: PhysicalAttackDecl): string {
  switch (decl.type) {
    case "punch":
      return decl.limb === "leftArm" ? "P" : "Q";
    case "kick":
      return decl.limb === "leftLeg" ? "K" : "L";
    case "push":
      return "U";
    case "club":
      return "C";
    case "strike":
      return (
        (decl.limb === "leftArm" ? "S" : "T") +
        (decl.weapon === undefined ? "-" : STRIKE_WEAPON_CHAR[decl.weapon])
      );
  }
}

/** The declaration part of an attack context that a record needs. */
export type AttackDeclaration = Pick<
  AttackContext,
  "weaponDecls" | "physicalDecls" | "pickupDecl" | "pickupArgs" | "dropClub" | "torsoTwist"
>;

function pickupText(args: ClubPickupDecl): string {
  const src = args.source === undefined ? "" : (PICKUP_SOURCE_CHAR[args.source] ?? "");
  return `+${src}${args.tokenIndex ?? ""}`;
}

/**
 * `<idx><F|L|R>[-|+…]{:<tgt><items>}` for one attack activation. `idxOf` maps
 * a unit id to its index char. A bare header is a pass.
 */
export function encodeAttackEntry(
  idx: string,
  decl: AttackDeclaration,
  idxOf: (id: string) => string,
): string {
  const head = `${idx}${TWIST_CHAR[decl.torsoTwist]}`;
  if (decl.pickupDecl !== null && decl.pickupArgs !== null) {
    return head + pickupText(decl.pickupArgs);
  }
  const groups = new Map<string, { weapons: AttackDecl[]; physicals: PhysicalAttackDecl[] }>();
  const group = (target: string) => {
    let g = groups.get(target);
    if (g === undefined) {
      g = { weapons: [], physicals: [] };
      groups.set(target, g);
    }
    return g;
  };
  for (const d of decl.weaponDecls) group(d.targetId).weapons.push(d);
  for (const d of decl.physicalDecls) group(d.targetId).physicals.push(d);
  let out = head + (decl.dropClub ? "-" : "");
  for (const [target, g] of groups) {
    out += `:${idxOf(target)}${weaponListText(g.weapons)}${g.physicals.map(physicalText).join("")}`;
  }
  return out;
}

// ------------------------------------------------------------ unit lines ----

/** Damage taken / state shape shared by `U` (from `UnitInit`) and `E` (from state). */
interface DamageFields {
  armor: Partial<Record<Loc, number>>;
  armorRear: Partial<Record<Loc, number>>;
  structure: Partial<Record<Loc, number>>;
  crits: Partial<Record<Loc, readonly number[]>>;
  /** `<loc>:<slot>` style bin id → shots used. */
  ammo: Record<string, number>;
}

function armorField(f: DamageFields): string {
  let out = "";
  for (const [loc, code] of LOC_ORDER) {
    const a = f.armor[loc] ?? 0;
    const r = f.armorRear[loc] ?? 0;
    const s = f.structure[loc] ?? 0;
    if (a === 0 && r === 0 && s === 0) continue;
    const values = isTorsoLoc(loc) ? [a, r, s] : [a, s];
    while (values.length > 1 && values[values.length - 1] === 0) values.pop();
    out += code + values.map((v, i) => (i > 0 && v === 0 ? "" : String(v))).join("/");
  }
  return out;
}

function critField(f: DamageFields): string {
  let out = "";
  for (const [loc, code] of LOC_ORDER) {
    for (const n of [...(f.crits[loc] ?? [])].sort((a, b) => a - b)) out += code + slotChar(n);
  }
  return out;
}

function ammoField(f: DamageFields): string {
  const entries: { loc: number; slot: number; code: string; used: number }[] = [];
  for (const [binId, used] of Object.entries(f.ammo)) {
    if (used <= 0) continue;
    const [loc, slot] = binId.split(":");
    const li = LOC_ORDER.findIndex(([l]) => l === loc);
    if (li < 0 || slot === undefined) throw new Error(`replay: bad ammo bin id ${binId}`);
    entries.push({ loc: li, slot: Number(slot), code: LOC_ORDER[li]![1], used });
  }
  entries.sort((a, b) => a.loc - b.loc || a.slot - b.slot);
  return entries.map((e) => `${e.code}${slotChar(e.slot)}${e.used}`).join("");
}

function joinFields(fields: readonly string[]): string {
  const list = [...fields];
  while (list.length > 0 && list[list.length - 1] === "") list.pop();
  return list.map((f) => `:${f}`).join("");
}

function fieldsOfInit(init: UnitInit): DamageFields {
  const d = init.damage;
  return {
    armor: d?.damageTaken?.armor ?? {},
    armorRear: d?.damageTaken?.armorRear ?? {},
    structure: d?.damageTaken?.internalStructure ?? {},
    crits: d?.critsDestroyed ?? {},
    ammo: d?.ammoUsed ?? {},
  };
}

const POLICY_CHAR: Readonly<Record<string, string>> = {
  exposed: "e",
  core: "c",
  spread: "s",
  leastFirst: "l",
};

/** `U<team><id>:<model>:<place>[:<armor>[:<crit>[:<ammo>[:<policy>]]]]` */
export function encodeUnitLine(init: UnitInit): string {
  const hits = init.damage?.pilotHits ?? 0;
  const place =
    hexText(init.position.col, init.position.row) +
    facingDigit(init.facing) +
    String(init.gunnery) +
    String(init.piloting) +
    init.pilotHitMax.toString(36) +
    (hits > 0 ? hits.toString(36) : "");
  const f = fieldsOfInit(init);
  const policy = POLICY_CHAR[init.policy.ammoPolicy] ?? "e";
  return `U${init.team}${init.id}:${init.model}:${place}${joinFields([
    armorField(f),
    critField(f),
    ammoField(f),
    policy === "e" ? "" : policy,
  ])}`;
}

/** `E<idx><hits>[:<armor>[:<crit>[:<ammo>]]]`: state vs the model default. */
export function encodeEndLine(idx: string, unit: UnitState): string {
  const def = mechDefFor(unit);
  const f: DamageFields = { armor: {}, armorRear: {}, structure: {}, crits: {}, ammo: {} };
  for (const [loc] of LOC_ORDER) {
    f.armor[loc] = def.armor[loc] - unit.damage.armor[loc];
    f.structure[loc] = def.internalStructure[loc] - unit.damage.internalStructure[loc];
    if (isTorsoLoc(loc)) {
      f.armorRear[loc] =
        def.armorRear[loc as "centerTorso"] - unit.damage.armorRear[loc as "centerTorso"];
    }
    const flags = unit.critSlotsDestroyed[loc];
    const slots: number[] = [];
    flags.forEach((hit, i) => {
      if (hit) slots.push(i + 1);
    });
    f.crits[loc] = slots;
  }
  const loaded = loadAmmoBins(def);
  for (const [binId, bin] of Object.entries(unit.ammoBins)) {
    f.ammo[binId] = (loaded[binId]?.shots ?? 0) - bin.shots;
  }
  return `E${idx}${unit.pilotHits.toString(36)}${joinFields([
    armorField(f),
    critField(f),
    ammoField(f),
  ])}`;
}

/** `W<team|-><rng>`: winner plus the final Rng state as 8 hex digits. */
export function encodeWinnerLine(victory: SessionVictoryResult, rngSnapshot: string): string {
  const team = victory.draw || victory.winnerTeam === null ? "-" : String(victory.winnerTeam);
  return `W${team}${normalizeRng(rngSnapshot)}`;
}

/** `Rng.snapshot()` prints the raw (possibly negative) int in hex; make it uint32, 8 digits. */
export function normalizeRng(snapshot: string): string {
  return (parseInt(snapshot, 16) >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------- hooks ----

function usable(s: Session): s is Session & { replay: ReplayLog } {
  return s.replay !== null && !s.replay.disabled;
}

function canExpress(s: Session): boolean {
  const roster = s.setup.roster;
  if (roster.length > MAX_UNITS) return false;
  for (const u of roster) {
    if (!Number.isInteger(u.team) || u.team < 0 || u.team > 9) return false;
    if (/[:;,\s]/.test(u.id)) return false;
    if (u.pilotHitMax > MAX_UNITS - 1 || (u.damage?.pilotHits ?? 0) > MAX_UNITS - 1) return false;
  }
  // Replays start from a fresh generator for the setup seed; a session whose
  // rng was replaced or already used cannot be reproduced.
  return s.rng.snapshot() === createRng(s.setup.seed).snapshot();
}

/** Begin a log for the battle that was just created (before the first `drive`). */
export function startReplay(s: Session): void {
  const disabled = !canExpress(s);
  s.replay = { lines: [], units: s.setup.roster.map((u) => u.id), disabled };
  if (disabled) return;
  s.replay.lines.push(
    `V${VERSION}`,
    `B${s.setup.mapName ?? ""}`,
    `S${s.setup.seed}`,
    ...s.setup.roster.map(encodeUnitLine),
  );
}

function indexOfUnit(log: ReplayLog, id: string): string {
  const i = log.units.indexOf(id);
  if (i < 0) throw new Error(`replay: unknown unit ${id}`);
  return i.toString(36);
}

/** Record the movement activation about to be committed (call before the engine calls). */
export function recordMove(s: Session, decl: MoveDecl, actor: UnitState): void {
  if (!usable(s)) return;
  const downed = isShutdown(actor) || actor.unconscious;
  s.replay.lines.push(`M${encodeMoveEntry(indexOfUnit(s.replay, actor.id), decl, downed)}`);
}

/** Record the attack activation about to be committed (call before the engine calls). */
export function recordAttack(s: Session, decl: AttackDeclaration, actorId: string): void {
  if (!usable(s)) return;
  const log = s.replay;
  s.replay.lines.push(
    `A${encodeAttackEntry(indexOfUnit(log, actorId), decl, (id) => indexOfUnit(log, id))}`,
  );
}

/** Close the log when the battle is over: winner + rng checksum, then final unit states. */
export function finishReplay(s: Session, victory: SessionVictoryResult): void {
  if (!usable(s) || s.battle === null) return;
  const log = s.replay;
  log.lines.push(encodeWinnerLine(victory, s.rng.snapshot()));
  log.units.forEach((id, i) => {
    const unit = s.battle!.units[id];
    if (unit !== undefined) log.lines.push(encodeEndLine(i.toString(36), unit));
  });
}

/** The collapsible "you can replay this match" block, or null when there is nothing to show. */
export function replayChunk(s: Session): Chunk | null {
  if (!usable(s) || s.replay.lines.length === 0) return null;
  return buildCollapsibleChunk(i18n("replay.summary"), [
    buildLinesChunk(i18n("replay.help")),
    buildLinesChunk(...s.replay.lines),
  ]);
}
