import type { ClubKind, Facing, UnitState } from "btlib10x";
import {
  ensureMapRegistered,
  FACINGS,
  listMapNames,
  requireUnit,
  sameHex,
  VERSION,
} from "btlib10x";
import type { ArmLocation, LegLocation } from "../../src/core/types";
import { buildLinesChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import type { MessageKey } from "./i18n/index";
import { i18n, localeList, normalizeLocale } from "./i18n/index";
import { lookupMap } from "./lookup";
import { strictInt } from "./misc";
import { resetPersonaBattle } from "./persona";
import { drivePersona, drivesAfter, personaCmd, personaWaitingChunks } from "./persona.cli";
import { clearSnapshots, recordPromptSnapshot, rollbackSession } from "./rollback";
import type { Session } from "./session";
import {
  attackStatusChunk,
  boardChunk,
  cancelAttack,
  cancelMovement,
  commitAttack,
  commitMovement,
  configLocale,
  declaredMovementModeChunk,
  declareMovementMode,
  ensureMoveCandidate,
  fireSuggestionChunks,
  handleSessionGameEvents,
  heatStatusLines,
  infoMechChunk,
  moveStatusChunk,
  overRematch,
  overStatusChunk,
  parseMoveMode,
  parseTorsoTwist,
  parseUnitProp,
  placeLanding,
  queueDrop,
  queuedMoveChunk,
  queuePhysicalAttack,
  queuePickup,
  queueWeaponAttacks,
  reachableChunk,
  requireBattle,
  resetSession,
  setConfigLocale,
  setSeed,
  setTorsoTwist,
  setupAddUnit,
  setupRemoveUnit,
  setupSetMap,
  setupSetUnitProp,
  setupStartBattle,
  setupStatus,
  sheetForUnit,
  stepResultChunk,
  twistLabel,
  unitBriefList,
  victoryBannerChunk,
} from "./session";
import {
  infoMapChunks,
  infoMapListChunk,
  infoMechQuery,
  infoWeaponQuery,
  listTables,
  renderClusterTable,
  renderCriticalTable,
  renderHeatScaleTable,
  renderHitLocationTables,
} from "./table";

export interface CmdDef {
  /** Catalog key of the one-line description. */
  readonly helpKey: MessageKey;
  /** Full invocation form including arguments (locale-neutral syntax). */
  readonly usage?: string;
  /** Per-argument documentation shown by `help <command>` ([pattern, catalog key]). */
  readonly argsDoc?: ReadonlyArray<readonly [string, MessageKey]>;
  /** an array of {@link Chunk}s for structured output. */
  run: (session: Session, args: string[]) => Chunk[];
}

// ------------------------------------------------------------- parsing ----

function int(value: string, label: string): number {
  const n = strictInt(value);
  if (n === null) throw new Error(i18n("err.notInteger", { label }));
  return n;
}

/** User-facing 1-based coordinate -> engine coordinate. */
function coord(value: string, label: string): number {
  const n = int(value, label);
  if (n < 1) throw new Error(i18n("err.oneBased", { label }));
  return n;
}

function expectArgs(args: readonly string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(i18n("err.expectedArgs", { usage }));
}

/** Command id argument: explicit unit id, else the acting unit when present. */
function _idOrActor(s: Session, args: readonly string[]): string {
  if (args[0] !== undefined) return args[0];
  const actor = currentActor(s);
  if (actor !== null) return actor.id;
  throw new Error(i18n("err.needsActor"));
}

function currentActor(s: Session): UnitState | null {
  if (s.battle !== null) {
    switch (s.battle.phase) {
      case "movement":
        if (s.move !== null) return requireUnit(s.battle, s.move.actorId);
        break;
      case "attack":
        if (s.attack !== null) return requireUnit(s.battle, s.attack.actorId);
        break;
    }
  }
  return null;
}

function actorBy(s: Session, id: string): UnitState {
  const units = requireBattle(s).units;
  const unit = Object.hasOwn(units, id) ? units[id] : undefined;
  if (unit === undefined) throw new Error(i18n("err.unknownUnitId", { id }));
  return unit;
}

/** Resolve a `place` facing argument: an absolute facing word. */
function resolveFacing(arg: string): Facing {
  const facing = FACINGS.find((f) => f === arg.toLowerCase());
  if (!facing) throw new Error(i18n("err.faceArg", { facings: FACINGS.join("/") }));
  return facing;
}

function cmdRunChunks(...lines: string[]): Chunk[] {
  return [buildLinesChunk(...lines)];
}

// ------------------------------------------------------------- globals ----
/** Multi-line grouped usage shared by the `info` help entry and its arg errors. */
const INFO_USAGE = [
  "info mech [model | text] [key:value ...] [!]",
  "info map [name]",
  "info weapon [name | text] [key:value ...] [!]",
].join("\n");
const GLOBAL_CMDS: Record<string, CmdDef> = {
  help: {
    helpKey: "cmd.help.help",
    run: (s, a) => [a[0] !== undefined ? commandHelpChunk(s, a[0]) : helpTextChunk(s)],
  },
  "?": {
    helpKey: "cmd.q.help",
    run: (s, a) => [a[0] !== undefined ? commandHelpChunk(s, a[0]) : helpTextChunk(s)],
  },
  lang: {
    helpKey: "cmd.lang.help",
    usage: "lang [<locale>]",
    argsDoc: [["locale", "cmd.lang.arg.locale"]],
    run: (_s, a) => {
      if (a[0] === undefined) {
        return cmdRunChunks(
          i18n("lang.current", { locale: configLocale() }),
          i18n("lang.available", { list: localeList() }),
        );
      }
      // Commands are case-insensitive, so locales are too; `kr` aliases `ko`.
      const wanted = normalizeLocale(a[0]);
      if (wanted === null)
        throw new Error(i18n("err.unknownLocale", { name: a[0], list: localeList() }));
      setConfigLocale(wanted);
      return cmdRunChunks(i18n("lang.set", { locale: configLocale() }));
    },
  },
  board: {
    helpKey: "cmd.board.help",
    run: (s) => [boardChunk(s)],
  },
  clear: { helpKey: "cmd.clear.help", run: () => cmdRunChunks("\f") },
  info: {
    helpKey: "cmd.info.help",
    usage: INFO_USAGE,
    argsDoc: [
      ["mech [query]", "cmd.info.arg.mech"],
      ["map [name]", "cmd.info.arg.map"],
      ["weapon [query]", "cmd.info.arg.weapon"],
    ],
    run: (_s, a) => {
      expectArgs(a, 1, INFO_USAGE);
      const what = a[0]!.toLowerCase();
      if (what === "mech") {
        const res = infoMechQuery(a.slice(1));
        if (res.kind === "list") return res.chunks;
        const sheet = infoMechChunk(res.model);
        return res.note === null ? sheet : [buildLinesChunk(res.note), ...sheet];
      }
      if (what === "map") {
        return a[1] !== undefined ? infoMapChunks(a[1]) : [infoMapListChunk()];
      }
      if (what === "weapon") return [infoWeaponQuery(a.slice(1))];
      throw new Error(
        i18n("err.expectedArgs", {
          usage: INFO_USAGE,
        }),
      );
    },
  },
  reset: {
    helpKey: "cmd.reset.help",
    usage: "reset [!]",
    run: (s, a) => {
      if (s.state === "battle" && a[0] !== "!") throw new Error(i18n("err.resetConfirm"));
      resetSession(s);
      return [buildLinesChunkWith("banner", i18n("ok.resetDone"))];
    },
  },
  pp: personaCmd((s, raw) => runChunks(s, raw)),
  ver: {
    helpKey: "cmd.ver.help",
    run: (_s) => cmdRunChunks(i18n("version.line", { version: VERSION })),
  },
  table: {
    helpKey: "cmd.table.help",
    usage: "table [cluster|hitloc|crit|heat]",
    argsDoc: [["name", "cmd.table.arg.name"]],
    run: (_s, a) => {
      const name = a[0]?.toLowerCase();
      if (!name) return listTables();
      switch (name) {
        case "cluster":
          return renderClusterTable();
        case "hitloc":
          return renderHitLocationTables();
        case "crit":
          return renderCriticalTable();
        case "heat":
          return renderHeatScaleTable();
        default:
          throw new Error(i18n("err.expectedArgs", { usage: "table [cluster|hitloc|crit|heat]" }));
      }
    },
  },
};

/** Undo for the movement, attack and over prompts (snapshots: `web/rollback.ts`). */
const ROLLBACK_CMD: CmdDef = {
  helpKey: "cmd.rollback.help",
  run: (s) => {
    rollbackSession(s);
    return [buildLinesChunkWith("banner", i18n("ok.rolledBack")), ...personaWaitingChunks(s)];
  },
};

// --------------------------------------------------------------- setup ----

const SETUP_CMDS: Record<string, CmdDef> = {
  map: {
    helpKey: "cmd.map.help",
    usage: "map <name>",
    argsDoc: [["name", "cmd.map.arg.name"]],
    run: (s, a) => {
      expectArgs(a, 1, "map <name>");
      const name = a[0]!;
      const m = lookupMap(name) ?? ensureMapRegistered(name);
      if (m === undefined) {
        throw new Error(i18n("err.unknownMap", { name, list: listMapNames().join(", ") }));
      }
      setupSetMap(s.setup, m);
      return cmdRunChunks(i18n("ok.mapLoaded", { name: m.name, w: m.width, h: m.height }));
    },
  },
  add: {
    helpKey: "cmd.add.help",
    usage: "add <id> <model> <col> <row> [facing]",
    argsDoc: [
      ["id", "cmd.add.arg.id"],
      ["model", "cmd.add.arg.model"],
      ["col row", "cmd.add.arg.colrow"],
      ["facing", "cmd.add.arg.facing"],
    ],
    run: (s, a) => {
      expectArgs(a, 4, "add <id> <model> <col> <row> [facing]");
      const facing = a[4] !== undefined ? resolveFacing(a[4]!) : "n";
      const col = coord(a[2]!, "col");
      const row = coord(a[3]!, "row");
      const result = setupAddUnit(
        s.setup,
        a[0]!,
        a[1]!,
        { col, row },
        facing as (typeof FACINGS)[number],
      );
      return cmdRunChunks(
        i18n("ok.added", {
          id: a[0]!,
          model: result.model,
          col,
          row,
          facing,
          team: String(result.team),
        }),
      );
    },
  },
  set: {
    helpKey: "cmd.set.help",
    usage: "set <id> <prop> <value>",
    argsDoc: [
      ["id", "cmd.set.arg.id"],
      ["prop", "cmd.set.arg.prop"],
      ["value", "cmd.set.arg.value"],
    ],
    run: (s, a) => {
      expectArgs(a, 3, "set <id> <prop> <value>");
      if (a[1]!.toLowerCase() === "id") throw new Error(i18n("err.cantSetId"));
      const prop = parseUnitProp(a[1]!);
      const { value } = setupSetUnitProp(s.setup, a[0]!, prop, a[2]!);
      return cmdRunChunks(i18n("ok.set", { id: a[0]!, prop, value }));
    },
  },
  rm: {
    helpKey: "cmd.rm.help",
    usage: "rm <id>",
    argsDoc: [["id", "cmd.rm.arg.id"]],
    run: (s, a) => {
      expectArgs(a, 1, "rm <id>");
      setupRemoveUnit(s.setup, a[0]!);
      return cmdRunChunks(i18n("ok.removed", { id: a[0]! }));
    },
  },
  status: { helpKey: "cmd.statusSetup.help", run: (s) => [setupStatus(s.setup)] },
  seed: {
    helpKey: "cmd.seed.help",
    usage: "seed <n>",
    argsDoc: [["n", "cmd.seed.arg.n"]],
    run: (s, a) => {
      expectArgs(a, 1, "seed <n>");
      setSeed(s, int(a[0]!, "seed"));
      return cmdRunChunks(i18n("ok.seedSet", { seed: s.setup.seed }));
    },
  },
  start: {
    helpKey: "cmd.start.help",
    run: (s) => {
      resetPersonaBattle(
        s.persona,
        s.setup.seed,
        s.setup.roster.map((r) => r.id),
      );
      const newEvents = setupStartBattle(s);
      return [
        buildLinesChunkWith("banner", i18n("ok.started")),
        ...handleSessionGameEvents(s, newEvents),
      ];
    },
  },
};

// ---------------------------------------------------------- turn:move ----

/** In-battle maintenance/status commands shared by both battle phases. */
const BATTLE_CMDS: Record<string, CmdDef> = {
  heat: {
    helpKey: "cmd.heat.help",
    usage: "heat [id]",
    argsDoc: [["id", "cmd.heat.arg.id"]],
    run: (s, a) => {
      const actorId = a[0];
      const actor = actorId !== undefined ? actorBy(s, actorId) : currentActor(s);
      if (actor === null) throw new Error(i18n("err.needsActor"));
      return [heatStatusLines(actor)];
    },
  },
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : [unitBriefList(s)]),
  },
};

