import type { Arc } from "btlib10x";
import {
  type FACINGS,
  getMechDefFor,
  getWeaponDefFor,
  hexDistance,
  isShutdown,
  listMapNames,
  sameHex,
  suggestFireTargets,
  VERSION,
} from "btlib10x";
import type { Chunk } from "./format.js";
import {
  ammoPolicyLabel,
  attackStatusLines,
  boardChunk,
  buildLinesChunk,
  F,
  fireSuggestionChunks,
  fmtSetupStatus,
  formatLog,
  heatStatusLines,
  infoMapChunks,
  infoMapList,
  infoMechChunk,
  infoMechList,
  infoWeapon,
  infoWeaponList,
  listTables,
  moveStatusLines,
  overStatusLines,
  PRN,
  queuedMoveLines,
  reachableChunk,
  reachablesInfo,
  renderClusterTable,
  renderCriticalTable,
  renderHeatScaleTable,
  renderHitLocationTables,
  sheetForUnit,
  stepResultFromLine,
  stepResultLines,
  unitBriefList,
} from "./format.js";
import type { LocaleId, MessageKey } from "./i18n/index.js";
import { i18n, isLocale, localeList } from "./i18n/index.js";
import { lookupMap } from "./lookup.js";
import type { Session } from "./session.js";
import {
  addUnit,
  budgetFor,
  cancelFire,
  cancelMove,
  commitFire,
  commitMove,
  currentActor,
  declareMode,
  displayModeFor,
  parseMoveMode,
  parseUnitProp,
  placeLanding,
  queueFire,
  rematch,
  removeUnit,
  resetSession,
  resolveFacing,
  setAmmoPolicy,
  setMap,
  setSeed,
  setTorsoTwist,
  setUnitProp,
  startBattle,
} from "./session.js";

export interface CmdDef {
  /** Catalog key of the one-line description. */
  readonly helpKey: MessageKey;
  /** Full invocation form including arguments (locale-neutral syntax). */
  readonly usage?: string;
  /** Per-argument documentation shown by `help <command>` ([pattern, catalog key]). */
  readonly argsDoc?: ReadonlyArray<readonly [string, MessageKey]>;
  /** Plain lines, or an array of {@link Chunk}s for structured output. */
  run: (session: Session, args: string[]) => string[] | Chunk[];
}

// ------------------------------------------------------------- parsing ----

function int(locale: LocaleId, value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(i18n(locale, "err.notInteger", { label }));
  return n;
}

/** User-facing 1-based coordinate -> engine coordinate. */
function coord(locale: LocaleId, value: string, label: string): number {
  const n = int(locale, value, label);
  if (n < 1) throw new Error(i18n(locale, "err.oneBased", { label }));
  return n;
}

function expectArgs(locale: LocaleId, args: readonly string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(i18n(locale, "err.expectedArgs", { usage }));
}

/** Command id argument: explicit unit id, else the acting unit when present. */
function idOrActor(s: Session, args: readonly string[]): string {
  if (args[0] !== undefined) return args[0];
  const actor = currentActor(s);
  if (actor !== null) return actor.id;
  throw new Error(i18n(s.locale, "err.needsActor"));
}

const L = (s: Session): LocaleId => s.locale;

// ------------------------------------------------------------- globals ----

