import type { Facing, UnitState } from "btlib10x";
import { FACINGS, isShutdown, listMapNames, requireUnit, sameHex, VERSION } from "btlib10x";
import type { ArmLocation, LegLocation } from "../src/core/types";
import { buildLinesChunk, buildLinesChunkWith, type Chunk } from "./chunk";
import type { MessageKey } from "./i18n/index";
import { i18n, isLocale, localeList } from "./i18n/index";
import { lookupMap } from "./lookup";
import type { Session } from "./session";
import {
  ammoPolicyLabel,
  attackStatusChunk,
  boardChunk,
  cancelMovement,
  cancelWeaponFire,
  commitMovement,
  commitWeaponFire,
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
  queuedMoveChunk,
  queuePhysicalAttack,
  queueWeaponFires,
  reachableChunk,
  requireBattle,
  resetSession,
  setAmmoPolicy,
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
  unitBriefList,
} from "./session";
import {
  infoMapChunks,
  infoMapListChunk,
  infoMechListChunk,
  infoWeaponChunk,
  infoWeaponListChunk,
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
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(i18n("err.notInteger", { label }));
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
      case "weaponAttack":
        if (s.attack !== null) return requireUnit(s.battle, s.attack.actorId);
        break;
    }
  }
  return null;
}

function actorBy(s: Session, id: string): UnitState | null {
  return requireBattle(s).units[id] ?? null;
}

/** Resolve a `place` facing argument: an absolute facing word. */
export function resolveFacing(arg: string): Facing {
  const facing = FACINGS.find((f) => f === arg.toLowerCase());
  if (!facing) throw new Error(i18n("err.faceArg", { facings: FACINGS.join("/") }));
  return facing;
}

function cmdRunChunks(...lines: string[]): Chunk[] {
  return [buildLinesChunk(...lines)];
}