/** Multi-line grouped usage shared by the `mode` help entry and its arg error. */
const MODE_USAGE = [
  "mode standstill | walk | run | jump",
  "mode prone [turn | pronestill] | turn | pronestill",
  "mode standup [walk | run | standstill]",
  "mode shutdown | startup | eject",
].join("\n");

const MOVE_CMDS: Record<string, CmdDef> = {
  candidate: {
    helpKey: "cmd.candidateMove.help",
    run: (s, _a) => {
      const m = s.move!;
      if (
        m.moveMode === null ||
        m.moveMode === "shutdown" ||
        m.moveMode === "startup" ||
        m.moveMode === "eject"
      ) {
        throw new Error(i18n("err.candidate.movemode"));
      }
      const chunks = [queuedMoveChunk(s)];
      const mc = ensureMoveCandidate(s);
      if (mc.revealed.length > 0) {
        chunks.push(reachableChunk(s.setup, s.battle!, mc));
      }
      return chunks;
    },
  },
  mode: {
    helpKey: "cmd.mode.help",
    usage: MODE_USAGE,
    argsDoc: [
      ["standstill", "cmd.mode.arg.standstill"],
      ["walk", "cmd.mode.arg.walk"],
      ["run", "cmd.mode.arg.run"],
      ["jump", "cmd.mode.arg.jump"],
      ["prone [turn | pronestill]", "cmd.mode.arg.prone"],
      ["turn", "cmd.mode.arg.turn"],
      ["pronestill", "cmd.mode.arg.pronestill"],
      ["standup [walk | run | standstill]", "cmd.mode.arg.standup"],
      ["shutdown", "cmd.mode.arg.shutdown"],
      ["startup", "cmd.mode.arg.startup"],
      ["eject", "cmd.mode.arg.eject"],
    ],
    run: (s, a) => {
      expectArgs(a, 1, MODE_USAGE);
      const mode = parseMoveMode(a[0]!);
      declareMovementMode(s, mode, a[1]);
      return declaredMovementModeChunk(s, mode);
    },
  },
  place: {
    helpKey: "cmd.place.help",
    usage: "place <col> <row> <facing>",
    argsDoc: [["col row facing", "cmd.place.arg.colrowfacing"]],
    run: (s, a) => {
      expectArgs(a, 3, "place <col> <row> <facing>");
      const hex = {
        col: coord(a[0]!, "col"),
        row: coord(a[1]!, "row"),
      };
      const facing = resolveFacing(a[2]!);
      const mc = ensureMoveCandidate(s);
      const landing = mc.revealed.find((l) => sameHex(l.hex, hex) && l.facing === facing);
      if (!landing) {
        const hexReachable = mc.revealed.some((l) => sameHex(l.hex, hex));
        if (!hexReachable) {
          throw new Error(i18n("err.place.unreachable", { col: hex.col, row: hex.row }));
        }
        const rfacing = mc.revealed
          .filter((l) => sameHex(l.hex, hex))
          .map((l) => l.facing)
          .join("|");
        throw new Error(i18n("err.place.facing", { col: hex.col, row: hex.row, facing, rfacing }));
      }
      placeLanding(s, landing);
      return [stepResultChunk(s, landing)];
    },
  },
  status: { helpKey: "cmd.statusMove.help", run: (s) => [moveStatusChunk(s)] },
  cancel: {
    helpKey: "cmd.cancelMove.help",
    run: (s) => {
      cancelMovement(s);
      return cmdRunChunks(i18n("ok.cancelled"));
    },
  },
  rollback: ROLLBACK_CMD,
  done: {
    helpKey: "cmd.doneMove.help",
    run: (s) => {
      // A walk/run that enters no hex still costs movement heat: say so, so a
      // failed `place` scrolled out of view does not go unnoticed.
      const m = s.move;
      const idle =
        m !== null &&
        (m.moveMode === "walk" || m.moveMode === "run") &&
        m.moveSteps.length === 0 &&
        m.moveFinalFacing === null;
      const events = handleSessionGameEvents(s, commitMovement(s));
      return idle ? [buildLinesChunkWith("hint", i18n("warn.idleMove")), ...events] : events;
    },
  },
  ...BATTLE_CMDS,
};