const GLOBAL_CMDS: Record<string, CmdDef> = {
  help: {
    helpKey: "cmd.help.help",
    run: (s, a) => (a[0] !== undefined ? commandHelp(s, a[0]) : helpText(s)),
  },
  "?": {
    helpKey: "cmd.q.help",
    run: (s, a) => (a[0] !== undefined ? commandHelp(s, a[0]) : helpText(s)),
  },
  lang: {
    helpKey: "cmd.lang.help",
    usage: "lang [<locale>]",
    argsDoc: [["locale", "cmd.lang.arg.locale"]],
    run: (s, a) => {
      if (a[0] === undefined) {
        return [
          i18n(L(s), "lang.current", { locale: s.locale }),
          i18n(L(s), "lang.available", { list: localeList() }),
        ];
      }
      if (!isLocale(a[0]))
        throw new Error(i18n(L(s), "err.unknownLocale", { name: a[0], list: localeList() }));
      s.locale = a[0];
      return [i18n(s.locale, "lang.set", { locale: s.locale })];
    },
  },
  board: {
    helpKey: "cmd.board.help",
    run: (s) => [boardChunk(s)],
  },
  clear: { helpKey: "cmd.clear.help", run: () => ["\f"] },
  info: {
    helpKey: "cmd.info.help",
    usage: "info mech [model] | info map [name] | info weapon [name]",
    argsDoc: [
      ["mech [model]", "cmd.info.arg.mech"],
      ["map [name]", "cmd.info.arg.map"],
      ["weapon [name]", "cmd.info.arg.weapon"],
    ],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "info mech [model] | info map [name] | info weapon [name]");
      const what = a[0]!.toLowerCase();
      if (what === "mech")
        return a[1] !== undefined ? infoMechChunk(L(s), a[1]) : [infoMechList(L(s))];
      if (what === "map") {
        return a[1] !== undefined ? infoMapChunks(L(s), a[1]) : infoMapList();
      }
      if (what === "weapon") {
        const name = a.slice(1).join(" ");
        return name ? infoWeapon(L(s), name) : infoWeaponList(L(s));
      }
      throw new Error(
        i18n(L(s), "err.expectedArgs", {
          usage: "info mech [model] | info map [name] | info weapon [name]",
        }),
      );
    },
  },
  reset: {
    helpKey: "cmd.reset.help",
    run: (s) => {
      resetSession(s);
      return [buildLinesChunk([i18n(s.locale, "ok.resetDone")], "banner")];
    },
  },
  ver: {
    helpKey: "cmd.ver.help",
    run: (s) => [i18n(L(s), "version.line", { version: VERSION })],
  },
  table: {
    helpKey: "cmd.table.help",
    usage: "table [cluster|hitloc|crit|heat]",
    argsDoc: [["name", "cmd.table.arg.name"]],
    run: (s, a) => {
      const name = a[0]?.toLowerCase();
      const locale = L(s);
      if (!name) return listTables(locale);
      switch (name) {
        case "cluster":
          return renderClusterTable(locale);
        case "hitloc":
          return renderHitLocationTables(locale);
        case "crit":
          return renderCriticalTable(locale);
        case "heat":
          return renderHeatScaleTable(locale);
        default:
          throw new Error(i18n(locale, "err.unknownCommand", { name }));
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
      expectArgs(L(s), a, 1, "map <name>");
      const name = a[0]!;
      const m = lookupMap(name);
      if (m === undefined) {
        throw new Error(
          i18n(s.locale, "err.unknownMap", { name, list: listMapNames().join(", ") }),
        );
      }
      setMap(s, m);
      return [i18n(L(s), "ok.mapLoaded", { name: m.name, w: m.width, h: m.height })];
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
      expectArgs(L(s), a, 4, "add <id> <model> <col> <row> [facing]");
      const facing = a[4] !== undefined ? resolveFacing(L(s), a[4]!) : "n";
      const result = addUnit(
        s,
        a[0]!,
        a[1]!,
        { col: coord(L(s), a[2]!, "col"), row: coord(L(s), a[3]!, "row") },
        facing as (typeof FACINGS)[number],
      );
      return [
        i18n(L(s), "ok.added", {
          id: a[0]!,
          model: result.model,
          col: a[2]!,
          row: a[3]!,
          facing,
          team: String(result.team),
        }),
      ];
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
      expectArgs(L(s), a, 3, "set <id> <prop> <value>");
      if (a[1]!.toLowerCase() === "id") throw new Error(i18n(L(s), "err.cantSetId"));
      const prop = parseUnitProp(L(s), a[1]!);
      const { value } = setUnitProp(s, a[0]!, prop, a[2]!);
      return [i18n(L(s), "ok.set", { id: a[0]!, prop, value })];
    },
  },
  rm: {
    helpKey: "cmd.rm.help",
    usage: "rm <id>",
    argsDoc: [["id", "cmd.rm.arg.id"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "rm <id>");
      removeUnit(s, a[0]!);
      return [i18n(L(s), "ok.removed", { id: a[0]! })];
    },
  },
  status: { helpKey: "cmd.statusSetup.help", run: (s) => fmtSetupStatus(s) },
  seed: {
    helpKey: "cmd.seed.help",
    usage: "seed <n>",
    argsDoc: [["n", "cmd.seed.arg.n"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "seed <n>");
      setSeed(s, int(L(s), a[0]!, "seed"));
      return [i18n(L(s), "ok.seedSet", { seed: s.setup.seed })];
    },
  },
  start: {
    helpKey: "cmd.start.help",
    run: (s) => {
      const newEvents = startBattle(s);
      return [
        buildLinesChunk([i18n(s.locale, "ok.started")], "banner"),
        buildLinesChunk(formatLog(s.locale, newEvents)),
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
    run: (s, a) => heatStatusLines(s, idOrActor(s, a)),
  },
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : unitBriefList(s)),
  },
};

