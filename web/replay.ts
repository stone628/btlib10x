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
  type AmmoPolicy,
  type Arc,
  type AttackDecl,
  attemptStandUp,
  attemptVoluntaryStartup,
  type BattleState,
  buildUnitInit,
  type ClubKind,
  type ClubPickupDecl,
  createBattle,
  DROP_MP_COST,
  declareAttacks,
  declarePickup,
  destroyedSlots,
  dropProne,
  ejectPilot,
  ensureMapRegistered,
  executeMove,
  FACINGS,
  type Facing,
  type GameEvent,
  gameLoop,
  type HexCoord,
  isShutdown,
  isTorso,
  type Location,
  type LocationValue,
  loadAmmoBins,
  type MoveMode,
  type MoveStep,
  mapDefFor,
  mechDefFor,
  neighbor,
  oppositeFacing,
  type PhysicalAttackDecl,
  type PhysicalWeaponName,
  passMovement,
  rotateFacing,
  sameHex,
  type TorsoLocationValue,
  type UnitInit,
  type UnitInitDamage,
  type UnitState,
  VERSION,
  voluntaryShutdown,
} from "btlib10x";
import { buildCollapsibleChunk, buildLinesChunk, type Chunk } from "./chunk";
import { i18n } from "./i18n";
import { createRng } from "./rng";
import {
  type AttackContext,
  checkBattleVictory,
  type MovementContext,
  type Session,
  type SessionVictoryResult,
} from "./session";

export interface ReplayLog {
  /** Finished records in order: `V B S U… M A … W E…`. */
  lines: string[];
  /** Unit ids in registration order; the position is the unit index. */
  units: string[];
  /** The match cannot be expressed or reproduced: record nothing, show nothing. */
  disabled: boolean;
}

// ----------------------------------------------------------- alphabets ----

/** Location letters, in canonical order. Mirrors `LOC_CODES` in
 *  `src/data/mech.codec.ts` (module-private there). */
const LOC_ORDER: ReadonlyArray<readonly [Location, string]> = [
  ["head", "h"],
  ["centerTorso", "C"],
  ["rightTorso", "R"],
  ["leftTorso", "L"],
  ["rightArm", "a"],
  ["leftArm", "A"],
  ["rightLeg", "g"],
  ["leftLeg", "G"],
];

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
  armor: Partial<LocationValue>;
  armorRear: Partial<TorsoLocationValue>;
  structure: Partial<LocationValue>;
  crits: Partial<Record<Location, readonly number[]>>;
  /** `<loc>:<slot>` style bin id → shots used. */
  ammo: Record<string, number>;
}