// -------------------------------------------------------- turn:attack ----

const ATTACK_CMDS: Record<string, CmdDef> = {
  torso: {
    helpKey: "cmd.torso.help",
    usage: "torso <front|left|right>",
    argsDoc: [["direction", "cmd.torso.arg.direction"]],
    run: (s, a) => {
      expectArgs(a, 1, "torso <front|left|right>");
      const actor = currentActor(s);
      if (!actor) throw new Error(i18n("err.needsActor"));
      const dir = parseTorsoTwist(a[0]!);
      const prev = setTorsoTwist(s, dir);
      return prev === dir
        ? cmdRunChunks(i18n("ok.twistAlready", { id: actor.id, dir: twistLabel(dir) }))
        : [
            buildLinesChunk(i18n("ok.twistSet", { id: actor.id, dir: twistLabel(dir) })),
            ...fireSuggestionChunks(s),
          ];
    },
  },
  candidate: {
    helpKey: "cmd.candidateAttack.help",
    run: (s, _a) => fireSuggestionChunks(s),
  },
  fire: {
    helpKey: "cmd.fire.help",
    usage: "fire <targetId> <weapon> [<weapon> ...]",
    argsDoc: [
      ["targetId", "cmd.fire.arg.targetId"],
      ["weapon", "cmd.fire.arg.weaponIndex"],
    ],
    run: (s, a) => {
      expectArgs(a, 2, "fire <targetId> <weapon> [<weapon> ...]");
      const targetId = a[0]!;
      const weapons = a.slice(1).map((w) => int(w, "weapon"));
      const warnings = queueWeaponAttacks(s, targetId, weapons);
      return cmdRunChunks(
        i18n("ok.fireQueuedBatch", { target: targetId, weapons: weapons.join(", ") }),
        ...warnings,
      );
    },
  },
  punch: {
    helpKey: "cmd.punch.help",
    usage: "punch <targetId> [left|right]",
    argsDoc: [
      ["targetId", "cmd.punch.arg.targetId"],
      ["limb", "cmd.punch.arg.limb"],
    ],
    run: (s, a) => {
      expectArgs(a, 1, "punch <targetId> [left|right]");
      const targetId = a[0]!;
      const limb = parseArm(a[1]);
      const warnings = queuePhysicalAttack(s, "punch", targetId, limb);
      return cmdRunChunks(
        i18n("ok.physical.queued", { type: "punch", target: targetId }),
        ...warnings,
      );
    },
  },
  kick: {
    helpKey: "cmd.kick.help",
    usage: "kick <targetId> [left|right]",
    argsDoc: [
      ["targetId", "cmd.kick.arg.targetId"],
      ["limb", "cmd.kick.arg.limb"],
    ],
    run: (s, a) => {
      expectArgs(a, 1, "kick <targetId> [left|right]");
      const targetId = a[0]!;
      const limb = parseLeg(a[1]);
      const warnings = queuePhysicalAttack(s, "kick", targetId, limb);
      return cmdRunChunks(
        i18n("ok.physical.queued", { type: "kick", target: targetId }),
        ...warnings,
      );
    },
  },
  club: {
    helpKey: "cmd.club.help",
    usage: "club <targetId>",
    argsDoc: [["targetId", "cmd.club.arg.targetId"]],
    run: (s, a) => {
      expectArgs(a, 1, "club <targetId>");
      const targetId = a[0]!;
      const warnings = queuePhysicalAttack(s, "club", targetId);
      return cmdRunChunks(
        i18n("ok.physical.queued", { type: "club", target: targetId }),
        ...warnings,
      );
    },
  },
  strike: {
    helpKey: "cmd.strike.help",
    usage: "strike <targetId> [left|right]",
    argsDoc: [
      ["targetId", "cmd.strike.arg.targetId"],
      ["limb", "cmd.strike.arg.limb"],
    ],
    run: (s, a) => {
      expectArgs(a, 1, "strike <targetId> [left|right]");
      const targetId = a[0]!;
      const limb = parseArm(a[1]);
      const warnings = queuePhysicalAttack(s, "strike", targetId, limb);
      return cmdRunChunks(
        i18n("ok.physical.queued", { type: "strike", target: targetId }),
        ...warnings,
      );
    },
  },
  pickup: {
    helpKey: "cmd.pickup.help",
    usage: ["pickup [limb | tree | girder] [n]", "pickup <n>"].join("\n"),
    argsDoc: [["source", "cmd.pickup.arg.source"]],
    run: (s, a) => {
      // A lone number picks among several clubs lying in the hex (`pickup 2`).
      const loneNumber = a[0] !== undefined && /^\d/.test(a[0]);
      const source = loneNumber ? undefined : (a[0]?.toLowerCase() as ClubKind | undefined);
      if (source !== undefined && !["limb", "tree", "girder"].includes(source)) {
        throw new Error(i18n("err.pickup.badSource", { source }));
      }
      const numberArg = loneNumber ? a[0] : a[1];
      let n: number | undefined;
      if (numberArg !== undefined) {
        n = int(numberArg, "n");
        if (n < 1) throw new Error(i18n("err.oneBased", { label: "n" }));
      }
      return cmdRunChunks(...queuePickup(s, source, n));
    },
  },
  drop: {
    helpKey: "cmd.drop.help",
    run: (s) => {
      return cmdRunChunks(...queueDrop(s));
    },
  },
  status: { helpKey: "cmd.statusAttack.help", run: (s) => [attackStatusChunk(s)] },
  cancel: {
    helpKey: "cmd.cancelFire.help",
    run: (s) => {
      cancelAttack(s);
      return cmdRunChunks(i18n("ok.cancelled"));
    },
  },
  rollback: ROLLBACK_CMD,
  done: {
    helpKey: "cmd.doneFire.help",
    run: (s) => handleSessionGameEvents(s, commitAttack(s)),
  },
  ...BATTLE_CMDS,
};