const MOVE_CMDS: Record<string, CmdDef> = {
  candidate: {
    helpKey: "cmd.candidateMove.help",
    run: (s, _a) => {
      const m = s.move;
      if (
        !m ||
        m.moveMode === null ||
        m.moveMode === "shutdown" ||
        m.moveMode === "startup" ||
        m.moveMode === "eject"
      ) {
        throw new Error(i18n(L(s), "err.candidate.movemode"));
      }
      const lines = queuedMoveLines(s);
      if (m.moveCandidate === null) {
        m.moveCandidate = reachablesInfo(s) ?? null;
      }
      if (m.moveCandidate === null) return lines;
      return [
        buildLinesChunk(lines),
        reachableChunk(s.locale, s.setup, s.battle!, m.moveCandidate),
      ];
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
      const locale = L(s);
      expectArgs(
        locale,
        a,
        1,
        "mode standstill|walk|run|jump|prone [turn|pronestill]|turn|pronestill|standup [walk|run|jump|standstill]|shutdown|startup|eject",
      );
      const mode = parseMoveMode(locale, a[0]!);
      declareMode(s, a[0]!, a[1]);
      const actor = currentActor(s)!;
      const m = s.move!;
      if (mode === "shutdown" || mode === "startup" || mode === "eject") {
        m.moveCandidate = null;
        return [
          i18n(locale, "ok.modeDeclaredVoluntary", { id: actor.id, mode }),
          i18n(locale, "stepResult.from", {
            col: actor.position.col,
            row: actor.position.row,
            facing: F(locale, actor.facing),
            posture: PRN(locale, actor.prone),
          }),
        ];
      }
      const shown = displayModeFor(s);
      const lines = [
        i18n(locale, "ok.modeDeclared", { id: actor.id, mode: shown, budget: budgetFor(s) }),
        stepResultFromLine(locale, s),
      ];
      if (mode === "standStill" || mode === "pronestill") {
        m.moveCandidate = null;
        return lines;
      }
      m.moveCandidate = reachablesInfo(s) ?? null;
      if (m.moveCandidate === null) return lines;
      return [
        buildLinesChunk(lines),
        reachableChunk(s.locale, s.setup, s.battle!, m.moveCandidate),
      ];
    },
  },
  place: {
    helpKey: "cmd.place.help",
    usage: "place <col> <row> <facing>",
    argsDoc: [["col row facing", "cmd.place.arg.colrowfacing"]],
    run: (s, a) => {
      expectArgs(L(s), a, 3, "place <col> <row> <facing>");
      const hex = {
        col: coord(L(s), a[0]!, "col"),
        row: coord(L(s), a[1]!, "row"),
      };
      const facing = resolveFacing(L(s), a[2]!);
      const candidate = s.move?.moveCandidate ?? null;
      if (candidate === null) {
        throw new Error(i18n(L(s), "err.place.noCandidate"));
      }
      const landing = candidate.revealed.find((l) => sameHex(l.hex, hex) && l.facing === facing);
      if (!landing) {
        const hexReachable = candidate.revealed.some((l) => sameHex(l.hex, hex));
        if (!hexReachable) {
          throw new Error(i18n(L(s), "err.place.unreachable", { col: hex.col, row: hex.row }));
        }
        throw new Error(i18n(L(s), "err.place.facing", { col: hex.col, row: hex.row, facing }));
      }
      placeLanding(s, landing);
      return stepResultLines(s, landing);
    },
  },
  status: { helpKey: "cmd.statusMove.help", run: (s) => moveStatusLines(s) },
  cancel: {
    helpKey: "cmd.cancelMove.help",
    run: (s) => {
      cancelMove(s);
      return [i18n(s.locale, "ok.cancelled")];
    },
  },
  done: {
    helpKey: "cmd.doneMove.help",
    run: (s) => formatLog(s.locale, commitMove(s).events),
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
      if (!unit) throw new Error(i18n(L(s), "err.needsActor"));
      if (a[0] === undefined) {
        return [i18n(L(s), "ammo.current", { policy: ammoPolicyLabel(L(s), unit.ammoPolicy) })];
      }
      setAmmoPolicy(s, a[0]);
      return [
        i18n(L(s), "ammo.set", { id: unit.id, policy: ammoPolicyLabel(L(s), unit.ammoPolicy) }),
      ];
    },
  },
  torso: {
    helpKey: "cmd.torso.help",
    usage: "torso <front|left|right>",
    argsDoc: [["direction", "cmd.torso.arg.direction"]],
    run: (s, a) => {
      expectArgs(L(s), a, 1, "torso <front|left|right>");
      const actor = currentActor(s);
      if (!actor) throw new Error(i18n(L(s), "err.needsActor"));
      const prev = s.attack?.torsoTwist ?? "front";
      setTorsoTwist(s, a[0]!);
      const dir: Arc = s.attack!.torsoTwist;
      if (prev === dir) {
        return [i18n(L(s), "ok.twistAlready", { id: actor.id, dir })];
      }
      return [i18n(L(s), "ok.twistSet", { id: actor.id, dir })];
    },
  },
  candidate: {
    helpKey: "cmd.candidateAttack.help",
    run: (s, _a) => {
      if (!checkFireHint(s)) throw new Error(i18n(L(s), "err.candidate.attack"));
      const a = s.attack!;
      return fireSuggestionChunks(s.locale, a.fireCandidate!, a.torsoTwist);
    },
  },
  fire: {
    helpKey: "cmd.fire.help",
    usage: "fire <targetId> <weapon> [<weapon> ...]",
    argsDoc: [
      ["targetId", "cmd.fire.arg.targetId"],
      ["weapon", "cmd.fire.arg.weaponIndex"],
    ],
    run: (s, a) => {
      expectArgs(L(s), a, 2, "fire <targetId> <weapon> [<weapon> ...]");
      const targetId = a[0]!;
      const weapons = a.slice(1).map((w) => int(L(s), w, "weapon"));
      const unit = currentActor(s);
      const battle = s.battle;
      if (!unit || !battle) {
        throw new Error(i18n(L(s), "err.wrongPhase", { phase: "weaponAttack" }));
      }
      const target = battle.units[targetId];
      if (!target) throw new Error(i18n(L(s), "err.unknownUnitId", { id: targetId }));
      const def = getMechDefFor(unit);
      const warnings: string[] = [];
      for (const weaponIndex of weapons) {
        const mount = def.weapons[weaponIndex];
        if (!mount) {
          throw new Error(
            i18n(L(s), "err.weaponIndex", { unit: unit.id, index: String(weaponIndex) }),
          );
        }
        const weapon = getWeaponDefFor(mount);
        const dist = hexDistance(unit.position, target.position);
        if (dist > weapon.long) {
          throw new Error(
            i18n(L(s), "err.overRange", {
              weapon: mount.weapon,
              dist: String(dist),
              max: String(weapon.long),
            }),
          );
        }
        if (weapon.minRange !== undefined && dist <= weapon.minRange) {
          warnings.push(
            i18n(L(s), "err.minRange", {
              weapon: mount.weapon,
              dist: String(dist),
              min: String(weapon.minRange),
              penalty: String(weapon.minRange - dist + 1),
            }),
          );
        }
        queueFire(s, { weaponIndex, targetId });
      }
      const lines = [
        i18n(L(s), "ok.fireQueuedBatch", {
          target: targetId,
          weapons: weapons.join(", "),
        }),
      ];
      return [...lines, ...warnings];
    },
  },
  status: { helpKey: "cmd.statusAttack.help", run: (s) => attackStatusLines(s) },
  cancel: {
    helpKey: "cmd.cancelFire.help",
    run: (s) => {
      cancelFire(s);
      return [i18n(s.locale, "ok.cancelled")];
    },
  },
  done: {
    helpKey: "cmd.doneFire.help",
    run: (s) => {
      return formatLog(s.locale, commitFire(s).events);
    },
  },
  ...BATTLE_CMDS,
};