function armorField(f: DamageFields): string {
  let out = "";
  for (const [loc, code] of LOC_ORDER) {
    const a = f.armor[loc] ?? 0;
    const r = isTorso(loc) ? (f.armorRear[loc] ?? 0) : 0;
    const s = f.structure[loc] ?? 0;
    if (a === 0 && r === 0 && s === 0) continue;
    const values = isTorso(loc) ? [a, r, s] : [a, s];
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
    if (isTorso(loc)) {
      f.armorRear[loc] =
        def.armorRear[loc as "centerTorso"] - unit.damage.armorRear[loc as "centerTorso"];
    }
    f.crits[loc] = destroyedSlots(unit.critSlotsDestroyed, loc).map((i) => i + 1);
  }
  const loaded = loadAmmoBins(def);
  for (const [binId, shots] of Object.entries(unit.ammoBins)) {
    f.ammo[binId] = (loaded[binId] ?? 0) - shots;
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

// ---------------------------------------------------------------- player ----

const LOC_BY_CODE: ReadonlyMap<string, Location> = new Map(
  LOC_ORDER.map(([loc, code]) => [code, loc]),
);
const FACING_BY_CHAR: ReadonlyMap<string, Facing> = new Map(
  (Object.entries(FACING_CHAR) as [Facing, string][]).map(([f, c]) => [c, f]),
);
const POLICY_BY_CHAR: ReadonlyMap<string, AmmoPolicy> = new Map([
  ["e", "exposed"],
  ["c", "core"],
  ["s", "spread"],
  ["l", "leastFirst"],
]);
const MODE_BY_CHAR: Readonly<Record<string, MoveMode>> = {
  s: "standStill",
  w: "walk",
  r: "run",
  j: "jump",
};
const TWIST_BY_CHAR: Readonly<Record<string, Arc>> = { F: "front", L: "leftSide", R: "rightSide" };
const STRIKE_WEAPON_BY_CHAR: Readonly<Record<string, PhysicalWeaponName>> = {
  h: "Hatchet",
  s: "Sword",
  b: "Retractable Blade",
};
const PICKUP_SOURCE_BY_CHAR: Readonly<Record<string, ClubKind>> = {
  l: "limb",
  t: "tree",
  g: "girder",
};

function slotNumber(c: string | undefined): number {
  const i = c === undefined ? -1 : SLOT_CHARS.indexOf(c);
  if (i < 0) throw new Error(`bad crit slot character ${JSON.stringify(c)}`);
  return i + 1;
}

function locOf(c: string | undefined): Location {
  const loc = c === undefined ? undefined : LOC_BY_CODE.get(c);
  if (loc === undefined) throw new Error(`bad location character ${JSON.stringify(c)}`);
  return loc;
}

/** Inverse of {@link encodeUnitLine}. Throws a plain `Error` describing what is wrong. */
export function decodeUnitLine(line: string): UnitInit {
  if (line[0] !== "U") throw new Error("not a unit record");
  const parts = line.slice(1).split(":");
  const [head, model, place, armor = "", crit = "", ammo = "", policy = ""] = parts;
  if (parts.length > 7 || head === undefined || model === undefined || place === undefined) {
    throw new Error("unit record needs U<team><id>:<model>:<place>");
  }
  const team = Number(head[0]);
  const id = head.slice(1);
  if (!Number.isInteger(team) || id === "")
    throw new Error("unit record needs a team digit and an id");
  const m = /^(\d\d)(\d\d)([nmdsab])(\d)(\d)([0-9a-z])([0-9a-z])?$/.exec(place);
  if (m === null) throw new Error(`bad unit place ${JSON.stringify(place)}`);
  const [, col, row, facing, gunnery, piloting, hitMax, hits] = m;
  const damage: UnitInitDamage = {};
  const taken: NonNullable<UnitInitDamage["damageTaken"]> = {};
  if (hits !== undefined && parseInt(hits, 36) > 0) damage.pilotHits = parseInt(hits, 36);
  // armor: <loc><front>[/<rear>]/<internal>, trailing zeros dropped, empty = 0
  for (const mm of armor.matchAll(/([hCRLaAgG])([0-9/]*)/g)) {
    const loc = locOf(mm[1]);
    const v = mm[2]!.split("/").map((x) => (x === "" ? 0 : Number(x)));
    const [front = 0, second = 0, third = 0] = v;
    const rear = isTorso(loc) ? second : 0;
    const structure = isTorso(loc) ? third : second;
    if (front > 0) taken.armor = { ...taken.armor, [loc]: front };
    if (rear > 0) taken.armorRear = { ...taken.armorRear, [loc]: rear };
    if (structure > 0) taken.internalStructure = { ...taken.internalStructure, [loc]: structure };
  }
  if (armor.replace(/([hCRLaAgG])([0-9/]*)/g, "") !== "") throw new Error("bad armor field");
  if (Object.keys(taken).length > 0) damage.damageTaken = taken;
  if (crit.length % 2 !== 0) throw new Error("bad crit field");
  for (let i = 0; i < crit.length; i += 2) {
    const loc = locOf(crit[i]);
    const crits = damage.critsDestroyed ?? {};
    damage.critsDestroyed = { ...crits, [loc]: [...(crits[loc] ?? []), slotNumber(crit[i + 1])] };
  }
  if (ammo.replace(/([hCRLaAgG])([1-9abc])(\d+)/g, "") !== "") throw new Error("bad ammo field");
  for (const mm of ammo.matchAll(/([hCRLaAgG])([1-9abc])(\d+)/g)) {
    damage.ammoUsed = {
      ...damage.ammoUsed,
      [`${locOf(mm[1])}:${slotNumber(mm[2])}`]: Number(mm[3]),
    };
  }
  const ammoPolicy = policy === "" ? "exposed" : POLICY_BY_CHAR.get(policy);
  if (ammoPolicy === undefined) throw new Error(`bad ammo policy ${JSON.stringify(policy)}`);
  const init = buildUnitInit(
    id,
    model,
    team,
    { col: Number(col), row: Number(row) },
    FACING_BY_CHAR.get(facing!)!,
    Number(gunnery) as UnitInit["gunnery"],
    Number(piloting) as UnitInit["piloting"],
    parseInt(hitMax!, 36),
    { ammoPolicy },
  );
  return Object.keys(damage).length > 0 ? { ...init, damage } : init;
}

/**
 * Steps (`< > + -`) plus an optional trailing facing letter, relative to
 * the actor's hex and heading. On the ground a turn is an engine step; in a
 * jump it only re-aims the travel direction.
 */
function decodeSteps(
  text: string,
  start: { position: HexCoord; facing: Facing },
  jumping: boolean,
): { steps: MoveStep[]; finalFacing: Facing | null } {
  const steps: MoveStep[] = [];
  let hex = start.position;
  let heading = start.facing;
  let finalFacing: Facing | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === ">" || c === "<") {
      const d = c === ">" ? 1 : -1;
      heading = rotateFacing(heading, d);
      if (!jumping) steps.push({ kind: "turn", facings: d });
    } else if (c === "+" || c === "-") {
      hex = neighbor(hex, c === "+" ? heading : oppositeFacing(heading));
      steps.push({ kind: "enter", to: hex });
    } else if (i === text.length - 1 && FACING_BY_CHAR.has(c)) {
      finalFacing = FACING_BY_CHAR.get(c)!;
    } else {
      throw new Error(`unexpected ${JSON.stringify(c)} in the movement steps`);
    }
  }
  return { steps, finalFacing };
}