// ----------------------------------------------------------------- over ----

const OVER_CMDS: Record<string, CmdDef> = {
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : [unitBriefList(s)]),
  },
  status: {
    helpKey: "cmd.statusOver.help",
    run: (s) => [victoryBannerChunk(s), overStatusChunk(s)],
  },
  rollback: ROLLBACK_CMD,
  rematch: {
    helpKey: "cmd.rematch.help",
    run: (s) => {
      clearSnapshots(s);
      resetPersonaBattle(
        s.persona,
        s.setup.seed,
        s.setup.roster.map((r) => r.id),
      );
      const newEvents = overRematch(s);
      return [
        buildLinesChunkWith("banner", i18n("ok.rematchDone")),
        ...handleSessionGameEvents(s, newEvents),
      ];
    },
  },
};

// ------------------------------------------------------------ helpers ----

function parseArm(word: string | undefined): ArmLocation | undefined {
  if (word === undefined) return undefined;
  const w = word.toLowerCase();
  if (w === "left" || w === "l") return "leftArm";
  if (w === "right" || w === "r") return "rightArm";
  throw new Error(i18n("err.badLimb", { limb: word }));
}

function parseLeg(word: string | undefined): LegLocation | undefined {
  if (word === undefined) return undefined;
  const w = word.toLowerCase();
  if (w === "left" || w === "l") return "leftLeg";
  if (w === "right" || w === "r") return "rightLeg";
  throw new Error(i18n("err.badLimb", { limb: word }));
}

