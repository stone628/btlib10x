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
  type HexCoord,
  isShutdown,
  loadAmmoBins,
  type MoveStep,
  mechDefFor,
  neighbor,
  type PhysicalAttackDecl,
  type PhysicalWeaponName,
  sameHex,
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

/** Facings as keyboard letters: `b n m` / `a s d` read west to east. */
const FACING_CHAR: Readonly<Record<Facing, string>> = {
  n: "n",
  ne: "m",
  se: "d",
  s: "s",
  sw: "a",
  nw: "b",
};

function facingChar(f: Facing): string {
  return FACING_CHAR[f];
}

// --------------------------------------------------------- move entries ----

const LOCOMOTION_CHAR: Readonly<Record<string, string>> = {
  standStill: "s",
  walk: "w",
  run: "r",
  jump: "j",
};

/** Where the actor stands before the move; steps are written relative to it. */
export interface MoveStart {
  readonly position: HexCoord;
  readonly facing: Facing;
}

/**
 * Steps as `<` (turn left), `>` (turn right), `+` (forward), `-` (backward),
 * relative to a cursor that starts at `start`. On the ground the engine only
 * allows entering the hex ahead or behind, and turns are engine steps. A jump
 * may enter any neighbour: the cursor re-aims for free (the decoder must not
 * turn those into engine steps) and then steps `+`, or `-` when the target is
 * exactly behind.
 */
export function stepsText(steps: readonly MoveStep[], start: MoveStart, jumping: boolean): string {
  let out = "";
  let hex = start.position;
  let heading = FACINGS.indexOf(start.facing);
  for (const st of steps) {
    if (st.kind === "turn") {
      if (jumping) throw new Error("replay: a jump has no turn steps");
      out += (st.facings > 0 ? ">" : "<").repeat(Math.abs(st.facings));
      heading += st.facings;
      continue;
    }
    const dir = FACINGS.findIndex((f) => sameHex(neighbor(hex, f), st.to));
    if (dir < 0) throw new Error("replay: step is not into an adjacent hex");
    const diff = (((dir - heading) % 6) + 6) % 6;
    if (diff === 3) {
      out += "-";
    } else if (diff === 0) {
      out += "+";
    } else if (!jumping) {
      throw new Error("replay: ground step is neither forward nor backward");
    } else {
      out += diff < 3 ? ">".repeat(diff) : "<".repeat(6 - diff);
      out += "+";
      heading = dir;
    }
    hex = st.to;
  }
  return out;
}

/** The declaration part of a movement context that a record needs. */
export type MoveDecl = Pick<
  MovementContext,
  "moveMode" | "postureMove" | "moveSteps" | "moveFinalFacing"
>;

/**
 * `<idx><op>[steps][facing]` for one movement activation. `downed` is true
 * when the actor is shut down or unconscious *before* the commit: the session
 * then passes whatever mode was declared (`passMovement`).
 */
export function encodeMoveEntry(
  idx: string,
  decl: MoveDecl,
  downed: boolean,
  start: MoveStart,
): string {
  const jumping =
    (decl.moveMode === "standup" || decl.moveMode === "prone"
      ? (decl.postureMove ?? "walk")
      : decl.moveMode) === "jump";
  const steps = (): string => stepsText(decl.moveSteps, start, jumping);
  const tail = (): string =>
    steps() + (decl.moveFinalFacing !== null ? facingChar(decl.moveFinalFacing) : "");
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
      return `${idx}w${steps()}`;
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
    facingChar(init.facing) +
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

/**
 * Recording must never break a game: if an entry cannot be expressed, drop the
 * whole log (and show nothing at the end) instead of failing the commit.
 */
function guarded(s: Session & { replay: ReplayLog }, record: (log: ReplayLog) => void): void {
  try {
    record(s.replay);
  } catch {
    s.replay.lines.length = 0;
    s.replay.disabled = true;
  }
}

/** Record the movement activation about to be committed (call before the engine calls). */
export function recordMove(s: Session, decl: MoveDecl, actor: UnitState): void {
  if (!usable(s)) return;
  const downed = isShutdown(actor) || actor.unconscious;
  guarded(s, (log) => {
    const start = { position: actor.position, facing: actor.facing };
    log.lines.push(`M${encodeMoveEntry(indexOfUnit(log, actor.id), decl, downed, start)}`);
  });
}

/** Record the attack activation about to be committed (call before the engine calls). */
export function recordAttack(s: Session, decl: AttackDeclaration, actorId: string): void {
  if (!usable(s)) return;
  guarded(s, (log) => {
    log.lines.push(
      `A${encodeAttackEntry(indexOfUnit(log, actorId), decl, (id) => indexOfUnit(log, id))}`,
    );
  });
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

/**
 * Lay the records out for reading and copying. The result is still valid
 * replay text (decoders take `;` and newline interchangeably):
 *
 *   V…                      version alone
 *   B…;S…                   setup records other than units, joined by `;`
 *   U…                      one line per unit
 *   M…;M…                   a turn's movement activations, joined by `;`
 *   A…;A…                   the same turn's attack activations
 *   (more M / A line pairs, one per turn)
 *   W…                      winner line
 *   E…                      one line per unit's final state
 */
export function replayPrettifier(records: readonly string[]): string[] {
  const out: string[] = [];
  const setup: string[] = [];
  let i = 0;
  const flushSetup = () => {
    if (setup.length > 0) out.push(setup.join(";"));
    setup.length = 0;
  };
  while (i < records.length) {
    const kind = records[i]![0];
    if (kind === "U" || kind === "V" || kind === "W" || kind === "E") {
      flushSetup();
      out.push(records[i]!);
      i++;
    } else if (kind === "B" || kind === "S" || kind === "K") {
      setup.push(records[i]!);
      i++;
    } else {
      // M and A merge with their neighbours of the same kind; anything
      // unknown stands alone on its own line.
      flushSetup();
      const merge = kind === "M" || kind === "A";
      let j = i + 1;
      while (merge && j < records.length && records[j]![0] === kind) j++;
      out.push(records.slice(i, j).join(";"));
      i = j;
    }
  }
  flushSetup();
  return out;
}

/** The collapsible "you can replay this match" block, or null when there is nothing to show. */
export function replayChunk(s: Session): Chunk | null {
  if (!usable(s) || s.replay.lines.length === 0) return null;
  return buildCollapsibleChunk(i18n("replay.summary"), [
    buildLinesChunk(i18n("replay.help", { version: VERSION })),
    buildLinesChunk(...replayPrettifier(s.replay.lines)),
  ]);
}