interface DecodedAttack {
  twist: Arc;
  dropClub: boolean;
  pickup: ClubPickupDecl | null;
  weapons: { weaponIndex: number; targetId: string; rapidFire?: boolean }[];
  physicals: PhysicalAttackDecl[];
}

function decodeAttackBody(body: string, unitAt: (c: string) => string): DecodedAttack {
  const twist = TWIST_BY_CHAR[body[0] ?? ""];
  if (twist === undefined) throw new Error(`bad torso twist ${JSON.stringify(body[0])}`);
  const out: DecodedAttack = { twist, dropClub: false, pickup: null, weapons: [], physicals: [] };
  let rest = body.slice(1);
  if (rest[0] === "-") {
    out.dropClub = true;
    rest = rest.slice(1);
  } else if (rest[0] === "+") {
    const m = /^\+([ltg])?(\d)?$/.exec(rest);
    if (m === null) throw new Error(`bad pickup ${JSON.stringify(rest)}`);
    out.pickup = {
      ...(m[1] !== undefined ? { source: PICKUP_SOURCE_BY_CHAR[m[1]]! } : {}),
      ...(m[2] !== undefined ? { tokenIndex: Number(m[2]) } : {}),
    };
    return out;
  }
  if (rest !== "" && rest[0] !== ":")
    throw new Error(`unexpected ${JSON.stringify(rest[0])} in the attack`);
  for (const group of rest === "" ? [] : rest.slice(1).split(":")) {
    if (group === "") throw new Error("empty target group");
    const targetId = unitAt(group[0]!);
    const wpn = (c: string | undefined): number => {
      const i = c === undefined ? -1 : WPN_CHARS.indexOf(c);
      if (i < 0) throw new Error(`bad weapon character ${JSON.stringify(c)}`);
      return i + 1;
    };
    for (let i = 1; i < group.length; i++) {
      const c = group[i]!;
      const physical = ((): PhysicalAttackDecl | null => {
        switch (c) {
          case "P":
            return { type: "punch", targetId, limb: "leftArm" };
          case "Q":
            return { type: "punch", targetId, limb: "rightArm" };
          case "K":
            return { type: "kick", targetId, limb: "leftLeg" };
          case "L":
            return { type: "kick", targetId, limb: "rightLeg" };
          case "U":
            return { type: "push", targetId };
          case "C":
            return { type: "club", targetId };
          case "S":
          case "T": {
            const w = group[++i];
            const weapon = w === undefined ? undefined : STRIKE_WEAPON_BY_CHAR[w];
            if (w !== "-" && weapon === undefined)
              throw new Error(`bad strike weapon ${JSON.stringify(w)}`);
            return {
              type: "strike",
              targetId,
              limb: c === "S" ? "leftArm" : "rightArm",
              ...(weapon !== undefined ? { weapon } : {}),
            };
          }
          default:
            return null;
        }
      })();
      if (physical !== null) {
        out.physicals.push(physical);
      } else if (group[i + 1] === "~") {
        const from = wpn(c);
        const to = wpn(group[i + 2]);
        if (to < from) throw new Error("descending weapon range");
        for (let n = from; n <= to; n++) out.weapons.push({ weaponIndex: n, targetId });
        i += 2;
      } else {
        const rapid = group[i + 1] === "!";
        out.weapons.push({ weaponIndex: wpn(c), targetId, ...(rapid ? { rapidFire: true } : {}) });
        if (rapid) i++;
      }
    }
  }
  return out;
}