// ------------------------------------------------------------ dispatch ----

function availableCmds(session: Session): Record<string, CmdDef> {
  switch (session.state) {
    case "setup":
      return { ...GLOBAL_CMDS, ...SETUP_CMDS };
    case "battle": {
      const phase = session.battle?.phase;
      if (phase === "attack") return { ...GLOBAL_CMDS, ...ATTACK_CMDS };
      if (phase !== "movement") return { ...GLOBAL_CMDS, ...MOVE_CMDS };
      return { ...GLOBAL_CMDS, ...MOVE_CMDS };
    }
    case "over":
      return { ...GLOBAL_CMDS, ...OVER_CMDS };
  }
}

/** Own-property command lookup (`constructor` and friends are not commands). */
function findCmd(table: Record<string, CmdDef>, name: string): CmdDef | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Every phase's commands merged, for "wrong phase" detection and help. */
function allCmds(): Record<string, CmdDef> {
  return { ...OVER_CMDS, ...ATTACK_CMDS, ...MOVE_CMDS, ...SETUP_CMDS, ...GLOBAL_CMDS };
}

/** Split a (possibly multi-line) usage into display lines; continuations align under `usage: `. */
function usageLines(usage: string): string[] {
  const [first = "", ...rest] = usage.split("\n");
  const prefix = i18n("help.usagePrefix");
  const indent = " ".repeat(prefix.length);
  return [
    `${prefix}${first}`,
    ...rest.map((line) => (line.length > 0 ? `${indent}${line}` : line)),
  ];
}