// ----------------------------------------------------------------- over ----

const OVER_CMDS: Record<string, CmdDef> = {
  sheet: {
    helpKey: "cmd.sheetActing.help",
    usage: "sheet [id]",
    argsDoc: [["id", "cmd.sheetActing.arg.id"]],
    run: (s, a) => (a[0] !== undefined ? sheetForUnit(s, a[0]) : unitBriefList(s)),
  },
  status: { helpKey: "cmd.statusOver.help", run: (s) => overStatusLines(s) },
  rematch: {
    helpKey: "cmd.rematch.help",
    run: (s) => {
      const newEvents = rematch(s);
      return [
        buildLinesChunk([i18n(s.locale, "ok.rematchDone")], "banner"),
        buildLinesChunk(formatLog(s.locale, newEvents)),
      ];
    },
  },
};

// ------------------------------------------------------------ dispatch ----

function availableCmds(session: Session): Record<string, CmdDef> {
  switch (session.app) {
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
function commandHelp(session: Session, name: string): string[] {
  const locale = session.locale;
  const def = availableCmds(session)[name.toLowerCase()];
  if (!def) throw new Error(i18n(locale, "err.unknownCommand", { name }));
  const names = listMapNames().join("|");
  const lines = [
    def.usage !== undefined
      ? `${i18n(locale, "help.usagePrefix")}${def.usage}`
      : name.toLowerCase(),
  ];
  lines.push(i18n(locale, def.helpKey).replace(/\{names\}/g, names));
  if (def.argsDoc !== undefined && def.argsDoc.length > 0) {
    lines.push(i18n(locale, "help.argumentsHeader"));
    const padLen = Math.max(
      12,
      def.argsDoc.map(([arg, _]) => arg.length).reduce((prev, curr) => Math.max(prev, curr)),
    );

    for (const [arg, desc] of def.argsDoc) {
      const text = i18n(locale, desc).replace(/\{names\}/g, names);
      const [first = "", ...rest] = text.split("\n");
      const prefix = `  ${arg.padEnd(padLen)} `;
      lines.push(`${prefix}${first}`);
      const indent = " ".repeat(prefix.length);
      for (const line of rest) lines.push(`${indent}${line}`);
    }
  }
  return lines;
}

function commandList(session: Session): string[] {
  const locale = session.locale;
  const names = listMapNames().join("|");

  const globalEntries = Object.keys(GLOBAL_CMDS)
    .sort()
    .map((name) => ({ name, def: GLOBAL_CMDS[name]! }));

  const phaseCmds = (() => {
    switch (session.app) {
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
      const help = i18n(locale, def.helpKey).replace(/\{names\}/g, names);
      if (def.usage === undefined) {
        lines.push(`${name.padEnd(9)} ${help}`);
      } else {
        lines.push(`${name.padEnd(9)} ${def.usage}`);
        lines.push(`          ${help}`);
      }
    }
  };

  lines.push(i18n(locale, "help.sectionGeneral"));
  renderEntries(globalEntries);
  lines.push("");
  lines.push(i18n(locale, "help.sectionPhase", { phase: phaseCmds.phase }));
  renderEntries(phaseEntries);

  return lines;
}

// ---------------------------------------------------------------- hints ----

/** Per-state guidance shown at the top of `help`, focused on legal commands. */
/** Per-state guidance shown at the top of `help`, focused on legal commands. */
const HINT_SETUP: MessageKey = "hint.setup";
const HINT_MOVE: MessageKey = "hint.move";
const HINT_ATTACK: MessageKey = "hint.attack";
const HINT_OVER: MessageKey = "hint.over";

/** Per-state guidance, focused on the commands legal right now. */
function stateHint(s: Session): string[] {
  const key =
    s.app === "battle"
      ? s.battle?.phase === "weaponAttack"
        ? HINT_ATTACK
        : HINT_MOVE
      : s.app === "over"
        ? HINT_OVER
        : HINT_SETUP;
  return i18n(s.locale, key).split("\n");
}
function helpText(session: Session): string[] {
  return [...stateHint(session), "", ...commandList(session)];
}

function victoryBanner(s: Session): string[] {
  const victory = s.over?.victory ?? null;
  if (victory === null) return [];
  return victory.draw
    ? [i18n(s.locale, "banner.draw")]
    : [i18n(s.locale, "banner.win", { team: String(victory.winnerTeam) })];
}

function normalize(out: string[] | Chunk[]): Chunk[] {
  if (out.length === 0) return out as Chunk[];
  return typeof out[0] === "string" ? [buildLinesChunk(out as string[])] : (out as Chunk[]);
}

/**
 * Run one input line against the session; returns presentation chunks
 * (plain text with a class hint, or styled board spans).
 */
export function runChunks(session: Session, raw: string): Chunk[] {
  const wasOver = session.app === "over";
  let chunks: Chunk[];
  try {
    const tokens = raw
      .trim()
      .split(/\s+/)
      .filter((x) => x.length > 0);
    if (tokens.length === 0) return [];
    const def = availableCmds(session)[tokens[0]!.toLowerCase()];
    if (!def) throw new Error(i18n(session.locale, "err.unknownCommand", { name: tokens[0]! }));
    chunks = normalize(def.run(session, tokens.slice(1)));
  } catch (e) {
    return [
      buildLinesChunk(
        [`${i18n(session.locale, "err.prefix")} ${e instanceof Error ? e.message : String(e)}`],
        "err",
      ),
    ];
  }
  if (!wasOver && session.app === "over") {
    chunks.push(buildLinesChunk(victoryBanner(session), "banner"));
  }
  if (checkFireHint(session)) {
    const a = session.attack!;
    chunks.push(...fireSuggestionChunks(session.locale, a.fireCandidate!, a.torsoTwist));
  }
  return chunks;
}

function checkFireHint(s: Session): boolean {
  if (s.app !== "battle" || s.battle === null || s.battle.phase !== "weaponAttack") return false;
  const a = s.attack;
  if (a === null) return false;
  const actor = currentActor(s);
  if (actor === null) return false;
  const newKey = `${s.battle.turn}:${actor.id}:${a.torsoTwist}`;
  if (newKey !== a.fireHintShownFor || a.fireCandidate === null) {
    a.fireCandidate = suggestFireTargets(s.battle, actor.id, a.torsoTwist);
    a.fireHintShownFor = newKey;
    return true;
  }

  return false;
}