/**
 * Replay a recorded match (raw or prettified text) and check it: the engine
 * calls are re-run on the seeded dice until the `W` line, and the resulting
 * unit states must equal the `E` lines. Returns normally when everything
 * matches; otherwise throws one `Error` naming the turn, phase and actor and
 * why. Prints nothing.
 */
export function replayPlayer(text: string): void {
  const records = text
    .split(/[;\n]/)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  let version: string | null = null;
  let mapName: string | null = null;
  let seed: number | null = null;
  let critsDisabled = false;
  const inits: UnitInit[] = [];
  let battle: BattleState | null = null;
  let rng = createRng(0);
  let actor: string | null = null;
  let over: { winnerTeam: number | null; draw: boolean } | null = null;
  let ended = false;
  const checked = new Set<string>();
  let record = "";
  const sink: GameEvent[] = [];

  const unitAt = (c: string): string => {
    const id = inits[parseInt(c, 36)]?.id;
    if (id === undefined) throw new Error(`unknown unit index ${JSON.stringify(c)}`);
    return id;
  };
  const advance = (): void => {
    const b = battle!;
    const found: { winnerTeam: number | null; draw: boolean }[] = [];
    const r = gameLoop(
      b,
      rng,
      (state) => {
        const v = checkBattleVictory(state);
        if (v !== null) found.push(v);
        return v !== null;
      },
      sink,
    );
    over = found[0] ?? null;
    actor = r.actorId;
  };
  const begin = (): BattleState => {
    if (battle !== null) return battle;
    if (mapName === null) throw new Error("the replay names no map (B record)");
    if (seed === null) throw new Error("the replay names no seed (S record)");
    ensureMapRegistered(mapName);
    rng = createRng(seed);
    battle = createBattle(mapDefFor({ mapName }), inits, { critsDisabled });
    advance();
    return battle;
  };

  const move = (b: BattleState, id: string, body: string): void => {
    const unit = b.units[id]!;
    const op = body[1];
    const mode = op === undefined ? undefined : MODE_BY_CHAR[op];
    const opts = (finalFacing: Facing | null, extra: object = {}) => ({
      rng,
      ...extra,
      ...(finalFacing !== null ? { finalFacing } : {}),
    });
    const start = { position: unit.position, facing: unit.facing };
    if (op === "X") {
      voluntaryShutdown(b, id, sink);
      return;
    }
    if (op === "O") {
      attemptVoluntaryStartup(b, id, sink, rng);
      return;
    }
    if (op === "E") {
      ejectPilot(b, id, rng, sink);
      return;
    }
    if (op === ".") {
      passMovement(b, id);
      return;
    }
    if (op === "U") {
      const loco = MODE_BY_CHAR[body[2] ?? ""];
      if (loco === undefined || loco === "jump") {
        throw new Error(`bad stand-up locomotion ${JSON.stringify(body[2])}`);
      }
      const { steps, finalFacing } = decodeSteps(body.slice(3), start, false);
      const posture = attemptStandUp(b, id, sink, rng, loco);
      if (!b.units[id]!.prone && (steps.length > 0 || finalFacing !== null)) {
        executeMove(
          b,
          id,
          loco,
          steps,
          sink,
          opts(finalFacing, {
            spentMP: posture,
            modeHeatPaid: loco === "walk" || loco === "run",
          }),
        );
      }
      return;
    }
    if (op === "D") {
      const { steps, finalFacing } = decodeSteps(body.slice(2), start, false);
      dropProne(b, id, sink, rng);
      if (steps.length > 0 || finalFacing !== null) {
        executeMove(b, id, "walk", steps, sink, opts(finalFacing, { spentMP: DROP_MP_COST }));
      }
      return;
    }
    if (mode === undefined) throw new Error(`unknown movement op ${JSON.stringify(op)}`);
    const { steps, finalFacing } = decodeSteps(body.slice(2), start, mode === "jump");
    executeMove(b, id, mode, steps, sink, opts(finalFacing));
  };

  const attack = (b: BattleState, id: string, body: string): void => {
    const a = decodeAttackBody(body.slice(1), unitAt);
    if (a.pickup !== null) {
      declarePickup(b, id, a.pickup, sink);
      return;
    }
    if (a.weapons.length === 0 && a.physicals.length === 0 && !a.dropClub) {
      b.units[id]!.passedAttacks = true;
      return;
    }
    declareAttacks(b, id, a.weapons, a.physicals, sink, rng, {
      twist: a.twist,
      dropClub: a.dropClub,
    });
  };

  try {
    for (const rec of records) {
      record = rec;
      const kind = rec[0];
      if (ended && kind !== "E") throw new Error("only E records may follow W");
      switch (kind) {
        case "V":
          version = rec.slice(1);
          break;
        case "B":
        case "S":
        case "K":
        case "U":
          if (battle !== null) throw new Error(`${kind} record after the battle started`);
          if (kind === "B") mapName = rec.slice(1);
          else if (kind === "S") seed = Number(rec.slice(1));
          else if (kind === "K") critsDisabled = true;
          else inits.push(decodeUnitLine(rec));
          if (kind === "S" && !Number.isInteger(seed)) throw new Error("bad seed");
          break;
        case "M":
        case "A": {
          const b = begin();
          if (over !== null) throw new Error("the battle is already over");
          const wanted = kind === "M" ? "movement" : "attack";
          if (b.phase !== wanted) {
            throw new Error(`a ${wanted} activation was recorded but the ${b.phase} phase is due`);
          }
          const id = unitAt(rec[1] ?? "");
          if (id !== actor) throw new Error(`${id} acts in the record but ${actor} is due`);
          if (kind === "M") move(b, id, rec.slice(1));
          else attack(b, id, rec.slice(1));
          advance();
          break;
        }
        case "W": {
          begin();
          if (over === null) throw new Error("W recorded but the battle is not over");
          const o: { winnerTeam: number | null; draw: boolean } = over;
          const team = o.draw || o.winnerTeam === null ? "-" : String(o.winnerTeam);
          const expected = `W${team}${normalizeRng(rng.snapshot())}`;
          if (rec !== expected) throw new Error(`expected ${expected}, replayed to ${rec}`);
          ended = true;
          break;
        }
        case "E": {
          if (!ended || battle === null) throw new Error("E record before W");
          const id = unitAt(rec[1] ?? "");
          if (checked.has(id)) throw new Error(`unit ${id} has two E records`);
          checked.add(id);
          const expected = encodeEndLine(rec[1]!, (battle as BattleState).units[id]!);
          if (rec !== expected) throw new Error(`unit ${id} ended as ${expected}, recorded ${rec}`);
          break;
        }
        default:
          throw new Error(`unknown record ${JSON.stringify(kind)}`);
      }
    }
    record = "";
    if (!ended) throw new Error("the replay ends before its W line");
    for (const init of inits) {
      if (!checked.has(init.id)) throw new Error(`no E record for unit ${init.id}`);
    }
  } catch (e) {
    const b = battle as BattleState | null;
    const why = e instanceof Error ? e.message : String(e);
    const phase = b === null ? "setup" : over !== null ? "end" : b.phase;
    const note =
      version !== null && version !== VERSION
        ? ` (recorded with ${version}, engine is ${VERSION})`
        : "";
    throw new Error(
      `replay failed at turn ${b?.turn ?? 0}, ${phase} phase, actor ${actor ?? "-"}: ${why}` +
        `${record === "" ? "" : ` [record: ${record}]`}${note}`,
    );
  }
}