/** Detailed single-command help: usage + argument explanations, no state hint. */
function commandHelpChunk(session: Session, name: string): Chunk {
  // Help reads every phase's table, so a command can be studied before its phase.
  const def = findCmd(availableCmds(session), name) ?? findCmd(allCmds(), name);
  if (!def) throw new Error(i18n("err.unknownCommand", { name }));
  const names = listMapNames().join("|");
  const lines = def.usage !== undefined ? usageLines(def.usage) : [name.toLowerCase()];
  lines.push(i18n(def.helpKey).replace(/\{names\}/g, names));
  if (def.argsDoc !== undefined && def.argsDoc.length > 0) {
    lines.push(i18n("help.argumentsHeader"));
    const padLen = Math.max(
      12,
      def.argsDoc.map(([arg, _]) => arg.length).reduce((prev, curr) => Math.max(prev, curr)),
    );

    for (const [arg, desc] of def.argsDoc) {
      const text = i18n(desc).replace(/\{names\}/g, names);
      const [first = "", ...rest] = text.split("\n");
      const prefix = `  ${arg.padEnd(padLen)} `;
      lines.push(`${prefix}${first}`);
      const indent = " ".repeat(prefix.length);
      for (const line of rest) lines.push(`${indent}${line}`);
    }
  }
  return buildLinesChunk(...lines);
}