// ------------------------------------------------------------- globals ----
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
      if (!isLocale(a[0]))
        throw new Error(i18n("err.unknownLocale", { name: a[0], list: localeList() }));
      setConfigLocale(a[0]);
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
    usage: "info mech [model] | info map [name] | info weapon [name]",
    argsDoc: [
      ["mech [model]", "cmd.info.arg.mech"],
      ["map [name]", "cmd.info.arg.map"],
      ["weapon [name]", "cmd.info.arg.weapon"],
    ],
    run: (_s, a) => {
      expectArgs(a, 1, "info mech [model] | info map [name] | info weapon [name]");
      const what = a[0]!.toLowerCase();
      if (what === "mech") return a[1] !== undefined ? infoMechChunk(a[1]) : [infoMechListChunk()];
      if (what === "map") {
        return a[1] !== undefined ? infoMapChunks(a[1]) : [infoMapListChunk()];
      }
      if (what === "weapon") {
        const name = a.slice(1).join(" ");
        return [name ? infoWeaponChunk(name) : infoWeaponListChunk()];
      }
      throw new Error(
        i18n("err.expectedArgs", {
          usage: "info mech [model] | info map [name] | info weapon [name]",
        }),
      );
    },
  },
  reset: {
    helpKey: "cmd.reset.help",
    run: (s) => {
      resetSession(s);
      return [buildLinesChunkWith("banner", i18n("ok.resetDone"))];
    },
  },
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
          throw new Error(i18n("err.unknownCommand", { name }));
      }
    },
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
      const m = lookupMap(name);
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
      const result = setupAddUnit(
        s.setup,
        a[0]!,
        a[1]!,
        { col: coord(a[2]!, "col"), row: coord(a[3]!, "row") },
        facing as (typeof FACINGS)[number],
      );
      return cmdRunChunks(
        i18n("ok.added", {
          id: a[0]!,
          model: result.model,
          col: a[2]!,
          row: a[3]!,
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
    usage:
      "mode <standstill|walk|run|jump|prone [turn|pronestill]|turn|pronestill|standup [walk|run|jump|standstill]|shutdown|startup|eject>",
    argsDoc: [
      ["standstill", "cmd.mode.arg.standstill"],
      ["walk", "cmd.mode.arg.walk"],
      ["run", "cmd.mode.arg.run"],
      ["jump", "cmd.mode.arg.jump"],
      ["prone [turn|pronestill]", "cmd.mode.arg.prone"],
      ["turn", "cmd.mode.arg.turn"],
      ["pronestill", "cmd.mode.arg.pronestill"],
      ["standup [mode]", "cmd.mode.arg.standup"],
      ["shutdown", "cmd.mode.arg.shutdown"],
      ["startup", "cmd.mode.arg.startup"],
      ["eject", "cmd.mode.arg.eject"],
    ],
    run: (s, a) => {
      expectArgs(
        a,
        1,
        "mode standstill|walk|run|jump|prone [turn|pronestill]|turn|pronestill|standup [walk|run|jump|standstill]|shutdown|startup|eject",
      );
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
        throw new Error(i18n("err.place.facing", { col: hex.col, row: hex.row, facing }));
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
  done: {
    helpKey: "cmd.doneMove.help",
    run: (s) => handleSessionGameEvents(s, commitMovement(s)),
  },
  ...BATTLE_CMDS,
};

// -------------------------------------------------------- turn:attack ----

const ATTACK_CMDS: Record<string, CmdDef> = {
  ammo: {
    helpKey: "cmd.ammo.help",
    usage: "ammo [policy]",
    argsDoc: [["policy", "cmd.ammo.arg.policy"]],
    run: (s, a) => {
      const unit = currentActor(s);
      if (!unit) throw new Error(i18n("err.needsActor"));
      if (a[0] === undefined) {
        return cmdRunChunks(i18n("ammo.current", { policy: ammoPolicyLabel(unit.ammoPolicy) }));
      }
      setAmmoPolicy(s, a[0]);
      return cmdRunChunks(
        i18n("ammo.set", { id: unit.id, policy: ammoPolicyLabel(unit.ammoPolicy) }),
      );
    },
  },
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
        ? cmdRunChunks(i18n("ok.twistAlready", { id: actor.id, dir }))
        : [buildLinesChunk(i18n("ok.twistSet", { id: actor.id, dir })), ...fireSuggestionChunks(s)];
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
      const warnings = queueWeaponFires(s, targetId, weapons);
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
  push: {
    helpKey: "cmd.push.help",
    usage: "push <targetId>",
    argsDoc: [["targetId", "cmd.push.arg.targetId"]],
    run: (s, a) => {
      expectArgs(a, 1, "push <targetId>");
      const targetId = a[0]!;
      const warnings = queuePhysicalAttack(s, "push", targetId);
      return cmdRunChunks(
        i18n("ok.physical.queued", { type: "push", target: targetId }),
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
  status: { helpKey: "cmd.statusAttack.help", run: (s) => [attackStatusChunk(s)] },
  cancel: {
    helpKey: "cmd.cancelFire.help",
    run: (s) => {
      cancelWeaponFire(s);
      return cmdRunChunks(i18n("ok.cancelled"));
    },
  },
  done: {
    helpKey: "cmd.doneFire.help",
    run: (s) => handleSessionGameEvents(s, commitWeaponFire(s)),
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
  status: { helpKey: "cmd.statusOver.help", run: (s) => [overStatusChunk(s)] },
  rematch: {
    helpKey: "cmd.rematch.help",
    run: (s) => {
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
      if (phase === "weaponAttack") return { ...GLOBAL_CMDS, ...ATTACK_CMDS };
      if (phase !== "movement") return { ...GLOBAL_CMDS, ...MOVE_CMDS };
      const actor = currentActor(session);
      const down = actor !== null && isShutdown(actor);
      const declared = session.move?.moveMode ?? null;
      if (down || declared === "shutdown" || declared === "startup" || declared === "prone") {
        // Pending voluntary declaration: no hex movement.
        const { move: _move, face: _face, ...rest } = MOVE_CMDS;
        return { ...GLOBAL_CMDS, ...rest };
      }
      return { ...GLOBAL_CMDS, ...MOVE_CMDS };
    }
    case "over":
      return { ...GLOBAL_CMDS, ...OVER_CMDS };
  }
}

/** Detailed single-command help: usage + argument explanations, no state hint. */
function commandHelpChunk(session: Session, name: string): Chunk {
  const def = availableCmds(session)[name.toLowerCase()];
  if (!def) throw new Error(i18n("err.unknownCommand", { name }));
  const names = listMapNames().join("|");
  const lines = [
    def.usage !== undefined ? `${i18n("help.usagePrefix")}${def.usage}` : name.toLowerCase(),
  ];
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
        const phase = session.battle?.phase === "weaponAttack" ? "weaponAttack" : "movement";
        return { cmds: phase === "weaponAttack" ? ATTACK_CMDS : MOVE_CMDS, phase };
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
    for (const { name, def } of entries) {
      const help = i18n(def.helpKey).replace(/\{names\}/g, names);
      if (def.usage === undefined) {
        lines.push(`${name.padEnd(9)} ${help}`);
      } else {
        lines.push(`${name.padEnd(9)} ${def.usage}`);
        lines.push(`          ${help}`);
      }
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
      ? s.battle?.phase === "weaponAttack"
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
    const def = availableCmds(session)[tokens[0]!.toLowerCase()];
    if (!def) throw new Error(i18n("err.unknownCommand", { name: tokens[0]! }));
    chunks = def.run(session, tokens.slice(1));
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