function commandList(session: Session): string[] {
  const names = listMapNames().join("|");
  const globalEntries = Object.keys(GLOBAL_CMDS)
    .sort()
    .map((name) => ({ name, def: GLOBAL_CMDS[name]! }));
  const phaseCmds = (() => {
    switch (session.state) {
      case "setup":
        return { cmds: SETUP_CMDS, phase: "setup" as const };
      case "battle": {
        const phase = session.battle?.phase === "attack" ? "attack" : "movement";
        return { cmds: phase === "attack" ? ATTACK_CMDS : MOVE_CMDS, phase };
      }
      case "over":
        return { cmds: OVER_CMDS, phase: "over" as const };
    }
  })();
  const phaseEntries = Object.keys(phaseCmds.cmds)
    .sort()
    .map((name) => ({ name, def: phaseCmds.cmds[name]! }));
  const lines: string[] = [];
  const renderEntries = (entries: { name: string; def: CmdDef }[]) => {
    const indent = " ".repeat(10);
    for (const { name, def } of entries) {
      const help = i18n(def.helpKey).replace(/\{names\}/g, names);
      const [first = "", ...rest] = help.split("\n");
      if (def.usage === undefined) {
        lines.push(`${name.padEnd(9)} ${first}`);
      } else {
        const [uFirst = "", ...uRest] = def.usage.split("\n");
        lines.push(`${name.padEnd(9)} ${uFirst}`);
        for (const line of uRest) lines.push(line.length > 0 ? `${indent}${line}` : line);
        lines.push(`${indent}${first}`);
      }
      for (const line of rest) lines.push(line.length > 0 ? `${indent}${line}` : line);
    }
  };
  lines.push(i18n("help.sectionGeneral"));
  renderEntries(globalEntries);
  lines.push("");
  lines.push(i18n("help.sectionPhase", { phase: phaseCmds.phase }));
  renderEntries(phaseEntries);
  return lines;
}

// ---------------------------------------------------------------- hints ----

/** Per-state guidance shown at the top of `help`, focused on legal commands. */
const HINT_SETUP: MessageKey = "hint.setup";
const HINT_MOVE: MessageKey = "hint.move";
const HINT_ATTACK: MessageKey = "hint.attack";
const HINT_OVER: MessageKey = "hint.over";

/** Per-state guidance, focused on the commands legal right now. */
function stateHint(s: Session): string[] {
  const key =
    s.state === "battle"
      ? s.battle?.phase === "attack"
        ? HINT_ATTACK
        : HINT_MOVE
      : s.state === "over"
        ? HINT_OVER
        : HINT_SETUP;
  return i18n(key).split("\n");
}
function helpTextChunk(session: Session): Chunk {
  return buildLinesChunk(...stateHint(session), "", ...commandList(session));
}

/**
 * Run one input line against the session; returns presentation chunks
 * (plain text with a class hint, or styled board spans).
 */
export function runChunks(session: Session, raw: string): Chunk[] {
  let chunks: Chunk[];
  try {
    const tokens = raw
      .trim()
      .split(/\s+/)
      .filter((x) => x.length > 0);
    if (tokens.length === 0) return [];
    const name = tokens[0]!;
    const def = findCmd(availableCmds(session), name);
    if (!def) {
      if (findCmd(allCmds(), name) !== undefined) {
        throw new Error(i18n("err.notInPhase", { name }));
      }
      throw new Error(i18n("err.unknownCommand", { name }));
    }
    chunks = def.run(session, tokens.slice(1));
    recordPromptSnapshot(session);
    if (drivesAfter(name)) {
      chunks = [...chunks, ...drivePersona(session, (line) => runChunks(session, line))];
    }
  } catch (e) {
    return [
      buildLinesChunkWith(
        "err",
        `${i18n("err.prefix")} ${e instanceof Error ? e.message : String(e)}`,
      ),
    ];
  }
  return chunks;
}
